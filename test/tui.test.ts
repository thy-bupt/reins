import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { resetColorCache, c } from "../src/tui/colors.js";
import { renderTimeline, renderEventDetail } from "../src/tui/render.js";
import { strings } from "../src/tui/i18n.js";
import { GENESIS_HASH, type TraceEvent } from "../src/core/trace.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist", "cli", "main.js");
const cli = existsSync(DIST);

function event(seq: number, over: Partial<TraceEvent> = {}): TraceEvent {
  return {
    seq,
    ts: "2026-09-07T10:00:00Z",
    tool: "Bash",
    input: { command: "ls" },
    decision: "allow",
    prevHash: seq === 0 ? GENESIS_HASH : "prev",
    hash: `hash-${seq}`,
    ...over,
  } as TraceEvent;
}

beforeEach(() => {
  resetColorCache();
});

describe("colors (TTY/NO_COLOR degradation)", () => {
  it("emits ANSI codes when TTY and colors enabled", () => {
    process.stdout.isTTY = true;
    delete process.env["NO_COLOR"];
    resetColorCache();
    expect(c.red("x")).toContain("\x1b[31m");
  });

  it("degrades to plain text under NO_COLOR", () => {
    process.stdout.isTTY = true;
    process.env["NO_COLOR"] = "1";
    resetColorCache();
    expect(c.red("x")).toBe("x");
  });

  it("degrades on non-TTY stdout", () => {
    process.stdout.isTTY = false;
    delete process.env["NO_COLOR"];
    resetColorCache();
    expect(c.green("x")).toBe("x");
  });
});

describe("renderTimeline (colored, TUI-flavored)", () => {
  const events = [
    event(0, { input: { command: "ls -la" }, decision: "allow", result: "ok", exitCode: 0 }),
    event(1, {
      input: { command: "rm -rf /tmp/x" },
      decision: "deny",
      matchedRule: "rm-recursive",
      reason: "recursive deletion is destructive",
      result: "blocked",
      exitCode: 2,
    }),
  ];

  it("shows integrity verdict, drift warning, decisions with rules", () => {
    const out = renderTimeline(events, {
      sourceLabel: "claude-demo.jsonl",
      integrityOk: true,
      driftCount: 0,
      strings: strings("en"),
    });
    expect(out).toContain("claude-demo.jsonl");
    expect(out).toContain("hash chain intact");
    expect(out).toContain("ALLOW");
    expect(out).toContain("DENY");
    expect(out).toContain("[rm-recursive]");
    expect(out).toContain("#0");
  });

  it("flags a tampered ledger prominently", () => {
    const out = renderTimeline([event(0)], {
      sourceLabel: "x.jsonl",
      integrityOk: false,
      integrityNote: "hash mismatch",
      driftCount: 0,
      strings: strings("en"),
    });
    expect(out).toContain("TAMPERED");
    expect(out).toContain("hash mismatch");
  });

  it("renders event detail card with policy digest state", () => {
    const out = renderEventDetail(
      event(0, { policyDigest: "abcd1234", matchedRule: "rm-recursive", decision: "deny", reason: "destructive" }),
      strings("en"),
    );
    expect(out).toContain("decision");
    expect(out).toContain("rm-recursive");
    expect(out).toContain("abcd1234");
  });
});


describe.skipIf(!cli)("reins ui non-TTY fallback (e2e)", () => {
  it("falls back to a plain hint and exits 0 on piped stdout", () => {
    const h = join(tmpdir(), `reins-ui-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(h, "sessions"), { recursive: true, mode: 0o700 });
    const r = spawnSync(process.execPath, [DIST, "ui"], {
      env: { ...process.env, REINS_HOME: h },
      input: "",
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no sessions");
  });
});
