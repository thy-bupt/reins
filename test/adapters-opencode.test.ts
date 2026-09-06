import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { handleToolExecute } from "../src/adapters/opencode/hook.js";
import { OPENCODE_PLUGIN_COMMAND, opencodePluginSource } from "../src/adapters/opencode/installer.js";
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
  return TraceWriter.start(await mkdtemp(join(tmpdir(), "railguard-opencode-")));
}

describe("opencode payload contract", () => {
  it("allows benign commands", async () => {
    const trace = await setup();
    const outcome = await handleToolExecute(
      { tool: "bash", args: { command: "ls -la" } },
      { policy, trace },
    );
    expect(outcome.exitCode).toBe(0);
    const events = await readTrace(trace.filePath);
    expect(events[0]!.tool).toBe("bash");
    expect(events[0]!.decision).toBe("allow");
  });

  it("blocks destructive commands", async () => {
    const trace = await setup();
    const outcome = await handleToolExecute(
      { tool: "bash", args: { command: "rm -rf /" } },
      { policy, trace },
    );
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("rm-recursive");
  });

  it("maps camelCase filePath args onto path rules", async () => {
    const trace = await setup();
    const outcome = await handleToolExecute(
      { tool: "write", args: { filePath: "/repo/.env", content: "x" } },
      { policy, trace },
    );
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("secrets");
  });

  it("falls back to the policy default for unknown input shapes", async () => {
    const trace = await setup();
    const outcome = await handleToolExecute(
      { tool: "grep", args: { pattern: "x" } },
      { policy, trace },
    );
    expect(outcome.exitCode).toBe(0);
  });

  it("fails closed on malformed payloads", async () => {
    const trace = await setup();
    const outcome = await handleToolExecute("nope", { policy, trace });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.stderr).toContain("fail-closed");
  });
});

describe("opencode plugin generator", () => {
  it("generates a plugin that spawns railguard and throws on deny", () => {
    const source = opencodePluginSource();
    expect(source).toContain("tool.execute.before");
    expect(source).toContain("spawnSync");
    expect(source).toContain("throw new Error");
    expect(source).toContain(OPENCODE_PLUGIN_COMMAND);
  });
});
