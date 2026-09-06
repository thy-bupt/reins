import { describe, expect, it } from "vitest";
import { replaySession, type ReplayableEvent } from "../src/cli/replay.js";
import { loadPolicy } from "../src/core/policy.js";

const strictPolicy = loadPolicy(`
version: 1
default: deny
rules:
  - id: allow-ls
    kind: command
    action: allow
    program: ls
    reason: "listing is fine"
`);

const lenientPolicy = loadPolicy(`
version: 1
default: allow
rules:
  - id: rm-recursive
    kind: command
    action: deny
    program: rm
    flags: ["-r"]
    reason: destructive
  - id: protect-env
    kind: path
    action: deny
    path: "**/.env*"
    reason: secrets
`);

function event(seq: number, command: string, decision: "allow" | "deny" | "ask" = "allow"): ReplayableEvent {
  return {
    seq,
    ts: "2026-09-06T00:00:00Z",
    tool: "Bash",
    input: { command },
    decision,
  };
}

describe("replaySession", () => {
  it("reports which past events a new policy would block", () => {
    const events = [event(0, "ls -la"), event(1, "rm -rf /tmp/x"), event(2, "npm test")];
    const report = replaySession(events, lenientPolicy);

    expect(report.reviewed).toBe(3);
    expect(report.wouldBlock).toHaveLength(1);
    expect(report.wouldBlock[0]).toMatchObject({ seq: 1, matchedRule: "rm-recursive" });
    expect(report.wouldChange).toHaveLength(1);
    expect(report.wouldChange[0]!.from).toBe("allow");
    expect(report.wouldChange[0]!.to).toBe("deny");
  });

  it("under a stricter default-deny policy, only explicitly allowed commands survive", () => {
    const events = [event(0, "ls -la"), event(1, "cargo build"), event(2, "npm test")];
    const report = replaySession(events, strictPolicy);

    expect(report.reviewed).toBe(3);
    expect(report.wouldBlock).toHaveLength(2);
    expect(report.wouldAllow.map((a) => a.seq)).toEqual([0]);
  });

  it("skips events without decisions to replay (no command / no path)", () => {
    const events: ReplayableEvent[] = [
      event(0, "ls"),
      { seq: 1, ts: "t", tool: "Other", input: { weird: true }, decision: "allow" },
    ];
    const report = replaySession(events, strictPolicy);
    expect(report.reviewed).toBe(1);
    expect(report.skipped).toBe(1);
  });

  it("counts already-blocked events separately from would-block", () => {
    const events = [event(0, "rm -rf /", "deny"), event(1, "rm -rf /tmp")];
    const report = replaySession(events, lenientPolicy);
    expect(report.alreadyBlocked).toHaveLength(1);
    expect(report.wouldBlock.map((b) => b.seq)).toEqual([1]);
  });

  it("replays path events too", () => {
    const events: ReplayableEvent[] = [
      { seq: 0, ts: "t", tool: "Write", input: { file_path: "/repo/.env" }, decision: "allow" },
    ];
    const report = replaySession(events, lenientPolicy);
    expect(report.wouldBlock).toHaveLength(1);
    expect(report.wouldBlock[0]!.matchedRule).toBe("protect-env");
  });
});
