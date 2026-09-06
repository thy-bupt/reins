import { existsSync, readdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { hasRailguardHook } from "../adapters/claude/installer.js";
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

export interface DoctorOptions {
  home: string;
  settingsPath: string;
  /** verify the `railguard` binary resolves on PATH (skippable in tests) */
  checkPath?: boolean;
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

  // 3. sessions dir
  const sessionsDir = join(opts.home, "sessions");
  if (existsSync(sessionsDir)) {
    const count = (await readdir(sessionsDir)).filter((f) => f.endsWith(".jsonl")).length;
    checks.push({ name: "sessions", status: "ok", detail: `${count} session(s) in ${sessionsDir}` });
  } else {
    checks.push({ name: "sessions", status: "ok", detail: "no sessions yet (created on first use)" });
  }

  // 4. trace integrity
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

  // 5. binary on PATH
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
