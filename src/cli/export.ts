import type { VerifyResult, TraceEvent } from "../core/trace.js";

export interface EvidenceRecord {
  schema: "reins.evidence/v1";
  agent: string;
  session_id: string;
  event_id: string;
  timestamp: string;
  tool: string;
  command: string | null;
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
  integrity_status: string;
  generated_by: string;
}

/** Stable evidence schema v1: one record per ledger event, ready for NDJSON
 *  / JSON export, CI artifacts or SIEM ingestion. */
export function buildEvidenceRecords(
  events: TraceEvent[],
  meta: {
    sourceFile: string;
    agent: string;
    sessionId: string;
    integrity: VerifyResult;
    generatedBy: string;
  },
): EvidenceRecord[] {
  const status = meta.integrity.ok
    ? "ok"
    : `tampered: ${meta.integrity.reason ?? "integrity failure"} at event ${meta.integrity.brokenAt}`;

  return events.map((e) => {
    const input = (typeof e.input === "object" && e.input !== null ? e.input : {}) as Record<string, unknown>;
    return {
      schema: "reins.evidence/v1" as const,
      agent: meta.agent,
      session_id: meta.sessionId,
      event_id: e.hash,
      timestamp: e.ts,
      tool: e.tool,
      command: typeof input["command"] === "string" ? String(input["command"]) : null,
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
      integrity_status: status,
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
  return (
    JSON.stringify(
      {
        schema: "reins.evidence/v1",
        source: meta.sourceFile,
        agent: meta.agent,
        session_id: meta.sessionId,
        integrity_status: meta.integrity.ok
          ? "ok"
          : `tampered: ${meta.integrity.reason ?? "integrity failure"} at event ${meta.integrity.brokenAt}`,
        event_count: records.length,
        generated_by: meta.generatedBy,
        events: records,
      },
      null,
      2,
    ) + "\n"
  );
}
