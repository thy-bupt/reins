import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist", "cli", "main.js");
const cli = existsSync(DIST);

function runCli(args: string[], env: NodeJS.ProcessEnv, input?: string) {
  return spawnSync(process.execPath, [DIST, ...args], { env: { ...process.env, ...env }, input, encoding: "utf8" });
}

type Fixture = { label: string; payload: string; shouldBlock: boolean; stderrContains?: string };

const snake = (tool_name: string, tool_input: Record<string, unknown>, session_id: string) =>
  JSON.stringify({ session_id, hook_event_name: "PreToolUse", tool_name, tool_input });
const camel = (toolName: string, toolInput: Record<string, unknown>, sessionId: string) =>
  JSON.stringify({ hookEventName: "PreToolUse", sessionId, cwd: "/repo", workspaceRoot: "/repo", toolName, toolInput });
const loose = (tool: string, args: Record<string, unknown>, session_id: string) =>
  JSON.stringify({ tool, args, session_id });

const FIXTURES: Record<string, Fixture[]> = {
  claude: [
    { label: "benign bash", payload: snake("Bash", { command: "ls -la" }, "mtx-claude"), shouldBlock: false },
    { label: "rm -rf", payload: snake("Bash", { command: "rm -rf /tmp/x" }, "mtx-claude"), shouldBlock: true, stderrContains: "rm-recursive" },
    { label: "env write", payload: snake("Write", { file_path: "/repo/.env" }, "mtx-claude"), shouldBlock: true, stderrContains: "protect-dotenv" },
  ],
  gemini: [
    { label: "benign bash", payload: snake("run_shell_command", { command: "git status" }, "mtx-gemini"), shouldBlock: false },
    { label: "rm -rf", payload: snake("run_shell_command", { command: "rm -rf /tmp/x" }, "mtx-gemini"), shouldBlock: true, stderrContains: "rm-recursive" },
    { label: "env write", payload: snake("write_file", { file_path: "/repo/.env" }, "mtx-gemini"), shouldBlock: true, stderrContains: "protect-dotenv" },
  ],
  grok: [
    { label: "benign bash", payload: camel("Bash", { command: "echo hi" }, "mtx-grok"), shouldBlock: false },
    { label: "rm -rf", payload: camel("Bash", { command: "rm -rf /tmp/x" }, "mtx-grok"), shouldBlock: true, stderrContains: "rm-recursive" },
    { label: "env write", payload: camel("Write", { file_path: "/repo/.env" }, "mtx-grok"), shouldBlock: true, stderrContains: "protect-dotenv" },
  ],
  codex: [
    { label: "benign bash", payload: snake("Bash", { command: "pwd" }, "mtx-codex"), shouldBlock: false },
    { label: "rm -rf", payload: snake("Bash", { command: "rm -rf /tmp/x" }, "mtx-codex"), shouldBlock: true, stderrContains: "rm-recursive" },
    { label: "env write", payload: snake("ApplyPatch", { file_path: "/repo/.env" }, "mtx-codex"), shouldBlock: true, stderrContains: "protect-dotenv" },
  ],
  opencode: [
    { label: "benign bash", payload: loose("bash", { command: "ls" }, "mtx-opencode"), shouldBlock: false },
    { label: "rm -rf", payload: loose("bash", { command: "rm -rf /tmp/x" }, "mtx-opencode"), shouldBlock: true, stderrContains: "rm-recursive" },
    { label: "env write", payload: loose("write", { filePath: "/repo/.env" }, "mtx-opencode"), shouldBlock: true, stderrContains: "protect-dotenv" },
  ],
  pi: [
    { label: "benign bash", payload: loose("bash", { command: "date" }, "mtx-pi"), shouldBlock: false },
    { label: "rm -rf", payload: loose("bash", { command: "rm -rf /tmp/x" }, "mtx-pi"), shouldBlock: true, stderrContains: "rm-recursive" },
    { label: "env write", payload: loose("write", { path: "/repo/.env" }, "mtx-pi"), shouldBlock: true, stderrContains: "protect-dotenv" },
  ],
};

const INIT_TARGETS: Record<string, { settingsFlag: string; markers: Array<(content: string) => void> }> = {
  claude: {
    settingsFlag: "settings.json",
    markers: [
      (c) => expect(JSON.parse(c).hooks.PreToolUse.some((g: { hooks: Array<{ command: string }> }) => g.hooks.some((h) => h.command === "railguard hook claude"))),
    ],
  },
  gemini: {
    settingsFlag: "settings.json",
    markers: [
      (c) => expect(JSON.parse(c).hooks.BeforeTool.some((g: { hooks: Array<{ command: string }> }) => g.hooks.some((h) => h.command === "railguard hook gemini"))),
    ],
  },
  grok: {
    settingsFlag: join("hooks", "railguard.json"),
    markers: [
      (c) => expect(JSON.parse(c).hooks.PreToolUse.some((g: { hooks: Array<{ command: string }> }) => g.hooks.some((h) => h.command === "railguard hook grok"))),
    ],
  },
  codex: {
    settingsFlag: "hooks.json",
    markers: [
      (c) => expect(JSON.parse(c).hooks.PreToolUse.some((g: { hooks: Array<{ command: string }> }) => g.hooks.some((h) => h.command === "railguard hook codex"))),
    ],
  },
  opencode: {
    settingsFlag: "railguard.js",
    markers: [(c) => expect(c).toContain("tool.execute.before"), (c) => expect(c).toContain("railguard hook opencode")],
  },
  pi: {
    settingsFlag: "railguard.ts",
    markers: [(c) => expect(c).toContain("tool_call"), (c) => expect(c).toContain("block: true"), (c) => expect(c).toContain("railguard hook pi")],
  },
};

describe.skipIf(!cli)("agent matrix e2e: init + hook + trace for every adapter", () => {
  for (const agent of Object.keys(FIXTURES)) {
    describe(agent, () => {
      let home = "";
      let agentDir = "";

      const boot = () => {
        if (home) return;
        home = mkdtempSync();
        agentDir = mkdtempSync();
        const init = runCli(["init", agent, "--settings", join(agentDir, INIT_TARGETS[agent]!.settingsFlag)], {
          RAILGUARD_HOME: home,
        });
        expect(init.status, `init ${agent} failed: ${init.stderr}`).toBe(0);
        expect(existsSync(join(home, "policy.yaml")), "policy must be installed into RAILGUARD_HOME").toBe(true);
      };

      function mkdtempSync(): string {
        // spawnSync-based tests need sync tempdirs
        const dir = join(tmpdir(), `railguard-mtx-${agent}-${Math.random().toString(36).slice(2)}`);
        mkdirSync(dir, { recursive: true });
        return dir;
      }

      it(`init ${agent} writes a config carrying the railguard hook`, () => {
        boot();
        const configPath = join(agentDir, INIT_TARGETS[agent]!.settingsFlag);
        expect(existsSync(configPath), `${configPath} must exist`).toBe(true);
        const content = readFileSync(configPath, "utf8");
        for (const marker of INIT_TARGETS[agent]!.markers) marker(content);
      });

      if (agent === "codex") {
        it("init codex also enables [features] hooks in config.toml", () => {
          boot();
          const tomlPath = join(agentDir, "config.toml");
          expect(existsSync(tomlPath)).toBe(true);
          expect(readFileSync(tomlPath, "utf8")).toMatch(/\[features\]\nhooks = true/);
        });
      }

      for (const fixture of FIXTURES[agent]!) {
        it(`hook: ${fixture.label} → ${fixture.shouldBlock ? "blocked (exit 2)" : "allowed (exit 0)"}`, () => {
          boot();
          const r = runCli(["hook", agent], { RAILGUARD_HOME: home }, fixture.payload);
          if (fixture.shouldBlock) {
            expect(r.status, `expected block, got ${r.status}; stderr=${r.stderr}`).toBe(2);
            expect(r.stderr).toContain(fixture.stderrContains!);
          } else {
            expect(r.status, `expected allow, got ${r.status}; stderr=${r.stderr}`).toBe(0);
            expect(r.stderr).toBe("");
          }

          // every decision lands in a per-agent session ledger with an intact chain
          const tracePath = join(home, "sessions", `${agent}-${sessionIdOf(fixture)}.jsonl`);
          expect(existsSync(tracePath), `trace ${tracePath} must exist`).toBe(true);
          const verify = runCli(["trace", "verify", tracePath], { RAILGUARD_HOME: home });
          expect(verify.status).toBe(0);
          expect(verify.stdout).toContain("hash chain intact");
        });
      }
    });
  }

  function sessionIdOf(fixture: Fixture): string {
    const parsed = JSON.parse(fixture.payload) as Record<string, unknown>;
    return String(parsed["session_id"] ?? parsed["sessionId"]);
  }
});
