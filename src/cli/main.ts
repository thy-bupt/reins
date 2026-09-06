#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { Command } from "commander";
import { handlePreToolUse } from "../adapters/claude/hook.js";
import { mergeSettings } from "../adapters/claude/installer.js";
import {
  BUNDLED_POLICY_PATH,
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

const program = new Command();
program
  .name("railguard")
  .description(
    "Fail-closed safety rail for AI coding agents: policy engine, tamper-evident trace, session replay.",
  )
  .version(VERSION);

program
  .command("init")
  .description("install the railguard hook for a coding agent")
  .argument("<adapter>", "agent adapter: claude")
  .option("--policy <path>", "policy file to install as your default")
  .option("--settings <path>", "agent settings file", join(homedir(), ".claude", "settings.json"))
  .action(async (adapter: string, opts: { policy?: string; settings: string }) => {
    if (adapter !== "claude") {
      return failClosed(`unknown adapter "${adapter}" (supported: claude)`);
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

    const settingsPath = opts.settings;
    const raw = existsSync(settingsPath) ? await readFile(settingsPath, "utf8") : "{}";
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw || "{}");
    } catch {
      return failClosed(`${settingsPath} is not valid JSON — not touching it`);
    }
    const { settings, changed } = mergeSettings(parsed);
    if (changed) {
      if (existsSync(settingsPath)) {
        const backup = `${settingsPath}.railguard-backup`;
        if (!existsSync(backup)) await copyFile(settingsPath, backup);
      }
      await atomicWrite(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      console.log(`hook installed in ${settingsPath} (backup written alongside)`);
    } else {
      console.log(`hook already installed in ${settingsPath}`);
    }
    console.log("\nrailguard is live. Try: railguard trace list");
  });

program
  .command("hook")
  .description("agent hook entrypoint (reads the hook payload on stdin)")
  .argument("<adapter>", "agent adapter: claude")
  .option("--policy <path>", "policy file override")
  .action(async (adapter: string, opts: { policy?: string }) => {
    if (adapter !== "claude") {
      return failClosed(`unknown adapter "${adapter}" (supported: claude)`);
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
      const maybeSession = (payload as Record<string, unknown> | null)?.["session_id"];
      const sessionId =
        typeof maybeSession === "string" && maybeSession.trim() !== ""
          ? maybeSession
          : `adhoc-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      const trace = await TraceWriter.open(join(sessionsDir(), `claude-${sessionId}.jsonl`));
      const outcome = await handlePreToolUse(payload, { policy, trace });
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

program.parseAsync(process.argv).catch((err: unknown) => {
  return failClosed(`unexpected error: ${err instanceof Error ? err.stack : String(err)}`);
});
