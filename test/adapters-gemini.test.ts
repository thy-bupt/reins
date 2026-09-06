import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleBeforeTool as handleGemini } from "../src/adapters/gemini/hook.js";
import { GEMINI_HOOK_COMMAND, GEMINI_HOOK_MATCHER, mergeGeminiSettings } from "../src/adapters/gemini/installer.js";
import { loadPolicy } from "../src/core/policy.js";
import { readTrace, TraceWriter } from "../src/core/trace.js";

const policy = loadPolicy(`
version: 1
default: allow
rules:
  - id: rm-recursive
    kind: command
    action: deny
    program: rm
    flags: ["-r", "--recursive"]
    reason: "recursive deletion is destructive"
  - id: protect-env
    kind: path
    action: deny
    path: "**/.env*"
    reason: "secrets"
`);

async function setup() {
  return TraceWriter.start(await mkdtemp(join(tmpdir(), "railguard-gemini-")));
}

describe("gemini hook adapter", () => {
  it("allows a benign run_shell_command with exit 0", async () => {
    const trace = await setup();
    const outcome = await handleGemini(
      {
        session_id: "g1",
        hook_event_name: "BeforeTool",
        tool_name: "run_shell_command",
        tool_input: { command: "ls -la" },
      },
      { policy, trace },
    );
    expect(outcome.exitCode).toBe(0);

    const events = await readTrace(trace.filePath);
    expect(events[0]!.tool).toBe("run_shell_command");
    expect(events[0]!.decision).toBe("allow");
  });

  it("blocks rm -rf with exit 2 and the rule reason on stderr", async () => {
    const trace = await setup();
    const outcome = await handleGemini(
      { hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "rm -rf /" } },
      { policy, trace },
    );
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("rm-recursive");
    const events = await readTrace(trace.filePath);
    expect(events[0]!.decision).toBe("deny");
    expect(events[0]!.result).toBe("blocked");
  });

  it("routes write_file through path rules", async () => {
    const trace = await setup();
    const outcome = await handleGemini(
      { hook_event_name: "BeforeTool", tool_name: "write_file", tool_input: { file_path: "/repo/.env" } },
      { policy, trace },
    );
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("secrets");
  });

  it("fails closed on a malformed payload", async () => {
    const trace = await setup();
    const outcome = await handleGemini("garbage", { policy, trace });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("fail-closed");
  });

  it("fails closed on ask rules (no ask channel on Gemini CLI)", async () => {
    const askPolicy = loadPolicy(`
version: 1
default: allow
rules:
  - id: ask-force-push
    kind: command
    action: ask
    program: git
    subcommand: push
    flags: ["--force"]
    reason: "force push rewrites history"
`);
    const trace = await setup();
    const outcome = await handleGemini(
      { tool_name: "run_shell_command", tool_input: { command: "git push --force" } },
      { policy: askPolicy, trace },
    );
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("ask");
    expect(outcome.stderr).toContain("force push");
  });
});

describe("gemini installer", () => {
  it("adds a BeforeTool entry to empty settings", () => {
    const { settings, changed } = mergeGeminiSettings({});
    expect(changed).toBe(true);
    const hooks = (settings as { hooks: { BeforeTool: Array<Record<string, unknown>> } }).hooks;
    const entry = hooks.BeforeTool[0]!;
    expect(entry.matcher).toBe(GEMINI_HOOK_MATCHER);
    expect((entry.hooks as Array<{ command: string }>)[0]!.command).toBe(GEMINI_HOOK_COMMAND);
  });

  it("preserves existing hooks and other settings", () => {
    const existing = {
      model: "gemini-pro",
      hooks: { BeforeTool: [{ matcher: "web_search", hooks: [{ type: "command", command: "logger" }] }] },
    };
    const { settings, changed } = mergeGeminiSettings(existing);
    expect(changed).toBe(true);
    expect((settings as { model: string }).model).toBe("gemini-pro");
    const pre = (settings as { hooks: { BeforeTool: unknown[] } }).hooks.BeforeTool;
    expect(pre).toHaveLength(2);
  });

  it("is idempotent", () => {
    const once = mergeGeminiSettings({});
    const twice = mergeGeminiSettings(once.settings);
    expect(twice.changed).toBe(false);
  });

  it("does not mutate its input", () => {
    const existing = { hooks: { BeforeTool: [] as unknown[] } };
    const snapshot = JSON.stringify(existing);
    mergeGeminiSettings(existing);
    expect(JSON.stringify(existing)).toBe(snapshot);
  });
});
