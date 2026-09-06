import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createToolHandlers } from "../src/mcp/tools.js";
import { TraceWriter } from "../src/core/trace.js";
import { installSkill, uninstallSkill, skillInstalled } from "../src/skills/installer.js";

async function setupWithSessions() {
  const home = await mkdtemp(join(tmpdir(), "reins-mcp-"));
  const sessions = join(home, "sessions");
  const policyPath = join(home, "policy.yaml");
  await writeFile(policyPath, "version: 1\ndefault: allow\nrules: []\n");

  const writer = await TraceWriter.open(join(sessions, "claude-mcp-demo.jsonl"));
  await writer.append({ tool: "Bash", input: { command: "ls" }, decision: "allow", result: "ok", exitCode: 0 });
  await writer.append({
    tool: "Bash",
    input: { command: "rm -rf /" },
    decision: "deny",
    matchedRule: "rm-recursive",
    reason: "destructive",
    result: "blocked",
    exitCode: 2,
  });
  return { home, sessions, policyPath };
}

describe("mcp tool handlers (read-only surface)", () => {
  it("check_command previews a denial without executing anything", async () => {
    const { home, policyPath } = await setupWithSessions();
    await writeFile(
      policyPath,
      `version: 1\ndefault: allow\nrules:\n  - id: rm-recursive\n    kind: command\n    action: deny\n    program: rm\n    flags: ["-r"]\n    reason: destructive\n`,
    );
    const handlers = createToolHandlers({ policyPath, sessionsDir: join(home, "sessions") });
    const out = handlers.check_command({ command: "rm -rf /tmp/x" });
    expect(out.decision).toBe("deny");
    expect(out.matchedRule).toBe("rm-recursive");
    expect(out.note).toContain("do not retry");
  });

  it("recent_decisions returns newest-first ledger entries", async () => {
    const { home, policyPath } = await setupWithSessions();
    const handlers = createToolHandlers({ policyPath, sessionsDir: join(home, "sessions") });
    const out = await handlers.recent_decisions({ limit: 10 });
    expect(out.decisions).toHaveLength(2);
    expect(out.decisions[0]).toMatchObject({ decision: "deny", matchedRule: "rm-recursive", agent: "claude" });
  });

  it("recent_decisions filters by verdict", async () => {
    const { home, policyPath } = await setupWithSessions();
    const handlers = createToolHandlers({ policyPath, sessionsDir: join(home, "sessions") });
    const out = await handlers.recent_decisions({ verdict: "deny" });
    expect(out.decisions).toHaveLength(1);
    expect(out.decisions[0]!.decision).toBe("deny");
  });

  it("policy_summary lists rules; stats aggregates with integrity", async () => {
    const { home, policyPath } = await setupWithSessions();
    const handlers = createToolHandlers({ policyPath, sessionsDir: join(home, "sessions") });

    const summary = await handlers.policy_summary();
    expect(summary.default).toBe("allow");

    const stats = await handlers.stats();
    expect(stats).toMatchObject({ sessions: 1, events: 2, allow: 1, deny: 1, tamperedSessions: 0 });
  });
});

describe("skills installer", () => {
  it("installs bundled skills and reports installed state", async () => {
    const base = await mkdtemp(join(tmpdir(), "reins-skills-"));
    await installSkill("reins-selfcheck", base);
    expect(await skillInstalled("reins-selfcheck", base)).toBe(true);

    const content = await readFile(join(base, "reins-selfcheck", "SKILL.md"), "utf8");
    expect(content.startsWith("---")).toBe(true);
    expect(content).toContain("name: reins-selfcheck");
    expect(content).toContain("policy eval");

    await installSkill("reins-incident", base);
    expect(await skillInstalled("reins-incident", base)).toBe(true);
  });

  it("is idempotent", async () => {
    const base = await mkdtemp(join(tmpdir(), "reins-skills-"));
    const first = await installSkill("reins-selfcheck", base);
    const second = await installSkill("reins-selfcheck", base);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
  });

  it("uninstall removes ours but never a repurposed skill", async () => {
    const base = await mkdtemp(join(tmpdir(), "reins-skills-"));
    await installSkill("reins-selfcheck", base);
    expect((await uninstallSkill("reins-selfcheck", base)).removed).toBe(true);
    expect(await skillInstalled("reins-selfcheck", base)).toBe(false);

    // user rewrites the file with their own content
    await mkdir(join(base, "reins-selfcheck"), { recursive: true });
    await writeFile(join(base, "reins-selfcheck", "SKILL.md"), "# my own notes\n");
    const result = await uninstallSkill("reins-selfcheck", base);
    expect(result.removed).toBe(false);
    expect(result.reason).toMatch(/not a reins-generated skill/i);
    expect(existsSync(join(base, "reins-selfcheck", "SKILL.md"))).toBe(true);
  });
});
