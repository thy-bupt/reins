import type { TraceEvent } from "../core/trace.js";
import { summarizeEvent } from "./snapshot.js";

export interface ShowMeta {
  source: string;
  ok: boolean;
  reason?: string;
  brokenAt?: number;
}

/** Human-readable terminal rendering of a session ledger. */
export function formatTraceShow(events: TraceEvent[], meta: ShowMeta): string {
  const verdict = meta.ok
    ? "chain OK"
    : `TAMPERED (${meta.reason ?? "integrity failure"} at event ${meta.brokenAt})`;
  const lines: string[] = [];
  lines.push(`${meta.source} — ${events.length} events — ${verdict}`);
  lines.push("");
  if (events.length === 0) {
    lines.push("(empty session)");
    return lines.join("\n");
  }
  for (const e of events) {
    const seq = `#${String(e.seq).padEnd(3)}`;
    const decision = e.decision.toUpperCase().padEnd(5);
    const rule = e.matchedRule ? ` [${e.matchedRule}]` : "";
    const reason = e.reason ? ` — ${e.reason}` : "";
    lines.push(`${seq} ${e.ts} ${decision} ${e.tool.padEnd(9)} ${summarizeEvent(e)}${rule}${reason}`);
  }
  return lines.join("\n");
}
