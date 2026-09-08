import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildEvidenceRecords, redactCommand } from "../src/cli/export.js";
import { GENESIS_HASH, type TraceEvent } from "../src/core/trace.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist", "cli", "main.js");
const cli = existsSync(DIST);

// fixture keys assembled at runtime (never literal credentials in source)
const FAKE_AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
const FAKE_GH_TOKEN = "ghp_" + "abcdefghij12345";
const FAKE_BEARER = "Bearer " + "abc123def";
const FAKE_SK = "sk-" + "secret12345";

function event(seq: number, over: Partial<TraceEvent> = {}): TraceEvent {
  return {
    ts: "2026-09-07T00:00:00Z",
    tool: "Bash",
    input: { command: "ls" },
    decision: "allow",
    prevHash: seq === 0 ? GENESIS_HASH : "prev",
    hash: `hash-${seq}`,
    ...over,
  } as TraceEvent;
}

describe("redactCommand", () => {
  it("redacts bearer tokens, api keys, AWS keys and password params", () => {
    const out = redactCommand(
      `curl -H "Authorization: ${FAKE_BEARER}" https://x -d api_key=${FAKE_SK} --token ttt1234567`,
    );
    expect(out).not.toContain("abc123def");
    expect(out).not.toContain(FAKE_SK);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts GitHub tokens and AWS access keys", () => {
    expect(redactCommand(`git clone https://${FAKE_GH_TOKEN}@x`)).not.toContain(FAKE_GH_TOKEN);
    expect(redactCommand(`aws s3 ls --keys ${FAKE_AWS_KEY}`)).not.toContain(FAKE_AWS_KEY);
  });

  it("leaves innocent commands untouched", () => {
    expect(redactCommand("npm test")).toBe("npm test");
    expect(redactCommand("ls -la")).toBe("ls -la");
  });

  it("redacts single-quoted secrets (round-6 Codex finding)", () => {
    // round-6 finding: single-quoted key=value secrets were not redacted
    // (the regex only allowed a double-quoted value). Build a test secret
    // from fragments so it is clearly a placeholder, never a real credential.
    const secret = "v0f" + "a1k9" + "q2zz";
    const out = redactCommand(
      `curl -d "password='${secret}'" https://x && export token='${secret}' && echo api_key='${secret}'`,
    );
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  });
});

describe("buildEvidenceRecords integrity semantics (Codex finding 4.3)", () => {
  const events = [
    event(0, { hash: "h0" }),
    event(1, { prevHash: "h0", hash: "h1" }),
    event(2, { prevHash: "h1", hash: "h2" }),
  ];

  it("marks all events ok on an intact chain", () => {
    const records = buildEvidenceRecords(events, {
      sourceFile: "s.jsonl",
      agent: "claude",
      sessionId: "x",
      integrity: { ok: true, events: 3 },
      generatedBy: "reins/test",
      redact: true,
    });
    for (const r of records) {
      expect(r.integrity_status).toBe("ok");
      expect(r.integrity_reason).toBeNull();
      expect(r.integrity_broken_at).toBeNull();
    }
  });

  it("splits verified_before_break from untrusted_after_break", () => {
    const records = buildEvidenceRecords(events, {
      sourceFile: "s.jsonl",
      agent: "claude",
      sessionId: "x",
      integrity: { ok: false, events: 3, brokenAt: 1, reason: "hash mismatch" },
      generatedBy: "reins/test",
      redact: true,
    });
    expect(records[0]!.integrity_status).toBe("verified_before_break");
    expect(records[1]!.integrity_status).toBe("untrusted_after_break");
    expect(records[2]!.integrity_status).toBe("untrusted_after_break");
    expect(records[1]!.integrity_reason).toBe("hash_mismatch");
    expect(records[1]!.integrity_broken_at).toBe(1);
  });
});

describe("buildEvidenceRecords command redaction + digest (Codex finding 4.4)", () => {
  const secretEvent = event(0, { input: { command: `curl -H "Authorization: ${FAKE_BEARER}" https://x` } });

  it("redacts by default but keeps a digest of the original", () => {
    const [r] = buildEvidenceRecords([secretEvent], {
      sourceFile: "s.jsonl",
      agent: "claude",
      sessionId: "x",
      integrity: { ok: true, events: 1 },
      generatedBy: "reins/test",
      redact: true,
    });
    expect(r!.command).not.toContain("abc123def");
    expect(r!.command_redacted).toBe(true);
    expect(r!.command_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("exports the raw command with --no-redact (digest unchanged)", () => {
    const [r] = buildEvidenceRecords([secretEvent], {
      sourceFile: "s.jsonl",
      agent: "claude",
      sessionId: "x",
      integrity: { ok: true, events: 1 },
      generatedBy: "reins/test",
      redact: false,
    });
    expect(r!.command).toContain("abc123def");
    expect(r!.command_redacted).toBe(false);
  });
});

describe("policy digest fields (Codex finding 4.1)", () => {
  it("records policy_digest and policy_drift; legacy events export with nulls", () => {
    const [legacy, anchored] = buildEvidenceRecords(
      [
        event(0), // legacy: no digest
        event(1, { policyDigest: "digest-A" }),
      ],
      {
        sourceFile: "s.jsonl",
        agent: "claude",
        sessionId: "x",
        integrity: { ok: true, events: 2 },
        generatedBy: "reins/test",
        redact: true,
      },
    );
    expect(legacy!.policy_digest).toBeNull();
    expect(legacy!.policy_drift).toBe(false);
    expect(anchored!.policy_digest).toBe("digest-A");
    expect(anchored!.policy_drift).toBe(false);
  });
});

describe.skipIf(!cli)("trace export e2e", () => {
  it("fails closed on an invalid --format", () => {
    const h = mkdtempSync();
    const r = spawnSync(process.execPath, [DIST, "trace", "export", "--format", "nope"], {
      env: { ...process.env, REINS_HOME: h },
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unsupported --format");
  });

  it("exports ndjson with per-event integrity and redaction", async () => {
    const h = mkdtempSync();
    writeFileSync(join(h, "policy.yaml"), "version: 1\ndefault: allow\nrules: []\n");
    const payload = JSON.stringify({
      session_id: "exp",
      tool_name: "Bash",
      tool_input: { command: `curl -H "Authorization: ${FAKE_BEARER}" https://x` },
    });
    spawnSync(process.execPath, [DIST, "hook", "claude"], {
      env: { ...process.env, REINS_HOME: h },
      input: payload,
      encoding: "utf8",
    });

    const out = join(h, "evidence.ndjson");
    const r = spawnSync(process.execPath, [DIST, "trace", "export", "--format", "ndjson", "--out", out], {
      env: { ...process.env, REINS_HOME: h },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);

    const records = (await readFile(out, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(records[0]!.schema).toBe("reins.evidence/v1");
    expect(records[0]!.integrity_status).toBe("ok");
    expect(records[0]!.command).not.toContain("abc123def");
    expect(records[0]!.command_redacted).toBe(true);
  });

  it("exits non-zero and flags tampered status when the ledger was modified", async () => {
    const h = mkdtempSync();
    writeFileSync(join(h, "policy.yaml"), "version: 1\ndefault: allow\nrules: []\n");
    spawnSync(process.execPath, [DIST, "hook", "claude"], {
      env: { ...process.env, REINS_HOME: h },
      input: JSON.stringify({ session_id: "tamper", tool_name: "Bash", tool_input: { command: "ls" } }),
      encoding: "utf8",
    });
    const traceFile = join(h, "sessions", "claude-tamper.jsonl");
    const lines = (await readFile(traceFile, "utf8")).trim().split("\n");
    const e = JSON.parse(lines[0]!) as Record<string, unknown>;
    e["decision"] = "deny";
    writeFileSync(traceFile, JSON.stringify(e) + "\n");

    const r = spawnSync(process.execPath, [DIST, "trace", "export", "--format", "json"], {
      env: { ...process.env, REINS_HOME: h },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    const doc = JSON.parse(r.stdout) as { overall_integrity: string; events: Array<{ integrity_status: string }> };
    expect(doc.overall_integrity).toBe("tampered");
    expect(doc.events[0]!.integrity_status).toBe("untrusted_after_break");
  });
});

function mkdtempSync(): string {
  const dir = join(tmpdir(), `reins-exp-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
