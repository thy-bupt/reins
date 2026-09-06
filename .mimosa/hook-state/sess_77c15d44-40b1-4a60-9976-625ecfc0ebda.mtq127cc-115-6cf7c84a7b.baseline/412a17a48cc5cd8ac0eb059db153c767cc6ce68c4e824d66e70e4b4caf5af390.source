import { describe, expect, it } from "vitest";
import { GENESIS_HASH, type TraceEvent } from "../src/core/trace.js";
import { formatTraceShow } from "../src/cli/show.js";

function event(partial: Partial<TraceEvent> & { seq: number }): TraceEvent {
  return {
    ts: "2026-09-06T05:53:22.705Z",
    tool: "Bash",
    input: { command: "ls" },
    decision: "allow",
    prevHash: GENESIS_HASH,
    hash: "deadbeef",
    ...partial,
  } as TraceEvent;
}

describe("formatTraceShow", () => {
  it("renders a header with counts and one line per event", () => {
    const events = [
      event({ seq: 0, input: { command: "ls -la" }, decision: "allow", result: "ok", exitCode: 0 }),
      event({
        seq: 1,
        input: { command: "rm -rf /tmp/x" },
        decision: "deny",
        matchedRule: "rm-recursive",
        reason: "Recursive deletion is destructive",
        result: "blocked",
        exitCode: 2,
      }),
    ];
    const out = formatTraceShow(events, { source: "sessions/claude-demo.jsonl", ok: true });

    expect(out).toContain("claude-demo.jsonl");
    expect(out).toContain("2 events");
    expect(out).toContain("chain OK");
    expect(out).toContain("#0");
    expect(out).toContain("#1");
    expect(out).toContain("ls -la");
    expect(out).toContain("rm-recursive");
    expect(out).toContain("Recursive deletion is destructive");
    expect(out).toContain("DENY");
  });

  it("marks the chain as TAMPERED when verification failed", () => {
    const out = formatTraceShow([event({ seq: 0 })], {
      source: "x.jsonl",
      ok: false,
      reason: "hash mismatch",
      brokenAt: 0,
    });
    expect(out).toContain("TAMPERED");
    expect(out).toContain("hash mismatch");
  });

  it("shows file paths for file tools and ask decisions", () => {
    const events = [
      event({ seq: 0, tool: "Write", input: { file_path: "/repo/.env" }, decision: "deny", result: "blocked" }),
      event({ seq: 1, input: { command: "git push --force" }, decision: "ask", reason: "rewrites history" }),
    ];
    const out = formatTraceShow(events, { source: "x.jsonl", ok: true });
    expect(out).toContain("/repo/.env");
    expect(out).toContain("ASK");
    expect(out).toContain("rewrites history");
  });

  it("handles an empty session", () => {
    const out = formatTraceShow([], { source: "empty.jsonl", ok: true });
    expect(out).toContain("0 events");
    expect(out).toContain("empty session");
  });
});
