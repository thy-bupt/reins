import { existsSync, readdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { hasRailguardHook } from "../adapters/claude/installer.js";
import { hasGeminiHook } from "../adapters/gemini/installer.js";
import { hasGrokHook } from "../adapters/grok/installer.js";
import { hasCodexHook, configTomlHasHooksEnabled } from "../adapters/codex/installer.js";
import { loadPolicy, PolicyError } from "../core/policy.js";
import { verifyTrace } from "../core/trace.js";

export interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface DoctorReport {
  healthy: boolean;
  checks: CheckResult[];
}

/** Paths of the non-claude agent configs. Passing them enables the per-agent
 *  checks; omitting keeps doctor hermetic (used by tests). */
export interface AgentPaths {
  gemini?: string;
  grok?: string;
  codexHooks?: string;
  codexConfig?: string;
  opencode?: string;
  pi?: string;
}

export interface DoctorOptions {
  home: string;
  settingsPath: string;
  /** verify the `railguard` binary resolves on PATH (skippable in tests) */
  checkPath?: boolean;
  agentPaths?: AgentPaths;
}

async function readTextIfExists(filePath: string | undefined): Promise<string | null> {
  if (!filePath || !existsSync(filePath)) return null;
  return readFile(filePath, "utf8");
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const checks: CheckResult[] = [];

  // 1. policy loads
  const policyPath = join(opts.home, "policy.yaml");
  if (!existsSync(policyPath)) {
    checks.push({
      name: "policy",
      status: "fail",
      detail: `no policy at ${policyPath} — run \`railguard init claude\``,
    });
  } else {
    try {
      const policy = loadPolicy(await readFile(policyPath, "utf8"));
      checks.push({
        name: "policy",
        status: "ok",
        detail: `${policy.rules.length} rules, default=${policy.default} (${policyPath})`,
      });
    } catch (err) {
      checks.push({
        name: "policy",
        status: "fail",
        detail: err instanceof PolicyError ? err.message : String(err),
      });
    }
  }

  // 2. agent hook installed (fail-open protection)
  if (!existsSync(opts.settingsPath)) {
    checks.push({
      name: "claude-hook",
      status: "fail",
      detail: `${opts.settingsPath} not found — the hook is NOT installed, so your agent runs fail-open`,
    });
  } else {
    try {
      const settings: unknown = JSON.parse(await readFile(opts.settingsPath, "utf8"));
      if (hasRailguardHook(settings)) {
        checks.push({ name: "claude-hook", status: "ok", detail: `installed in ${opts.settingsPath}` });
      } else {
        checks.push({
          name: "claude-hook",
          status: "fail",
          detail: `no railguard entry in ${opts.settingsPath} — agents run fail-open`,
        });
      }
    } catch (err) {
      checks.push({
        name: "claude-hook",
        status: "fail",
        detail: `${opts.settingsPath} is not valid JSON: ${String(err)}`,
      });
    }
  }

  // 3. other agent adapters (optional — warn, never fail, on absence)
  const agents = opts.agentPaths ?? {};
  const hint = (name: string) => `run \`railguard init ${name}\` to install`;

  const geminiSettings = await readTextIfExists(agents.gemini);
  if (geminiSettings !== null && hasGeminiHook(geminiSettings)) {
    checks.push({ name: "agent:gemini", status: "ok", detail: `installed (${agents.gemini})` });
  } else if (agents.gemini) {
    checks.push({ name: "agent:gemini", status: "warn", detail: `not installed — ${hint("gemini")}` });
  }

  const grokHooks = await readTextIfExists(agents.grok);
  if (grokHooks !== null && hasGrokHook(grokHooks)) {
    checks.push({ name: "agent:grok", status: "ok", detail: `installed (${agents.grok})` });
  } else if (agents.grok) {
    checks.push({ name: "agent:grok", status: "warn", detail: `not installed — ${hint("grok")}` });
  }

  const codexHooks = await readTextIfExists(agents.codexHooks);
  const codexConfig = await readTextIfExists(agents.codexConfig);
  if (agents.codexHooks || agents.codexConfig) {
    const hooksOk = codexHooks !== null && hasCodexHook(codexHooks);
    const featureOk = codexConfig !== null && configTomlHasHooksEnabled(codexConfig);
    if (hooksOk && featureOk) {
      checks.push({ name: "agent:codex", status: "ok", detail: `installed (${agents.codexHooks})` });
    } else if (!hooksOk) {
      checks.push({ name: "agent:codex", status: "warn", detail: `not installed — ${hint("codex")}` });
    } else {
      checks.push({
        name: "agent:codex",
        status: "warn",
        detail: "hooks.json present but the `[features] hooks = true` feature flag is missing in config.toml — hooks will not run",
      });
    }
  }

  if (agents.opencode) {
    const plugin = await readTextIfExists(agents.opencode);
    if (plugin !== null && plugin.includes("tool.execute.before")) {
      checks.push({ name: "agent:opencode", status: "ok", detail: `installed (${agents.opencode})` });
    } else {
      checks.push({ name: "agent:opencode", status: "warn", detail: `not installed — ${hint("opencode")}` });
    }
  }

  if (agents.pi) {
    const ext = await readTextIfExists(agents.pi);
    if (ext !== null && ext.includes("tool_call")) {
      checks.push({ name: "agent:pi", status: "ok", detail: `installed (${agents.pi})` });
    } else {
      checks.push({ name: "agent:pi", status: "warn", detail: `not installed — ${hint("pi")}` });
    }
  }

  // 4. sessions dir
  const sessionsDir = join(opts.home, "sessions");
  if (existsSync(sessionsDir)) {
    const count = (await readdir(sessionsDir)).filter((f) => f.endsWith(".jsonl")).length;
    checks.push({ name: "sessions", status: "ok", detail: `${count} session(s) in ${sessionsDir}` });
  } else {
    checks.push({ name: "sessions", status: "ok", detail: "no sessions yet (created on first use)" });
  }

  // 5. trace integrity
  if (existsSync(sessionsDir)) {
    const files = (await readdir(sessionsDir)).filter((f) => f.endsWith(".jsonl"));
    const broken: string[] = [];
    for (const f of files) {
      const filePath = join(sessionsDir, f);
      const result = await verifyTrace(filePath);
      if (!result.ok) broken.push(`${f}: ${result.reason ?? "integrity failure"} at event ${result.brokenAt}`);
    }
    if (broken.length === 0) {
      checks.push({ name: "traces", status: "ok", detail: `${files.length} trace(s) verified, hash chains intact` });
    } else {
      checks.push({
        name: "traces",
        status: "fail",
        detail: `${broken.length} tampered/corrupt trace(s): ${broken.join("; ")}`,
      });
    }
  } else {
    checks.push({ name: "traces", status: "ok", detail: "nothing to verify yet" });
  }

  // 6. binary on PATH
  if (opts.checkPath !== false) {
    const probe = spawnSync("railguard", ["--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) {
      checks.push({
        name: "binary",
        status: "warn",
        detail: "`railguard` not found on PATH — the hook command will fail; install with `npm i -g railguard`",
      });
    } else {
      checks.push({ name: "binary", status: "ok", detail: `railguard ${(probe.stdout ?? "").trim()}` });
    }
  }

  return { healthy: !checks.some((c) => c.status === "fail"), checks };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = report.checks.map((c) => {
    const icon = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗";
    return ` ${icon} ${c.name.padEnd(12)} ${c.detail}`;
  });
  lines.push("");
  lines.push(report.healthy ? "railguard looks healthy." : "issues found — see ✗ items above.");
  return lines.join("\n");
}

export function sessionFiles(home: string): string[] {
  const dir = join(home, "sessions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
}
