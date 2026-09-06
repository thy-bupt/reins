#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Command } from "commander";
import { handlePreToolUse as handleClaude } from "../adapters/claude/hook.js";
import { mergeSettings as mergeClaudeSettings } from "../adapters/claude/installer.js";
import { handleBeforeTool as handleGemini } from "../adapters/gemini/hook.js";
import { mergeGeminiSettings } from "../adapters/gemini/installer.js";
import { handlePreToolUse as handleGrok } from "../adapters/grok/hook.js";
import { grokHooksFileContent } from "../adapters/grok/installer.js";
import { handlePreToolUse as handleCodex } from "../adapters/codex/hook.js";
import { codexHooksFileContent, ensureHooksFeature } from "../adapters/codex/installer.js";
import { handleToolExecute as handleOpenCode } from "../adapters/opencode/hook.js";
import { opencodePluginSource } from "../adapters/opencode/installer.js";
import { handleToolCall as handlePi } from "../adapters/pi/hook.js";
import { piExtensionSource } from "../adapters/pi/installer.js";
import { sessionIdFrom } from "../adapters/common.js";
import { formatDoctorReport, runDoctor } from "./doctor.js";
import { formatReplayReport, replaySession } from "./replay.js";
import {
  BUNDLED_POLICY_PATH,
  railguardHome,
  resolvePolicyPath,
  sessionsDir,
  userPolicyPath,
} from "../core/home.js";
import { decide } from "../core/decider.js";
import { loadPolicy, PolicyError } from "../core/policy.js";
import { runGuarded } from "../core/runner.js";
import { readTrace, TraceWriter, verifyTrace } from "../core/trace.js";

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
  const tmp = `${filePath}.railguard-tmp-${process.pid}`;
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

async function backupOnce(filePath: string): Promise<void> {
  const backup = `${filePath}.railguard-backup`;
  if (existsSync(filePath) && !existsSync(backup)) await copyFile(filePath, backup);
}

async function failClosed(message: string): Promise<never> {
  process.stderr.write(`[railguard] ${message}\n`);
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
  .name("railguard")
  .description(
    "Fail-closed safety rail for AI coding agents: policy engine, tamper-evident trace, session replay.",
  )
  .version(VERSION);

program
  .command("init")
  .description(`install the railguard hook for a coding agent (${HOOK_ADAPTER_NAMES.join(", ")})`)
  .argument("<adapter>", `agent adapter: ${HOOK_ADAPTER_NAMES.join(" | ")}`)
  .option("--policy <path>", "policy file to install as your default")
  .option(
    "--settings <path>",
    "agent settings/config file override (where applicable)",
  )
  .action(async (adapter: string, opts: { policy?: string; settings?: string }) => {
    if (!(adapter in HOOK_ADAPTERS)) {
      return failClosed(`unknown adapter "${adapter}" (supported: ${HOOK_ADAPTER_NAMES.join(", ")})`);
    }
    await mkdir(sessionsDir(), { recursive: true });

    const policyDest = userPolicyPath();
    const policySource = opts.policy ?? BUNDLED_POLICY_PATH;
    if (!existsSync(policyDest)) {
      await mkdir(dirname(policyDest), { recursive: true });
      await copyFile(policySource, policyDest);
      console.log(`policy installed: ${policyDest}`);
    } else {
      console.log(`policy already present, leaving untouched: ${policyDest}`);
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
        const hooksPath = opts.settings ?? join(homedir(), ".grok", "hooks", "railguard.json");
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
          opts.settings ?? join(homedir(), ".config", "opencode", "plugins", "railguard.js");
        await atomicWrite(pluginPath, opencodePluginSource());
        console.log(`plugin installed in ${pluginPath}`);
        break;
      }

      case "pi": {
        const extPath = opts.settings ?? join(homedir(), ".pi", "agent", "extensions", "railguard.ts");
        await atomicWrite(extPath, piExtensionSource());
        console.log(`extension installed in ${extPath}`);
        break;
      }
    }

    console.log("\nrailguard is live. Try: railguard trace list");
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
      const policy = loadPolicy(readFileSync(resolvePolicyPath(opts.policy), "utf8"));
      const sessionId = sessionIdFrom(payload, adapter);
      const trace = await TraceWriter.open(join(sessionsDir(), `${adapter}-${sessionId}.jsonl`));
      const outcome = await handler(payload, { policy, trace });
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
    const policy = loadPolicy(readFileSync(resolvePolicyPath(opts.policy), "utf8"));
    const trace = await TraceWriter.start(sessionsDir());
    const decision = decide(policy, { tool: "exec", input: { command } });
    const result = await runGuarded({ command, trace, cwd: opts.cwd, decision });
    if (result.blocked) {
      process.stderr.write(
        `[railguard] blocked by rule "${decision.matchedRule ?? "default"}": ${decision.reason ?? "policy denied this action"}\n`,
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
  .option("--home <dir>", "railguard home", railguardHome())
  .option("--settings <path>", "Claude Code settings file", join(homedir(), ".claude", "settings.json"))
  .option("--no-path-check", "skip checking whether railguard is on PATH")
  .action(async (opts: { home: string; settings: string; pathCheck: boolean }) => {
    const report = await runDoctor({
      home: opts.home,
      settingsPath: opts.settings,
      checkPath: opts.pathCheck,
      agentPaths: {
        gemini: join(homedir(), ".gemini", "settings.json"),
        grok: join(homedir(), ".grok", "hooks", "railguard.json"),
        codexHooks: join(homedir(), ".codex", "hooks.json"),
        codexConfig: join(homedir(), ".codex", "config.toml"),
        opencode: join(homedir(), ".config", "opencode", "plugins", "railguard.js"),
        pi: join(homedir(), ".pi", "agent", "extensions", "railguard.ts"),
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

program.parseAsync(process.argv).catch((err: unknown) => {
  return failClosed(`unexpected error: ${err instanceof Error ? err.stack : String(err)}`);
});
