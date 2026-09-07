import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/cli/doctor.js";

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
  return mkdtemp(join(tmpdir(), "reins-projdoc-"));
}

async function healthyBase(home: string) {
  await writeFile(join(home, "policy.yaml"), goodPolicy);
  await mkdir(join(home, "sessions"), { recursive: true });
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(join(home, "settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "reins hook claude" }] }] },
  }));
  return join(home, "settings.json");
}

describe("doctor project-scope check (round-4 real-incident follow-up)", () => {
  it("ok when the project's Claude settings carry the reins hook", async () => {
    const home = await tmpHome();
    const settingsPath = await healthyBase(home);
    const project = await tmpHome();
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "reins hook claude" }] }] },
    }));

    const report = await runDoctor({
      home,
      settingsPath,
      checkPath: false,
      agentPaths: {},
      projectDir: project,
    });
    const proj = report.checks.find((c) => c.name === "project-hook")!;
    expect(proj.status).toBe("ok");
    expect(report.healthy).toBe(true);
  });

  it("warns when the project has Claude settings but no reins hook", async () => {
    const home = await tmpHome();
    const settingsPath = await healthyBase(home);
    const project = await tmpHome();
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ model: "x" }));

    const report = await runDoctor({
      home,
      settingsPath,
      checkPath: false,
      agentPaths: {},
      projectDir: project,
    });
    const proj = report.checks.find((c) => c.name === "project-hook")!;
    expect(proj.status).toBe("warn");
    expect(proj.detail).toContain("unrecorded");
    expect(report.healthy).toBe(true); // advisory, not a fail
  });

  it("warns when the project has a .claude dir without settings.json", async () => {
    const home = await tmpHome();
    const settingsPath = await healthyBase(home);
    const project = await tmpHome();
    mkdirSync(join(project, ".claude"), { recursive: true });

    const report = await runDoctor({
      home,
      settingsPath,
      checkPath: false,
      agentPaths: {},
      projectDir: project,
    });
    const proj = report.checks.find((c) => c.name === "project-hook")!;
    expect(proj.status).toBe("warn");
    expect(proj.detail).toContain("no settings.json");
  });

  it("skips the project check when projectDir is omitted", async () => {
    const home = await tmpHome();
    const settingsPath = await healthyBase(home);
    const report = await runDoctor({ home, settingsPath, checkPath: false });
    expect(report.checks.find((c) => c.name === "project-hook")).toBeUndefined();
  });
});
