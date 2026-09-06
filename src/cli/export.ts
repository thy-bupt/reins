import { createHash } from "node:crypto";
import type { VerifyResult, TraceEvent } from "../core/trace.js";

export interface EvidenceRecord {
  schema: "reins.evidence/v1";
  agent: string;
  session_id: string;
  event_id: string;
  timestamp: string;
  tool: string;
  /** redacted by default; raw only with --no-redact */
  command: string | null;
  command_redacted: boolean;
  /** sha256 of the original (unredacted) command — keeps evidentiary value
   *  even when the command text is redacted */
  command_digest: string | null;
  file_path: string | null;
  decision: string;
  matched_rule: string | null;
  reason: string | null;
  result: string | null;
  exit_code: number | null;
  policy_digest: string | null;
  policy_drift: boolean;
  prev_hash: string;
  event_hash: string;
  /** stable machine field: ok | verified_before_break | untrusted_after_break */
  integrity_status: string;
  /** machine-readable reason slug, e.g. hash_mismatch | chain_break | seq_gap */
  integrity_reason: string | null;
  integrity_broken_at: number | null;
  generated_by: string;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [REDACTED]"],
  [/\b(?:sk|pk)-[A-Za-z0-9]{8,}/g, "[REDACTED-KEY]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED-AWS-KEY]"],
  [
    /\b(api[_-]?key|token|password|passwd|secret|authorization)\s*[=:]\s*"?[^\s"'&]{4,}/gi,
    "$1=[REDACTED]",
  ],
  [/\b(?:ghp|github_pat)_[A-Za-z0-9_]{10,}/g, "[REDACTED-GITHUB-TOKEN]"],
];

export function redactCommand(command: string): string {
  let out = command;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

function reasonSlug(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const known: Record<string, string> = {
    "hash mismatch": "hash_mismatch",
    "chain break": "chain_break",
    "seq gap": "seq_gap",
    "bad genesis": "bad_genesis",
  };
  if (known[reason]) return known[reason];
  return reason.toLowerCase().replace(/\s+/g, "_");
}

/** Stable evidence schema v1: one record per ledger event. Per-event
 *  integrity distinguishes events verified before an (optional) chain break
 *  from events after it — better forensics than one blob status. */
export function buildEvidenceRecords(
  events: TraceEvent[],
  meta: {
    sourceFile: string;
    agent: string;
    sessionId: string;
    integrity: VerifyResult;
    generatedBy: string;
    redact: boolean;
  },
): EvidenceRecord[] {
  return events.map((e, i) => {
    const input = (typeof e.input === "object" && e.input !== null ? e.input : {}) as Record<string, unknown>;
    const rawCommand = typeof input["command"] === "string" ? String(input["command"]) : null;
    const command = rawCommand === null ? null : meta.redact ? redactCommand(rawCommand) : rawCommand;

    let integrityStatus: string;
    if (meta.integrity.ok) integrityStatus = "ok";
    else if (meta.integrity.brokenAt !== undefined && i < meta.integrity.brokenAt) integrityStatus = "verified_before_break";
    else integrityStatus = "untrusted_after_break";

    return {
      schema: "reins.evidence/v1" as const,
      agent: meta.agent,
      session_id: meta.sessionId,
      event_id: e.hash,
      timestamp: e.ts,
      tool: e.tool,
      command,
      command_redacted: rawCommand !== null && command !== rawCommand,
      command_digest: rawCommand === null ? null : createHash("sha256").update(rawCommand).digest("hex"),
      file_path: typeof input["file_path"] === "string" ? String(input["file_path"]) : null,
      decision: e.decision,
      matched_rule: e.matchedRule ?? null,
      reason: e.reason ?? null,
      result: e.result ?? null,
      exit_code: e.exitCode ?? null,
      policy_digest: e.policyDigest ?? null,
      policy_drift: e.policyDrift === true,
      prev_hash: e.prevHash,
      event_hash: e.hash,
      integrity_status: integrityStatus,
      integrity_reason: meta.integrity.ok ? null : reasonSlug(meta.integrity.reason),
      integrity_broken_at: meta.integrity.ok ? null : (meta.integrity.brokenAt ?? null),
      generated_by: meta.generatedBy,
    };
  });
}

export function toNdjson(records: EvidenceRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
}

export function toJsonDocument(
  records: EvidenceRecord[],
  meta: { sourceFile: string; agent: string; sessionId: string; integrity: VerifyResult; generatedBy: string },
): string {
  const overall = meta.integrity.ok ? "ok" : "tampered";
  return (
    JSON.stringify(
      {
        schema: "reins.evidence/v1",
        source: meta.sourceFile,
        agent: meta.agent,
        session_id: meta.sessionId,
        overall_integrity: overall,
        integrity_reason: meta.integrity.ok ? null : reasonSlug(meta.integrity.reason),
        integrity_broken_at: meta.integrity.ok ? null : (meta.integrity.brokenAt ?? null),
        event_count: records.length,
        generated_by: meta.generatedBy,
        events: records,
      },
      null,
      2,
    ) + "\n"
  );
}
