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
  return mkdtemp(join(tmpdir(), "reins-doctor-"));
}

describe("runDoctor", () => {
  it("reports healthy for a fully installed rail", async () => {
    const home = await tmpHome();
    await writeFile(join(home, "policy.yaml"), goodPolicy);
    await mkdir(join(home, "sessions"));
    const settingsPath = join(home, "settings.json");
    await writeFile(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: "reins hook claude" }] }] },
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

  it("reports per-agent install status without failing on optional agents", async () => {
    const home = await tmpHome();
    await writeFile(join(home, "policy.yaml"), goodPolicy);
    await mkdir(join(home, "sessions"));

    const agentDir = await tmpHome();
    const agentPaths = {
      gemini: join(agentDir, "gemini-settings.json"),
      grok: join(agentDir, join(".grok", "hooks", "reins.json")),
      codexHooks: join(agentDir, join(".codex", "hooks.json")),
      codexConfig: join(agentDir, join(".codex", "config.toml")),
      opencode: join(agentDir, "reins.js"),
      pi: join(agentDir, "reins.ts"),
    };

    // nothing installed yet → warns, but doctor stays healthy
    // (the primary claude hook must be installed for healthy=true)
    const claudeSettings = join(home, "settings.json");
    await writeFile(claudeSettings, JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "reins hook claude" }] }] },
    }));
    const none = await runDoctor({ home, settingsPath: claudeSettings, checkPath: false, agentPaths });
    for (const name of ["agent:gemini", "agent:grok", "agent:codex", "agent:opencode", "agent:pi"]) {
      expect(none.checks.find((c) => c.name === name)!.status).toBe("warn");
    }
    expect(none.healthy).toBe(true);

    // install everything → all ok
    await writeFile(agentPaths.gemini!, JSON.stringify({
      hooks: { BeforeTool: [{ matcher: "x", hooks: [{ type: "command", command: "reins hook gemini" }] }] },
    }));
    await mkdir(join(agentDir, ".grok", "hooks"), { recursive: true });
    await writeFile(agentPaths.grok!, JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "reins hook grok" }] }] },
    }));
    await mkdir(join(agentDir, ".codex"), { recursive: true });
    await writeFile(agentPaths.codexHooks!, JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "reins hook codex" }] }] },
    }));
    await writeFile(agentPaths.codexConfig!, "[features]\nhooks = true\n");
    await writeFile(agentPaths.opencode!, "// reins\ntool.execute.before\nreins hook opencode\n");
    await writeFile(agentPaths.pi!, "pi.on('tool_call', ...) block: true reins hook pi\n");

    const all = await runDoctor({ home, settingsPath: join(home, "settings.json"), checkPath: false, agentPaths });
    for (const name of ["agent:gemini", "agent:grok", "agent:codex", "agent:opencode", "agent:pi"]) {
      expect(all.checks.find((c) => c.name === name)!.status).toBe("ok");
    }
  });

  it("warns when codex hooks.json exists but the config.toml feature flag is missing", async () => {
    const home = await tmpHome();
    await writeFile(join(home, "policy.yaml"), goodPolicy);
    const agentDir = await tmpHome();
    await writeFile(join(agentDir, "hooks.json"), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "reins hook codex" }] }] },
    }));

    const report = await runDoctor({
      home,
      settingsPath: join(home, "settings.json"),
      checkPath: false,
      agentPaths: { codexHooks: join(agentDir, "hooks.json"), codexConfig: join(agentDir, "config.toml") },
    });
    const codex = report.checks.find((c) => c.name === "agent:codex")!;
    expect(codex.status).toBe("warn");
    expect(codex.detail).toMatch(/feature flag (is )?missing/i);
  });
});
