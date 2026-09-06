import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTrace, TraceWriter } from "../src/core/trace.js";
import { runGuarded } from "../src/core/runner.js";

async function tmpDir() {
  return mkdtemp(join(tmpdir(), "railguard-runner-test-"));
}

describe("runGuarded", () => {
  it("executes the command and records an ok event with exit code", async () => {
    const trace = await TraceWriter.start(await tmpDir());
    const result = await runGuarded({ command: "echo hello", trace });

    expect(result.blocked).toBe(false);
    expect(result.exitCode).toBe(0);

    const events = await readTrace(trace.filePath);
    expect(events).toHaveLength(1);
    expect(events[0]!.tool).toBe("exec");
    expect(events[0]!.input).toEqual({ command: "echo hello" });
    expect(events[0]!.decision).toBe("allow");
    expect(events[0]!.result).toBe("ok");
    expect(events[0]!.exitCode).toBe(0);
  });

  it("records an error event with the failing exit code", async () => {
    const trace = await TraceWriter.start(await tmpDir());
    const result = await runGuarded({ command: "exit 3", trace });

    expect(result.blocked).toBe(false);
    expect(result.exitCode).toBe(3);

    const events = await readTrace(trace.filePath);
    expect(events[0]!.result).toBe("error");
    expect(events[0]!.exitCode).toBe(3);
  });

  it("runs the command in the requested cwd", async () => {
    const dir = await tmpDir();
    const trace = await TraceWriter.start(await tmpDir());
    const result = await runGuarded({ command: "pwd", trace, cwd: dir });

    expect(result.exitCode).toBe(0);
    const events = await readTrace(trace.filePath);
    expect(events[0]!.input).toEqual({ command: "pwd", cwd: dir });
  });

  it("propagates stdin=ignore and does not hang on commands that read stdin", async () => {
    const trace = await TraceWriter.start(await tmpDir());
    const result = await runGuarded({ command: "cat", trace });
    expect(result.exitCode).toBe(0);
  });

  it("blocks without executing when the decision is deny", async () => {
    const sandbox = await tmpDir();
    const sentinel = join(sandbox, "should-not-exist");
    const trace = await TraceWriter.start(await tmpDir());
    const result = await runGuarded({
      command: `touch "${sentinel}"`,
      trace,
      decision: { decision: "deny", matchedRule: "rm-recursive", reason: "nope" },
    });

    expect(result.blocked).toBe(true);
    expect(result.exitCode).toBe(2);
    await expect(access(sentinel)).rejects.toThrow();

    const events = await readTrace(trace.filePath);
    expect(events).toHaveLength(1);
    expect(events[0]!.decision).toBe("deny");
    expect(events[0]!.result).toBe("blocked");
    expect(events[0]!.matchedRule).toBe("rm-recursive");
  });

  it("treats ask as deny in headless exec mode", async () => {
    const trace = await TraceWriter.start(await tmpDir());
    const result = await runGuarded({
      command: "echo hi",
      trace,
      decision: { decision: "ask", reason: "needs a human" },
    });
    expect(result.blocked).toBe(true);
    const events = await readTrace(trace.filePath);
    expect(events[0]!.decision).toBe("ask");
    expect(events[0]!.result).toBe("blocked");
  });
});
