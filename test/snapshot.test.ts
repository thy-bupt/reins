import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSnapshotMarkdown, collectGitContext, type SnapshotData } from "../src/cli/snapshot.js";

// git is optional on a given machine (the feature degrades to "no git context");
// the real-repo integration tests only run where git exists on PATH
const GIT_OK = spawnSync("git", ["--version"]).status === 0;
import { GENESIS_HASH, type TraceEvent } from "../src/core/trace.js";

function event(partial: Partial<TraceEvent> & { seq: number }): TraceEvent {
  return {
    ts: "2026-09-06T10:00:00Z",
    tool: "Bash",
    input: { command: "ls" },
    decision: "allow",
    prevHash: GENESIS_HASH,
    hash: "deadbeef",
    ...partial,
  } as TraceEvent;
}

function baseData(events: TraceEvent[], over: Partial<SnapshotData> = {}): SnapshotData {
  return {
    sourceFile: "sessions/claude-smoke.jsonl",
    agent: "claude",
    sessionId: "smoke",
    eventCount: events.length,
    timeRange: { first: events[0]?.ts, last: events[events.length - 1]?.ts },
    integrity: { ok: true, events: events.length },
    policy: { name: "reins-default", rules: 13, sha256: "abc123", source: "~/.reins/policy.yaml" },
    git: null,
    denied: events.filter((e) => e.decision === "deny"),
    allowed: events.filter((e) => e.decision !== "deny"),
    fileWrites: events.filter((e) => typeof (e.input as Record<string, unknown>)?.["file_path"] === "string"),
    generatedAt: "2026-09-06T12:00:00Z",
    ...over,
  };
}

describe("buildSnapshotMarkdown", () => {
  it("renders header, integrity verdict, policy hash and the full timeline", () => {
    const events = [
      event({ seq: 0, tool: "Bash", input: { command: "ls -la" }, decision: "allow", result: "ok", exitCode: 0 }),
      event({
        seq: 1,
        tool: "Bash",
        input: { command: "rm -rf /tmp/x" },
        decision: "deny",
        reason: "Recursive deletion is destructive",
        matchedRule: "rm-recursive",
        result: "blocked",
        exitCode: 2,
      }),
      event({ seq: 2, tool: "Write", input: { file_path: "/repo/src/a.ts" }, decision: "allow", result: "ok" }),
    ];
    const md = buildSnapshotMarkdown(baseData(events));

    expect(md).toContain("# reins operation snapshot");
    expect(md).toContain("claude-smoke.jsonl");
    expect(md).toContain("hash chain: OK");
    expect(md).toContain("abc123");
    expect(md).toContain("rm-recursive");
    expect(md).toContain("Recursive deletion is destructive");
    expect(md).toContain("/repo/src/a.ts");
    expect(md).toContain("| 0 |"); // timeline row for seq 0
    expect(md).toContain("| 1 |");
  });

  it("prominently flags a tampered trace instead of refusing (forensics over comfort)", () => {
    const md = buildSnapshotMarkdown(
      baseData([event({ seq: 0 })], {
        integrity: { ok: false, events: 3, brokenAt: 1, reason: "hash mismatch" },
      }),
    );
    expect(md).toMatch(/TAMPERED/i);
    expect(md).toContain("hash mismatch");
    expect(md).toContain("event 1");
  });

  it("adds git recovery hints for file writes and history-rewrite commands", () => {
    const events = [
      event({ seq: 0, tool: "Write", input: { file_path: "/repo/src/a.ts" }, decision: "allow" }),
      event({
        seq: 1,
        tool: "Bash",
        input: { command: "git push --force" },
        decision: "allow",
        matchedRule: "git-force-push-allowed-by-override",
      }),
    ];
    const md = buildSnapshotMarkdown(
      baseData(events, {
        git: { repoRoot: "/repo", head: "abc1234", subject: "init", dirty: [" M src/a.ts"], diffs: {} },
      }),
    );
    expect(md).toContain("git restore");
    expect(md).toContain("/repo/src/a.ts");
    expect(md).toContain("reflog"); // history-rewrite recovery hint
    expect(md).toContain("abc1234");
    expect(md).toContain("M src/a.ts");
  });

  it("renders a no-git-context section when events are outside any repo", () => {
    const md = buildSnapshotMarkdown(baseData([event({ seq: 0 })], { git: null }));
    expect(md).toContain("no git context");
  });
});

describe.skipIf(!GIT_OK)("collectGitContext (real git repo)", () => {
  it("captures repo root, HEAD, subject and dirty files", async () => {
    const repo = await mkdtemp(join(tmpdir(), "reins-snap-repo-"));
    const run = (cmd: string) => spawnSync("git", cmd.split(" "), { cwd: repo });
    run("init -b main");
    await writeFile(join(repo, "a.ts"), "original\n");
    run("add .");
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init commit"], { cwd: repo });

    // agent modifies the file after the commit
    await writeFile(join(repo, "a.ts"), "agent was here\n");

    const ctx = await collectGitContext([join(repo, "a.ts")], false);
    expect(ctx).not.toBeNull();
    expect(realpathSync(ctx!.repoRoot)).toBe(realpathSync(repo)); // macOS /tmp is a symlink
    expect(ctx!.subject).toBe("init commit");
    expect(ctx!.dirty.join("\n")).toContain("a.ts");

    const head = ctx!.head;
    expect(head).toHaveLength(40);

    // diffs on demand
    const withDiff = await collectGitContext([join(repo, "a.ts")], true);
    expect(withDiff!.diffs?.["a.ts"]).toContain("agent was here");
    expect(withDiff!.head).toBe(head);
  });

  it("returns null when no path lives inside a git repo", async () => {
    const plain = await mkdtemp(join(tmpdir(), "reins-snap-plain-"));
    await mkdir(join(plain, "src"), { recursive: true });
    const ctx = await collectGitContext([join(plain, "src", "a.ts")], false);
    expect(ctx).toBeNull();
  });
});

describe("snapshot data assembly", () => {
  it("derives agent and session id from the trace filename", async () => {
    const { deriveAgentAndSession } = await import("../src/cli/snapshot.js");
    const { agent, sessionId } = deriveAgentAndSession("/home/x/.reins/sessions/grok-2026-09-06T05-22-04-508Z-439391.jsonl");
    expect(agent).toBe("grok");
    expect(sessionId).toBe("2026-09-06T05-22-04-508Z-439391");
  });

  it("reads back a written snapshot report file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-snap-out-"));
    const outPath = join(dir, "report.md");
    const md = buildSnapshotMarkdown(baseData([event({ seq: 0 })]));
    await writeFile(outPath, md);
    expect((await readFile(outPath, "utf8"))).toContain("# reins operation snapshot");
  });
});
