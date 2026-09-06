import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleToolCall } from "../src/adapters/pi/hook.js";
import { PI_EXTENSION_COMMAND, piExtensionSource } from "../src/adapters/pi/installer.js";
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
  return TraceWriter.start(await mkdtemp(join(tmpdir(), "railguard-pi-")));
}

describe("pi payload contract", () => {
  it("allows benign bash commands", async () => {
    const trace = await setup();
    const outcome = await handleToolCall(
      { tool: "bash", args: { command: "ls -la" } },
      { policy, trace },
    );
    expect(outcome.exitCode).toBe(0);
    const events = await readTrace(trace.filePath);
    expect(events[0]!.decision).toBe("allow");
  });

  it("blocks destructive commands", async () => {
    const trace = await setup();
    const outcome = await handleToolCall(
      { tool: "bash", args: { command: "rm -rf /" } },
      { policy, trace },
    );
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("rm-recursive");
  });

  it("fails closed on malformed payloads", async () => {
    const trace = await setup();
    const outcome = await handleToolCall(undefined, { policy, trace });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("fail-closed");
  });
});

describe("pi extension generator", () => {
  it("generates an extension using the tool_call block contract", () => {
    const source = piExtensionSource();
    expect(source).toContain('pi.on("tool_call"');
    expect(source).toContain("block: true");
    expect(source).toContain(PI_EXTENSION_COMMAND);
    expect(source).toContain("toolName");
  });
});
