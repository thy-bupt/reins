#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { copyFile, chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Command } from "commander";
import { handlePreToolUse as handleClaude } from "../adapters/claude/hook.js";
import { mergeSettings as mergeClaudeSettings, REINS_HOOK_COMMAND } from "../adapters/claude/installer.js";
import { handleBeforeTool as handleGemini } from "../adapters/gemini/hook.js";
import { mergeGeminiSettings, GEMINI_HOOK_COMMAND } from "../adapters/gemini/installer.js";
import { handlePreToolUse as handleGrok } from "../adapters/grok/hook.js";
import { grokHooksFileContent, GROK_HOOK_COMMAND } from "../adapters/grok/installer.js";
import { handlePreToolUse as handleCodex } from "../adapters/codex/hook.js";
import { codexHooksFileContent, ensureHooksFeature, CODEX_HOOK_COMMAND } from "../adapters/codex/installer.js";
import { handleToolExecute as handleOpenCode } from "../adapters/opencode/hook.js";
import { opencodePluginSource, OPENCODE_PLUGIN_COMMAND } from "../adapters/opencode/installer.js";
import { handleToolCall as handlePi } from "../adapters/pi/hook.js";
import { piExtensionSource, PI_EXTENSION_COMMAND } from "../adapters/pi/installer.js";
import {
  isGeneratedByReins,
  removeHooksEntry,
  sessionIdFrom,
  sanitizeSessionId,
} from "../adapters/common.js";
import { runMcpServer } from "../mcp/server.js";
import { SKILL_NAMES, installSkill, uninstallSkill } from "../skills/installer.js";
import { loadLlmConfig } from "../llm/config.js";
import { runSuggestPipeline } from "../llm/suggest.js";
import { runExplain, buildLlmSnapshot } from "../llm/explain.js";
import { runUi } from "../tui/ui.js";
import { formatTraceShow } from "./show.js";
import { formatDoctorReport, runDoctor, type DoctorOptions } from "./doctor.js";
import { formatReplayReport, replaySession } from "./replay.js";
import { buildSnapshotMarkdown, collectGitContext, deriveAgentAndSession, policySha256, type SnapshotData } from "./snapshot.js";
import { buildEvidenceRecords, toJsonDocument, toNdjson } from "./export.js";
import { stringify as yamlStringify } from "yaml";
import {
  BUNDLED_POLICY_PATH,
  reinsHome,
  resolvePolicyPath,
  sessionsDir,
  userPolicyPath,
} from "../core/home.js";
import { decide } from "../core/decider.js";
import { loadPolicy, PolicyError } from "../core/policy.js";
import { runGuarded } from "../core/runner.js";
import { ensureSecureLedgerDirs, readTrace, TraceWriter, verifyTrace } from "../core/trace.js";

const require = createRequire(import.meta.url);
const VERSION: string = require("../../package.json").version;

const HOOK_ADAPTERS = {
  claude: handleClaude,
  gemini: handleGemini,
  grok: handleGrok,
  codex: handleCodex,
  opencode: handleOpenCode,
  pi: handlePi,
} as const;

type HookAdapterName = keyof typeof HOOK_ADAPTERS;
const HOOK_ADAPTER_NAMES = Object.keys(HOOK_ADAPTERS) as HookAdapterName[];

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  // preserve the original file's permission bits — a 0600 settings file must
  // not silently become 0640/0644 after an init round-trip
  const mode = existsSync(filePath) ? (await stat(filePath)).mode & 0o777 : 0o600;
  const tmp = `${filePath}.reins-tmp-${process.pid}`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tmp, content, { encoding: "utf8", mode });
  await rename(tmp, filePath);
}

async function backupOnce(filePath: string): Promise<void> {
  const backup = `${filePath}.reins-backup`;
  if (existsSync(filePath) && !existsSync(backup)) {
    await copyFile(filePath, backup);
    await chmod(backup, (await stat(filePath)).mode & 0o777);
  }
}

async function failClosed(message: string): Promise<never> {
  process.stderr.write(`[reins] ${message}\n`);
  process.exit(2);
}

async function newestSessionFile(): Promise<string | null> {
  if (!existsSync(sessionsDir())) return null;
  const files = (await readdir(sessionsDir())).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) return null;
  const withTimes = await Promise.all(
    files.map(async (f) => ({ f, m: (await stat(join(sessionsDir(), f))).mtimeMs })),
  );
  withTimes.sort((a, b) => b.m - a.m);
  return join(sessionsDir(), withTimes[0]!.f);
}

async function readJsonFile(filePath: string): Promise<unknown> {
  if (!existsSync(filePath)) return {};
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw || "{}");
}

const program = new Command();
program
  .name("reins")
  .description(
    "Verifiable execution evidence layer for AI coding agents: deterministic policy gate, tamper-evident ledger, replay, forensics.",
  )
  .version(VERSION);

// bare `reins` in a real terminal opens the interactive browser
if (process.argv.length <= 2 && process.stdout.isTTY && !process.env["NO_COLOR"]) {
  await runUi({ sessionsDir: sessionsDir(), policyPath: resolvePolicyPath(), version: VERSION });
  process.exit(0);
}

program
  .command("ui")
  .description("interactive session browser (colored timelines, event drill-in)")
  .action(async () => {
    await runUi({ sessionsDir: sessionsDir(), policyPath: resolvePolicyPath(), version: VERSION });
  });

program
  .command("init")
  .description(`install reins for a coding agent (${HOOK_ADAPTER_NAMES.join(", ")}) or component (skills, mcp)`)
  .argument("[adapter]", `target: ${HOOK_ADAPTER_NAMES.join(" | ")} | skills | mcp`)
  .option("--policy <path>", "policy file to install as your default")
  .option(
    "--settings <path>",
    "agent settings/config file override (where applicable)",
  )
  .action(async (adapter: string | undefined, opts: { policy?: string; settings?: string }) => {
    if (!adapter) {
      console.log(`usage: reins init <target>\ntargets: ${HOOK_ADAPTER_NAMES.join(", ")}, skills, mcp\nexample: reins init claude`);
      process.exit(1);
    }
    const isHookAdapter = adapter in HOOK_ADAPTERS;
    if (!isHookAdapter && adapter !== "skills" && adapter !== "mcp") {
      return failClosed(`unknown adapter "${adapter}" (supported: ${HOOK_ADAPTER_NAMES.join(", ")}, skills, mcp)`);
    }
    await ensureSecureLedgerDirs(reinsHome(), sessionsDir());

    const policyDest = userPolicyPath();
    const policySource = opts.policy ?? BUNDLED_POLICY_PATH;
    if (!existsSync(policyDest)) {
      await mkdir(dirname(policyDest), { recursive: true, mode: 0o700 });
      await copyFile(policySource, policyDest);
      // the policy is part of the security posture — keep it private
      await chmod(policyDest, 0o600);
      console.log(`policy installed: ${policyDest}`);
    } else {
      console.log(`policy already present, leaving untouched: ${policyDest}`);
    }

    if (adapter === "skills") {
      const targetBase = opts.settings ?? join(homedir(), ".claude", "skills");
      for (const name of SKILL_NAMES) {
        const r = await installSkill(name, targetBase);
        console.log(r.changed ? `skill installed: ${r.path}` : `skill already present: ${r.path}`);
      }
      console.log("\nrules of engagement: skills are advisory — enforcement still lives in the hooks");
      return;
    }

    if (adapter === "mcp") {
      const cfgPath = opts.settings ?? join(homedir(), ".claude.json");
      let parsed: unknown;
      try {
        parsed = JSON.parse(existsSync(cfgPath) ? (await readFile(cfgPath, "utf8")) || "{}" : "{}");
      } catch {
        return failClosed(`${cfgPath} is not valid JSON — not touching it`);
      }
      const obj = parsed as Record<string, unknown>;
      const servers = (typeof obj["mcpServers"] === "object" && obj["mcpServers"] !== null
        ? (obj["mcpServers"] as Record<string, unknown>)
        : {}) as Record<string, unknown>;
      const entry = { type: "stdio", command: "reins", args: ["mcp"] };
      if (JSON.stringify(servers["reins"]) === JSON.stringify(entry)) {
        console.log(`mcp server already registered in ${cfgPath}`);
        return;
      }
      if ("reins" in servers) {
        // a "reins" key exists but with different config — could be the
        // user's own server; never overwrite silently
        return failClosed(
          `${cfgPath} already has an "mcpServers.reins" entry with different config — refusing to overwrite. Rename it or edit it yourself.`,
        );
      }
      servers["reins"] = entry;
      obj["mcpServers"] = servers;
      await backupOnce(cfgPath);
      await atomicWrite(cfgPath, JSON.stringify(obj, null, 2) + "\n");
      console.log(`mcp server registered in ${cfgPath} (restart Claude Code to load)`);
      return;
    }

    switch (adapter as HookAdapterName) {
      case "claude": {
        const settingsPath = opts.settings ?? join(homedir(), ".claude", "settings.json");
        let parsed: unknown;
        try {
          parsed = await readJsonFile(settingsPath);
        } catch {
          return failClosed(`${settingsPath} is not valid JSON — not touching it`);
        }
        const { settings, changed } = mergeClaudeSettings(parsed);
        if (changed) {
          await backupOnce(settingsPath);
          await atomicWrite(settingsPath, JSON.stringify(settings, null, 2) + "\n");
          console.log(`hook installed in ${settingsPath} (backup written alongside)`);
        } else {
          console.log(`hook already installed in ${settingsPath}`);
        }
        break;
      }

      case "gemini": {
        const settingsPath = opts.settings ?? join(homedir(), ".gemini", "settings.json");
        let parsed: unknown;
        try {
          parsed = await readJsonFile(settingsPath);
        } catch {
          return failClosed(`${settingsPath} is not valid JSON — not touching it`);
        }
        const { settings, changed } = mergeGeminiSettings(parsed);
        if (changed) {
          await backupOnce(settingsPath);
          await atomicWrite(settingsPath, JSON.stringify(settings, null, 2) + "\n");
          console.log(`hook installed in ${settingsPath} (backup written alongside)`);
        } else {
          console.log(`hook already installed in ${settingsPath}`);
        }
        break;
      }

      case "grok": {
        const hooksPath = opts.settings ?? join(homedir(), ".grok", "hooks", "reins.json");
        const existing = existsSync(hooksPath) ? await readFile(hooksPath, "utf8") : null;
        const content = grokHooksFileContent(existing);
        if (existing !== null && content === existing) {
          console.log(`hook already installed in ${hooksPath}`);
          break;
        }
        await backupOnce(hooksPath);
        await atomicWrite(hooksPath, content);
        console.log(`hook installed in ${hooksPath}`);
        break;
      }

      case "codex": {
        // config.toml lives next to hooks.json (both in CODEX_HOME); deriving
        // it from the hooks path keeps --settings overrides self-contained
        const hooksPath = opts.settings ?? join(homedir(), ".codex", "hooks.json");
        const configPath = join(dirname(hooksPath), "config.toml");
        const existingHooks = existsSync(hooksPath) ? await readFile(hooksPath, "utf8") : null;
        const hooksContent = codexHooksFileContent(existingHooks);
        if (existingHooks === null || hooksContent !== existingHooks) {
          await backupOnce(hooksPath);
          await atomicWrite(hooksPath, hooksContent);
          console.log(`hook installed in ${hooksPath}`);
        } else {
          console.log(`hook already installed in ${hooksPath}`);
        }

        const configToml = existsSync(configPath) ? await readFile(configPath, "utf8") : null;
        const { content, changed } = ensureHooksFeature(configToml);
        if (changed) {
          await backupOnce(configPath);
          await atomicWrite(configPath, content);
          console.log(`feature enabled in ${configPath} ([features] hooks = true)`);
        } else {
          console.log(`feature already enabled in ${configPath}`);
        }
        break;
      }

      case "opencode": {
        const pluginPath =
          opts.settings ?? join(homedir(), ".config", "opencode", "plugins", "reins.js");
        if (existsSync(pluginPath)) {
          const existing = await readFile(pluginPath, "utf8");
          if (!isGeneratedByReins(existing, OPENCODE_PLUGIN_COMMAND)) {
            return failClosed(
              `${pluginPath} exists and was not generated by reins — refusing to overwrite. Remove it yourself or pass --settings to pick another path.`,
            );
          }
        }
        await atomicWrite(pluginPath, opencodePluginSource());
        console.log(`plugin installed in ${pluginPath}`);
        break;
      }

      case "pi": {
        const extPath = opts.settings ?? join(homedir(), ".pi", "agent", "extensions", "reins.ts");
        if (existsSync(extPath)) {
          const existing = await readFile(extPath, "utf8");
          if (!isGeneratedByReins(existing, PI_EXTENSION_COMMAND)) {
            return failClosed(
              `${extPath} exists and was not generated by reins — refusing to overwrite. Remove it yourself or pass --settings to pick another path.`,
            );
          }
        }
        await atomicWrite(extPath, piExtensionSource());
        console.log(`extension installed in ${extPath}`);
        break;
      }
    }

    console.log("\nreins is live. Restart your agent session (or run /hooks) to load the hook.");
    console.log("Try: reins trace list · reins policy eval \"npm test\" · reins doctor");
  });

program
  .command("hook")
  .description(`agent hook entrypoint (${HOOK_ADAPTER_NAMES.join(", ")})`)
  .argument("<adapter>", `agent adapter: ${HOOK_ADAPTER_NAMES.join(" | ")}`)
  .option("--policy <path>", "policy file override")
  .action(async (adapter: string, opts: { policy?: string }) => {
    const handler = HOOK_ADAPTERS[adapter as HookAdapterName];
    if (!handler) {
      return failClosed(`unknown adapter "${adapter}" (supported: ${HOOK_ADAPTER_NAMES.join(", ")})`);
    }
    let raw: string;
    try {
      raw = await readAllStdin();
    } catch (err) {
      return failClosed(`could not read hook payload: ${String(err)} — blocking (fail-closed)`);
    }

    try {
      const payload: unknown = raw.trim() === "" ? null : JSON.parse(raw);
      const policyPath = resolvePolicyPath(opts.policy);
      const policyText = readFileSync(policyPath, "utf8");
      const policy = loadPolicy(policyText);
      const policyDigest = policySha256(policyText);
      // sessionIdFrom understands snake_case and camelCase payloads;
      // sanitizeSessionId keeps the ledger path inside sessions/
      const sessionId = sanitizeSessionId(adapter, sessionIdFrom(payload, adapter));
      await ensureSecureLedgerDirs(reinsHome(), sessionsDir());
      const trace = await TraceWriter.open(join(sessionsDir(), `${adapter}-${sessionId}.jsonl`));
      const outcome = await handler(payload, { policy, trace, policyDigest });
      if (outcome.stdout) process.stdout.write(outcome.stdout);
      if (outcome.stderr) process.stderr.write(outcome.stderr + "\n");
      process.exit(outcome.exitCode);
    } catch (err) {
      const detail = err instanceof PolicyError ? err.message : String(err);
      return failClosed(`internal error: ${detail} — blocking (fail-closed)`);
    }
  });

program
  .command("exec")
  .description("run a shell command under the policy (works with any agent or script)")
  .argument("<command...>", "command to run (pass after -- if it starts with a dash)")
  .option("--policy <path>", "policy file override")
  .option("--cwd <dir>", "working directory for the command")
  .action(async (commandParts: string[], opts: { policy?: string; cwd?: string }) => {
    const command = commandParts.join(" ");
    const policyPath = resolvePolicyPath(opts.policy);
    const policyText = readFileSync(policyPath, "utf8");
    const policy = loadPolicy(policyText);
    await ensureSecureLedgerDirs(reinsHome(), sessionsDir());
    const trace = await TraceWriter.start(sessionsDir());
    const decision = decide(policy, { tool: "exec", input: { command } });
    const result = await runGuarded({
      command,
      trace,
      cwd: opts.cwd,
      decision,
      policyDigest: policySha256(policyText),
    });
    if (result.blocked) {
      process.stderr.write(
        `[reins] blocked by rule "${decision.matchedRule ?? "default"}": ${decision.reason ?? "policy denied this action"}\n`,
      );
    }
    process.exit(result.exitCode);
  });

const trace = program.command("trace").description("inspect session traces");

trace
  .command("list")
  .description("list session trace files (newest first)")
  .action(async () => {
    const newest = await newestSessionFile();
    if (!newest) {
      console.log("no sessions yet");
      return;
    }
    const files = (await readdir(sessionsDir())).filter((f) => f.endsWith(".jsonl"));
    const withTimes = await Promise.all(
      files.map(async (f) => ({ f, m: (await stat(join(sessionsDir(), f))).mtimeMs })),
    );
    withTimes.sort((a, b) => b.m - a.m);
    for (const { f } of withTimes) console.log(join(sessionsDir(), f));
  });

trace
  .command("verify")
  .description("verify the hash chain of a session trace")
  .argument("[file]", "trace file (default: newest session)")
  .action(async (file?: string) => {
    const target = file ?? (await newestSessionFile());
    if (!target) return failClosed("no session traces found");
    const events = await readTrace(target);
    const result = await verifyTrace(target);
    if (result.ok) {
      console.log(`ok: ${events.length} events, hash chain intact — ${target}`);
    } else {
      console.error(
        `TAMPERED: ${result.reason ?? "integrity failure"} at event ${result.brokenAt} — ${target}`,
      );
      process.exit(1);
    }
  });

program
  .command("doctor")
  .description("check that the rail is installed, intact, and tamper-free")
  .option("--home <dir>", "reins home", reinsHome())
  .option("--settings <path>", "Claude Code settings file", join(homedir(), ".claude", "settings.json"))
  .option("--agent <name>", "treat this adapter as the primary one (claude, gemini, grok, codex, opencode, pi)")
  .option("--all", "check every adapter; absence is reported but never fails")
  .option("--no-path-check", "skip checking whether reins is on PATH")
  .action(async (opts: { home: string; settings: string; pathCheck: boolean; agent?: string; all?: boolean }) => {
    const report = await runDoctor({
      home: opts.home,
      settingsPath: opts.settings,
      checkPath: opts.pathCheck,
      primaryAgent: opts.agent as DoctorOptions["primaryAgent"],
      all: opts.all,
      projectDir: process.cwd(),
      agentPaths: {
        gemini: join(homedir(), ".gemini", "settings.json"),
        grok: join(homedir(), ".grok", "hooks", "reins.json"),
        codexHooks: join(homedir(), ".codex", "hooks.json"),
        codexConfig: join(homedir(), ".codex", "config.toml"),
        opencode: join(homedir(), ".config", "opencode", "plugins", "reins.js"),
        pi: join(homedir(), ".pi", "agent", "extensions", "reins.ts"),
      },
    });
    console.log(formatDoctorReport(report));
    if (!report.healthy) process.exit(1);
  });

program
  .command("replay")
  .description("re-evaluate a recorded session under a (new) policy — nothing is executed")
  .argument("[file]", "trace file (default: newest session)")
  .option("--policy <path>", "candidate policy (default: your installed policy)")
  .option("--strict", "exit 1 if any event would be blocked", false)
  .action(async (file: string | undefined, opts: { policy?: string; strict: boolean }) => {
    const target = file ?? (await newestSessionFile());
    if (!target) return failClosed("no session traces found");
    const integrity = await verifyTrace(target);
    if (!integrity.ok) {
      return failClosed(`refusing to replay a tampered trace (${integrity.reason ?? "?"} at ${integrity.brokenAt})`);
    }
    const events = await readTrace(target);
    const policy = loadPolicy(readFileSync(resolvePolicyPath(opts.policy), "utf8"));
    const report = replaySession(events, policy);
    console.log(formatReplayReport(report));
    if (opts.strict && report.wouldBlock.length > 0) process.exit(1);
  });

program
  .command("snapshot")
  .description("emit a forensic operation-snapshot report (markdown) for a session — works even on tampered traces")
  .argument("[file]", "trace file (default: newest session)")
  .option("--policy <path>", "policy file to fingerprint (default: your installed policy)")
  .option("--out <path>", "output markdown path")
  .option("--with-diffs", "include current `git diff HEAD` for touched files", false)
  .action(async (file: string | undefined, opts: { policy?: string; out?: string; withDiffs: boolean }) => {
    const target = file ?? (await newestSessionFile());
    if (!target) return failClosed("no session traces found");
    const events = await readTrace(target);
    const integrity = await verifyTrace(target);
    const policyText = readFileSync(resolvePolicyPath(opts.policy), "utf8");
    const policy = loadPolicy(policyText);

    const { agent, sessionId } = deriveAgentAndSession(target);
    const filePaths = events
      .map((e) => (typeof e.input === "object" && e.input !== null ? (e.input as Record<string, unknown>)["file_path"] : undefined))
      .filter((p): p is string => typeof p === "string" && p.trim() !== "");
    const git = await collectGitContext(filePaths, opts.withDiffs);

    const data: SnapshotData = {
      sourceFile: target,
      agent,
      sessionId,
      eventCount: events.length,
      timeRange: { first: events[0]?.ts, last: events[events.length - 1]?.ts },
      integrity,
      policy: {
        name: policy.name,
        rules: policy.rules.length,
        sha256: policySha256(policyText),
        source: resolvePolicyPath(opts.policy),
      },
      git,
      denied: events.filter((e) => e.decision === "deny"),
      allowed: events.filter((e) => e.decision !== "deny"),
      fileWrites: events.filter((e) => typeof (e.input as Record<string, unknown>)?.["file_path"] === "string"),
      generatedAt: new Date().toISOString(),
    };
    const md = buildSnapshotMarkdown(data);
    const out = opts.out ?? `reins-snapshot-${agent}-${sessionId.replace(/[:.]/g, "-").slice(0, 40)}.md`;
    await mkdir(dirname(out), { recursive: true });
    // snapshot reports contain command text — owner-only, like the ledger
    await writeFile(out, md, { encoding: "utf8", mode: 0o600 });
    console.log(`snapshot written: ${out}`);
    console.log(
      `events: ${events.length}, chain: ${integrity.ok ? "OK" : `TAMPERED (${integrity.reason} at event ${integrity.brokenAt})`}` +
        `${git ? `, git: ${git.repoRoot}` : ", git: none"}`,
    );
  });

trace
  .command("show")
  .description("render a session ledger as a human-readable timeline")
  .argument("[file]", "trace file (default: newest session)")
  .action(async (file?: string) => {
    const target = file ?? (await newestSessionFile());
    if (!target) return failClosed("no session traces found");
    const events = await readTrace(target);
    const integrity = await verifyTrace(target);
    console.log(
      formatTraceShow(events, {
        source: target,
        ok: integrity.ok,
        reason: integrity.reason,
        brokenAt: integrity.brokenAt,
      }),
    );
  });

program
  .command("uninstall")
  .description(`remove the reins hook for an agent (${HOOK_ADAPTER_NAMES.join(", ")}) or component (skills, mcp)`)
  .argument("[adapter]", `target: ${HOOK_ADAPTER_NAMES.join(" | ")} | skills | mcp`)
  .option("--settings <path>", "agent settings/config file override (where applicable)")
  .action(async (adapter: string | undefined, opts: { settings?: string }) => {
    if (!adapter) {
      console.log(`usage: reins uninstall <target>\ntargets: ${HOOK_ADAPTER_NAMES.join(", ")}, skills, mcp`);
      process.exit(1);
    }
    const isHookAdapter = adapter in HOOK_ADAPTERS;
    if (!isHookAdapter && adapter !== "skills" && adapter !== "mcp") {
      return failClosed(`unknown adapter "${adapter}" (supported: ${HOOK_ADAPTER_NAMES.join(", ")}, skills, mcp)`);
    }
    if (adapter === "skills") {
      const targetBase = opts.settings ?? join(homedir(), ".claude", "skills");
      for (const name of SKILL_NAMES) {
        const r = await uninstallSkill(name, targetBase);
        console.log(r.removed ? `skill removed: ${name}` : `${name}: ${r.reason ?? "not installed"}`);
      }
      return;
    }
    if (adapter === "mcp") {
      const cfgPath = opts.settings ?? join(homedir(), ".claude.json");
      if (!existsSync(cfgPath)) return console.log("not installed (config missing)");
      let parsed: unknown;
      try {
        parsed = JSON.parse((await readFile(cfgPath, "utf8")) || "{}");
      } catch {
        return failClosed(`${cfgPath} is not valid JSON — not touching it`);
      }
      const obj = parsed as Record<string, unknown>;
      const servers = (typeof obj["mcpServers"] === "object" && obj["mcpServers"] !== null
        ? (obj["mcpServers"] as Record<string, unknown>)
        : {}) as Record<string, unknown>;
      const ourEntry = { type: "stdio", command: "reins", args: ["mcp"] };
      if (!("reins" in servers)) return console.log(`not installed in ${cfgPath}`);
      if (JSON.stringify(servers["reins"]) !== JSON.stringify(ourEntry)) {
        console.log(`the "reins" entry in ${cfgPath} was not created by reins (config differs) — leaving it alone`);
        return;
      }
      delete servers["reins"];
      obj["mcpServers"] = servers;
      await atomicWrite(cfgPath, JSON.stringify(obj, null, 2) + "\n");
      console.log(`mcp server removed from ${cfgPath}`);
      return;
    }

    const removeFromFile = async (filePath: string, event: string, command: string, kind: string) => {
      if (!existsSync(filePath)) return console.log(`not installed (${kind} config missing)`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(filePath, "utf8") || "{}");
      } catch {
        return failClosed(`${filePath} is not valid JSON — not touching it`);
      }
      const { settings, changed } = removeHooksEntry(parsed, { event, command });
      if (!changed) return console.log(`not installed in ${filePath}`);
      const hooks = settings["hooks"] as Record<string, unknown>;
      const allEmpty = Object.values(hooks).every((v) => Array.isArray(v) && v.length === 0);
      if (allEmpty && kind !== "settings") {
        await rm(filePath);
        console.log(`removed ${filePath} (no hook entries left)`);
      } else {
        await atomicWrite(filePath, JSON.stringify(settings, null, 2) + "\n");
        console.log(`hook removed from ${filePath}`);
      }
    };

    switch (adapter as HookAdapterName) {
      case "claude": {
        const settingsPath = opts.settings ?? join(homedir(), ".claude", "settings.json");
        await removeFromFile(settingsPath, "PreToolUse", REINS_HOOK_COMMAND, "settings");
        break;
      }
      case "gemini": {
        const settingsPath = opts.settings ?? join(homedir(), ".gemini", "settings.json");
        await removeFromFile(settingsPath, "BeforeTool", GEMINI_HOOK_COMMAND, "settings");
        break;
      }
      case "grok": {
        const hooksPath = opts.settings ?? join(homedir(), ".grok", "hooks", "reins.json");
        await removeFromFile(hooksPath, "PreToolUse", GROK_HOOK_COMMAND, "hooks-file");
        break;
      }
      case "codex": {
        const hooksPath = opts.settings ?? join(homedir(), ".codex", "hooks.json");
        await removeFromFile(hooksPath, "PreToolUse", CODEX_HOOK_COMMAND, "hooks-file");
        console.log("note: `[features] hooks = true` in config.toml left untouched (other hooks may use it)");
        break;
      }
      case "opencode": {
        const pluginPath = opts.settings ?? join(homedir(), ".config", "opencode", "plugins", "reins.js");
        if (!existsSync(pluginPath)) return console.log(`not installed (${pluginPath} missing)`);
        const content = await readFile(pluginPath, "utf8");
        if (!isGeneratedByReins(content, OPENCODE_PLUGIN_COMMAND)) {
          console.log(`${pluginPath} is not a reins-generated file — leaving it alone`);
          break;
        }
        await rm(pluginPath);
        console.log(`removed ${pluginPath}`);
        break;
      }
      case "pi": {
        const extPath = opts.settings ?? join(homedir(), ".pi", "agent", "extensions", "reins.ts");
        if (!existsSync(extPath)) return console.log(`not installed (${extPath} missing)`);
        const content = await readFile(extPath, "utf8");
        if (!isGeneratedByReins(content, PI_EXTENSION_COMMAND)) {
          console.log(`${extPath} is not a reins-generated file — leaving it alone`);
          break;
        }
        await rm(extPath);
        console.log(`removed ${extPath}`);
        break;
      }
    }
  });

const policy = program.command("policy").description("inspect policies without executing anything");

policy
  .command("eval")
  .description("evaluate a command or file path against the policy — nothing is executed")
  .argument("[command...]", "command to evaluate (or ignored when --file is given)")
  .option("--tool <name>", "tool name to evaluate as", "Bash")
  .option("--file <path>", "evaluate a file path against path rules instead")
  .option("--policy <path>", "policy file override")
  .action(async (commandParts: string[], opts: { tool: string; file?: string; policy?: string }) => {
    if (!opts.file && commandParts.length === 0) {
      return failClosed("nothing to evaluate: pass a command or use --file <path>");
    }
    const p = loadPolicy(readFileSync(resolvePolicyPath(opts.policy), "utf8"));
    const input: Record<string, unknown> = opts.file
      ? { file_path: opts.file }
      : { command: commandParts.join(" ") };
    const result = decide(p, { tool: opts.tool, input });
    console.log(`decision: ${result.decision}${result.matchedRule ? ` — rule "${result.matchedRule}"` : " (policy default)"}`);
    console.log(`reason: ${result.reason ?? "—"}`);
    console.log(`${opts.file ? "path" : "command"}: ${opts.file ?? commandParts.join(" ")}`);
    process.exit(result.decision === "allow" ? 0 : 2);
  });

program
  .command("mcp")
  .description("run the read-only reins MCP server (stdio) — enforcement never lives here")
  .action(async () => {
    await runMcpServer();
  });

trace
  .command("export")
  .description("export a session ledger as schema-v1 evidence (ndjson or json)")
  .argument("[file]", "trace file (default: newest session)")
  .option("--format <fmt>", "output format: ndjson | json", "ndjson")
  .option("--out <path>", "output file (default: stdout)")
  .option("--no-redact", "export raw commands instead of secret-redacted ones")
  .action(async (file: string | undefined, opts: { format: string; out?: string; redact: boolean }) => {
    if (opts.format !== "ndjson" && opts.format !== "json") {
      return failClosed(`unsupported --format "${opts.format}" (use ndjson or json)`);
    }
    const target = file ?? (await newestSessionFile());
    if (!target) return failClosed("no session traces found");
    const integrity = await verifyTrace(target);
    const events = await readTrace(target);
    const { agent, sessionId } = deriveAgentAndSession(target);
    const meta = {
      sourceFile: target,
      agent,
      sessionId,
      integrity,
      generatedBy: `reins/${VERSION}`,
      redact: opts.redact,
    };
    const records = buildEvidenceRecords(events, meta);
    const payload =
      opts.format === "json" ? toJsonDocument(records, meta) : toNdjson(records);
    if (opts.out) {
      // evidence exports contain command text — keep them owner-only
      await mkdir(dirname(opts.out), { recursive: true });
      await writeFile(opts.out, payload, { encoding: "utf8", mode: 0o600 });
      console.log(`evidence exported: ${opts.out} (${records.length} events, ${payload.length} bytes)`);
    } else {
      process.stdout.write(payload);
    }
    if (!integrity.ok) process.exitCode = 1;
  });

program
  .command("suggest")
  .description("optional LLM: propose policy rules from recent ledger patterns — nothing applies without --apply")
  .option("--session <file>", "analyze a specific session (default: newest 3)")
  .option("--last <n>", "sessions to analyze", "3")
  .option("--apply", "merge accepted rules into your policy (backs up first)", false)
  .option("--policy <path>", "policy file override")
  .option("--out <path>", "write the proposal report to a file")
  .action(async (opts: { session?: string; last: string; apply: boolean; policy?: string; out?: string }) => {
    const cfg = loadLlmConfig();
    if (cfg.provider === "none") {
      process.stderr.write(
        "[reins] LLM is not configured — add an `llm:` section to ~/.reins/config.yaml (see docs/LLM.md). This is optional; reins works fully without it.\n",
      );
      process.exit(1);
    }
    const policyPath = resolvePolicyPath(opts.policy);
    const policyText = readFileSync(policyPath, "utf8");
    const policy = loadPolicy(policyText);

    // resolve the analysis set: an explicit --session, or the newest N ledgers
    let sessionFiles: string[];
    if (opts.session) {
      if (!existsSync(opts.session)) {
        return failClosed(`session file not found: ${opts.session}`);
      }
      sessionFiles = [opts.session];
    } else {
      const limit = Math.max(1, Number(opts.last) || 3);
      sessionFiles = existsSync(sessionsDir())
        ? readdirSync(sessionsDir())
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => join(sessionsDir(), f))
            .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
            .slice(0, limit)
        : [];
    }
    const { verdicts } = await runSuggestPipeline(cfg, policy, sessionFiles, Math.max(1, Number(opts.last) || 3));

    const lines: string[] = [];
    const accepted = verdicts.filter((v) => v.accepted && v.rule);
    for (const v of verdicts) {
      lines.push(v.accepted ? `✓ accepted: ${v.id} (${v.impact.newBlocks} historical blocks)` : `✗ rejected: ${v.problems.join("; ")}`);
      if (v.accepted) lines.push(v.yaml ?? "");
    }
    const report = lines.join("\n");
    if (opts.out) {
      // proposals reference ledger contents — keep report files private
      await mkdir(dirname(opts.out), { recursive: true });
      await writeFile(opts.out, report + "\n", { encoding: "utf8", mode: 0o600 });
      console.log(`report written: ${opts.out}`);
    } else {
      console.log(report + "\n");
    }

    if (accepted.length > 0 && opts.apply) {
      // structured merge: append the validated Rule objects to the policy AST,
      // re-serialize, round-trip through loadPolicy, then atomic write.
      // A failure here leaves the original policy bytes untouched.
      const merged: typeof policy = {
        ...policy,
        rules: [...policy.rules, ...accepted.map((v) => v.rule!)],
      };
      const mergedText = yamlStringify(merged);
      try {
        const reparsed = loadPolicy(mergedText);
        if (reparsed.rules.length !== merged.rules.length) {
          return failClosed("generated policy lost rules during round-trip — original file unchanged");
        }
      } catch (err) {
        return failClosed(
          `generated policy failed validation — original file unchanged: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      await backupOnce(policyPath);
      await atomicWrite(policyPath, mergedText.endsWith("\n") ? mergedText : mergedText + "\n");
      console.log(`applied ${accepted.length} rule(s) to ${policyPath} (YAML regenerated; policy digest changes on the next decision)`);
    } else if (accepted.length > 0) {
      console.log(`\n${accepted.length} proposal(s) passed verification. Review them and re-run with --apply to add to ${policyPath}.`);
    } else {
      process.exitCode = 1;
    }
  });

program
  .command("explain")
  .description("optional LLM: incident narrative from a session snapshot")
  .argument("[file]", "trace file (default: newest session)")
  .option("--audience <a>", "dev | audit", "dev")
  .option("--out <path>", "write the report to a file")
  .option("--policy <path>", "policy file override")
  .action(async (file: string | undefined, opts: { audience: string; out?: string; policy?: string }) => {
    const cfg = loadLlmConfig();
    if (cfg.provider === "none") {
      process.stderr.write(
        "[reins] LLM is not configured — see docs/LLM.md. Optional feature; reins works fully without it.\n",
      );
      process.exit(1);
    }
    const target = file ?? (await newestSessionFile());
    if (!target) return failClosed("no session traces found");
    const events = await readTrace(target);
    const integrity = await verifyTrace(target);
    const { agent, sessionId } = deriveAgentAndSession(target);

    // LLM-safe renderer: redacted commands, tilde paths, no absolute
    // filesystem locations and no diffs ever leave the machine
    const timeline = events.map((e) => {
      const input = (typeof e.input === "object" && e.input !== null ? e.input : {}) as Record<string, unknown>;
      return {
        ts: e.ts,
        tool: e.tool,
        decision: e.decision,
        matchedRule: e.matchedRule,
        reason: e.reason,
        command: typeof input["command"] === "string" ? input["command"] : undefined,
        filePath: typeof input["file_path"] === "string" ? input["file_path"] : undefined,
      };
    });
    const snapshotText = buildLlmSnapshot(timeline, {
      agent,
      sessionId,
      integrityOk: integrity.ok,
      integrityNote: integrity.ok ? undefined : `${integrity.reason ?? "integrity failure"} at event ${integrity.brokenAt}`,
    });
    const audienceArg = opts.audience === "audit" ? "audit" : "dev";
    const report = await runExplain(cfg, snapshotText, audienceArg);
    if (opts.out) await writeFile(opts.out, report + "\n", { encoding: "utf8", mode: 0o600 });
    else console.log(report);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  return failClosed(`unexpected error: ${err instanceof Error ? err.stack : String(err)}`);
});
