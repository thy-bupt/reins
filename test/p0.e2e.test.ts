import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist", "cli", "main.js");
const cli = existsSync(DIST);

function runCli(args: string[], env: NodeJS.ProcessEnv, input?: string) {
  return spawnSync(process.execPath, [DIST, ...args], { env: { ...process.env, ...env }, input, encoding: "utf8" });
}

function freshHome(): string {
  const dir = join("/tmp", `reins-p0-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// provide a policy in the home so resolvePolicyPath picks it up
function withPolicy(home: string): string {
  const policy = readFileSync(join(HERE, "..", "policies", "default.yaml"), "utf8");
  writeFileSync(join(home, "policy.yaml"), policy);
  return home;
}

import { writeFileSync } from "node:fs";

describe.skipIf(!cli)("P0 CLI ergonomics (e2e against dist)", () => {
  it("policy eval denies a destructive command with exit 2 and prints the rule", () => {
    const home = withPolicy(freshHome());
    const r = runCli(["policy", "eval", "rm -rf /tmp/x"], { REINS_HOME: home });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("deny");
    expect(r.stdout).toContain("rm-recursive");
  });

  it("policy eval allows a benign command with exit 0", () => {
    const home = withPolicy(freshHome());
    const r = runCli(["policy", "eval", "ls -la"], { REINS_HOME: home });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("allow");
  });

  it("policy eval can evaluate a file path against path rules", () => {
    const home = withPolicy(freshHome());
    const r = runCli(["policy", "eval", "--file", "/repo/.env"], { REINS_HOME: home });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("protect-dotenv");
  });

  it("trace show renders a human-readable timeline", () => {
    const home = withPolicy(freshHome());
    runCli(["init", "claude", "--settings", join(home, "s.json")], { REINS_HOME: home });
    runCli(["hook", "claude"], { REINS_HOME: home }, JSON.stringify({ session_id: "show1", tool_name: "Bash", tool_input: { command: "ls" } }));
    runCli(["hook", "claude"], { REINS_HOME: home }, JSON.stringify({ session_id: "show1", tool_name: "Bash", tool_input: { command: "rm -rf /tmp/x" } }));

    const traceFile = join(home, "sessions", "claude-show1.jsonl");
    const r = runCli(["trace", "show", traceFile], { REINS_HOME: home });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("claude-show1.jsonl");
    expect(r.stdout).toContain("#0");
    expect(r.stdout).toContain("#1");
    expect(r.stdout).toContain("rm-recursive");
  });

  it("uninstall claude removes the hook entry without touching foreign hooks", () => {
    const home = freshHome();
    const settingsPath = join(home, "settings.json");
    runCli(["init", "claude", "--settings", settingsPath], { REINS_HOME: home });
    expect(readFileSync(settingsPath, "utf8")).toContain("reins hook claude");

    // seed a foreign hook alongside
    const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    parsed.hooks.PreToolUse.unshift({ matcher: "Write", hooks: [{ type: "command", command: "mine.sh" }] });
    writeFileSync(settingsPath, JSON.stringify(parsed));

    const r = runCli(["uninstall", "claude", "--settings", settingsPath], { REINS_HOME: home });
    expect(r.status).toBe(0);

    const after = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(after.hooks.PreToolUse).toHaveLength(1);
    expect(after.hooks.PreToolUse[0]!.hooks[0]!.command).toBe("mine.sh");
  });

  it("uninstall opencode deletes the generated plugin file", () => {
    const home = freshHome();
    const pluginPath = join(home, "railguard.js");
    runCli(["init", "opencode", "--settings", pluginPath], { REINS_HOME: home });
    expect(existsSync(pluginPath)).toBe(true);

    const r = runCli(["uninstall", "opencode", "--settings", pluginPath], { REINS_HOME: home });
    expect(r.status).toBe(0);
    expect(existsSync(pluginPath)).toBe(false);
  });

  it("uninstall is idempotent: a second run reports not-installed and exits 0", () => {
    const home = freshHome();
    const settingsPath = join(home, "settings.json");
    runCli(["init", "claude", "--settings", settingsPath], { REINS_HOME: home });
    runCli(["uninstall", "claude", "--settings", settingsPath], { REINS_HOME: home });
    const r = runCli(["uninstall", "claude", "--settings", settingsPath], { REINS_HOME: home });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/not installed/i);
  });

  it("uninstall refuses to delete a repurposed plugin file", () => {
    const home = freshHome();
    const pluginPath = join(home, "railguard.js");
    runCli(["init", "opencode", "--settings", pluginPath], { REINS_HOME: home });
    writeFileSync(pluginPath, "// my own stuff now, no reins marker");

    const r = runCli(["uninstall", "opencode", "--settings", pluginPath], { REINS_HOME: home });
    expect(r.status).toBe(0);
    expect(existsSync(pluginPath)).toBe(true);
    expect(r.stdout).toMatch(/not a reins-generated file/i);
    rmSync(pluginPath);
  });
});
