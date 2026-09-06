import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/cli/doctor.js";
import { TraceWriter } from "../src/core/trace.js";

const goodPolicy = `
version: 1
default: allow
rules:
  - id: rm-recursive
    kind: command
    action: deny
    program: rm
    flags: ["-r"]
    reason: destructive
`;

async function tmpHome() {
  return mkdtemp(join(tmpdir(), "railguard-doctor-"));
}

describe("runDoctor", () => {
  it("reports healthy for a fully installed rail", async () => {
    const home = await tmpHome();
    await writeFile(join(home, "policy.yaml"), goodPolicy);
    await mkdir(join(home, "sessions"));
    const settingsPath = join(home, "settings.json");
    await writeFile(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: "railguard hook claude" }] }] },
    }));

    const report = await runDoctor({ home, settingsPath, checkPath: false });
    expect(report.healthy).toBe(true);
    const names = report.checks.map((c) => c.name);
    expect(names).toContain("policy");
    expect(names).toContain("claude-hook");
    expect(names).toContain("sessions");
  });

  it("flags a missing policy file", async () => {
    const home = await tmpHome();
    const report = await runDoctor({ home, settingsPath: join(home, "settings.json"), checkPath: false });
    const policy = report.checks.find((c) => c.name === "policy")!;
    expect(policy.status).toBe("fail");
    expect(report.healthy).toBe(false);
  });

  it("flags an unloadable policy file", async () => {
    const home = await tmpHome();
    await writeFile(join(home, "policy.yaml"), "version: 99\nrules: []\n");
    const report = await runDoctor({ home, settingsPath: join(home, "settings.json"), checkPath: false });
    expect(report.checks.find((c) => c.name === "policy")!.status).toBe("fail");
  });

  it("warns that a missing claude hook means fail-open", async () => {
    const home = await tmpHome();
    await writeFile(join(home, "policy.yaml"), goodPolicy);
    await mkdir(join(home, "sessions"));
    const report = await runDoctor({
      home,
      settingsPath: join(home, "settings.json"),
      checkPath: false,
    });
    const hook = report.checks.find((c) => c.name === "claude-hook")!;
    expect(hook.status).toBe("fail");
    expect(hook.detail).toMatch(/fail-open/i);
  });

  it("detects tampered session traces", async () => {
    const home = await tmpHome();
    await writeFile(join(home, "policy.yaml"), goodPolicy);
    const sessions = join(home, "sessions");
    await mkdir(sessions);
    const trace = await TraceWriter.start(sessions);
    await trace.append({ tool: "bash", input: { command: "ls" }, decision: "allow" });
    // tamper
    const { readFile } = await import("node:fs/promises");
    const lines = (await readFile(trace.filePath, "utf8")).trim().split("\n");
    const e = JSON.parse(lines[0]!) as Record<string, unknown>;
    e.decision = "deny";
    await writeFile(trace.filePath, JSON.stringify(e) + "\n");

    const report = await runDoctor({ home, settingsPath: join(home, "settings.json"), checkPath: false });
    const traces = report.checks.find((c) => c.name === "traces")!;
    expect(traces.status).toBe("fail");
    expect(traces.detail).toMatch(/tampered|corrupt/i);
    expect(report.healthy).toBe(false);
  });

  it("passes when all traces are intact", async () => {
    const home = await tmpHome();
    await writeFile(join(home, "policy.yaml"), goodPolicy);
    const sessions = join(home, "sessions");
    await mkdir(sessions);
    const trace = await TraceWriter.start(sessions);
    await trace.append({ tool: "bash", input: { command: "ls" }, decision: "allow" });

    const report = await runDoctor({ home, settingsPath: join(home, "settings.json"), checkPath: false });
    expect(report.checks.find((c) => c.name === "traces")!.status).toBe("ok");
  });
});
