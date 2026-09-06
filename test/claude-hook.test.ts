import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handlePreToolUse } from "../src/adapters/claude/hook.js";
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
  - id: ask-force-push
    kind: command
    action: ask
    program: git
    subcommand: push
    flags: ["--force"]
    reason: "force push rewrites history"
`);

async function setup() {
  const trace = await TraceWriter.start(await mkdtemp(join(tmpdir(), "reins-hook-")));
  return { trace };
}

describe("handlePreToolUse", () => {
  it("allows a benign command with exit 0 and records an allow event", async () => {
    const { trace } = await setup();
    const outcome = await handlePreToolUse(
      { session_id: "s1", tool_name: "Bash", tool_input: { command: "ls -la" } },
      { policy, trace },
    );

    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).toBe("");

    const events = await readTrace(trace.filePath);
    expect(events).toHaveLength(1);
    expect(events[0]!.decision).toBe("allow");
    expect(events[0]!.tool).toBe("Bash");
    expect(events[0]!.input).toEqual({ command: "ls -la" });
  });

  it("blocks rm -rf with exit 2, stderr reason, and a blocked trace event", async () => {
    const { trace } = await setup();
    const outcome = await handlePreToolUse(
      { tool_name: "Bash", tool_input: { command: "rm -rf /tmp/x" } },
      { policy, trace },
    );

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("rm-recursive");
    expect(outcome.stderr).toContain("recursive deletion");

    const events = await readTrace(trace.filePath);
    expect(events[0]!.decision).toBe("deny");
    expect(events[0]!.result).toBe("blocked");
    expect(events[0]!.matchedRule).toBe("rm-recursive");
  });

  it("returns an ask permissionDecision as JSON on stdout for ask rules", async () => {
    const { trace } = await setup();
    const outcome = await handlePreToolUse(
      { tool_name: "Bash", tool_input: { command: "git push --force" } },
      { policy, trace },
    );

    expect(outcome.exitCode).toBe(0);
    const parsed = JSON.parse(outcome.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(parsed.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("force push");
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");

    const events = await readTrace(trace.filePath);
    expect(events[0]!.decision).toBe("ask");
  });

  it("fails closed on a malformed payload", async () => {
    const { trace } = await setup();
    const outcome = await handlePreToolUse("not even json", { policy, trace });

    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("fail-closed");

    const events = await readTrace(trace.filePath);
    expect(events[0]!.decision).toBe("deny");
  });

  it("fails closed when tool_input is missing", async () => {
    const { trace } = await setup();
    const outcome = await handlePreToolUse({ tool_name: "Bash" }, { policy, trace });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("fail-closed");
  });

  it("routes file writes through path rules", async () => {
    const pathPolicy = loadPolicy(`
version: 1
default: allow
rules:
  - id: protect-env
    kind: path
    action: deny
    path: "**/.env*"
    reason: "secrets"
`);
    const { trace } = await setup();
    const outcome = await handlePreToolUse(
      { tool_name: "Write", tool_input: { file_path: "/repo/.env" } },
      { policy: pathPolicy, trace },
    );
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("secrets");
  });
});
