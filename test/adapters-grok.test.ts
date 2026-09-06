import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handlePreToolUse as handleGrok } from "../src/adapters/grok/hook.js";
import { GROK_HOOK_COMMAND, grokHooksFileContent, hasGrokHook } from "../src/adapters/grok/installer.js";
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
`);

async function setup() {
  return TraceWriter.start(await mkdtemp(join(tmpdir(), "railguard-grok-")));
}

describe("grok hook adapter", () => {
  it("normalizes the camelCase Grok payload and allows benign commands", async () => {
    const trace = await setup();
    const outcome = await handleGrok(
      {
        hookEventName: "PreToolUse",
        sessionId: "gk-1",
        cwd: "/repo",
        workspaceRoot: "/repo",
        toolName: "Bash",
        toolInput: { command: "ls -la" },
      },
      { policy, trace },
    );

    expect(outcome.exitCode).toBe(0);
    const events = await readTrace(trace.filePath);
    expect(events[0]!.tool).toBe("Bash");
    expect(events[0]!.input).toEqual({ command: "ls -la" });
    expect(events[0]!.decision).toBe("allow");
  });

  it("blocks destructive commands with exit 2", async () => {
    const trace = await setup();
    const outcome = await handleGrok(
      { hookEventName: "PreToolUse", toolName: "Bash", toolInput: { command: "rm -rf /" } },
      { policy, trace },
    );
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("rm-recursive");
  });

  it("fails closed on malformed payloads", async () => {
    const trace = await setup();
    const outcome = await handleGrok(null, { policy, trace });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("fail-closed");
  });
});

describe("grok installer", () => {
  it("generates a hooks file with no matcher (all tools) and the command hook", () => {
    const content = grokHooksFileContent(null);
    const parsed = JSON.parse(content) as {
      hooks: { PreToolUse: Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> }> };
    };
    const group = parsed.hooks.PreToolUse[0]!;
    expect(group.matcher).toBeUndefined();
    const hook = group.hooks[0]!;
    expect(hook.command).toBe(GROK_HOOK_COMMAND);
    expect(hook.type).toBe("command");
    expect(typeof hook.timeout).toBe("number");
  });

  it("merges into an existing railguard hooks file without duplicating", () => {
    const once = grokHooksFileContent(null);
    const twice = grokHooksFileContent(once);
    const parsed = JSON.parse(twice) as { hooks: { PreToolUse: unknown[] } };
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
  });

  it("leaves foreign hook groups in an existing file untouched", () => {
    const existing = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-own-check.sh" }] }] },
    });
    const merged = grokHooksFileContent(existing);
    const parsed = JSON.parse(merged) as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    };
    expect(parsed.hooks.PreToolUse).toHaveLength(2);
    expect(parsed.hooks.PreToolUse[0]!.hooks[0]!.command).toBe("my-own-check.sh");
    expect(hasGrokHook(merged)).toBe(true);
  });

  it("detects absence of railguard in a file", () => {
    expect(hasGrokHook(JSON.stringify({ hooks: { PreToolUse: [] } }))).toBe(false);
    expect(hasGrokHook(null)).toBe(false);
  });
});
