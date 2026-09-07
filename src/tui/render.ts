import { c } from "./colors.js";
import { summarizeEvent } from "../cli/snapshot.js";
import type { TraceEvent } from "../core/trace.js";

export interface TimelineMeta {
  sourceLabel: string;
  integrityOk: boolean;
  integrityNote?: string;
  driftCount: number;
}

/** Colored, TUI-flavored timeline for a session ledger. Decision labels are
 *  color-coded (green/yellow/red), drift sessions get a banner, denied rows
 *  show the rule and reason. Pure function — safe to unit test. */
export function renderTimeline(events: TraceEvent[], meta: TimelineMeta): string {
  const verdict = meta.integrityOk
    ? c.green("✔ hash chain intact")
    : c.red(`✗ TAMPERED — ${meta.integrityNote ?? "integrity failure"}`);

  const lines: string[] = [];
  lines.push(`${c.bold("◈ " + meta.sourceLabel)}  ${c.dim(`${events.length} events`)}`);
  lines.push(verdict);
  if (meta.driftCount > 0) lines.push(c.yellow(`⚠ policy drift detected (${meta.driftCount} digest(s))`));
  lines.push("");

  if (events.length === 0) {
    lines.push(c.dim("(empty session)"));
    return lines.join("\n");
  }

  for (const e of events) {
    const { label, colorize } = c.decision(e.decision);
    const rule = e.matchedRule ? c.cyan(` [${e.matchedRule}]`) : "";
    const reason = e.reason ? c.dim(` — ${e.reason}`) : "";
    const marker = e.policyDrift ? c.yellow(" ⚠drift") : "";
    lines.push(
      `${c.bold(`#${String(e.seq)}`)} ${c.dim(e.ts.slice(11, 19))} ${colorize(label)} ${c.cyan(e.tool.padEnd(9))} ${summarizeEvent(e)}${rule}${reason}${marker}`,
    );
  }
  return lines.join("\n");
}

/** Full event detail card for the drill-in view. */
export function renderEventDetail(e: TraceEvent): string {
  const { label, colorize } = c.decision(e.decision);
  const rows: string[] = [
    `timestamp    ${e.ts}`,
    `tool         ${e.tool}`,
    `decision     ${colorize(label)}`,
    `matched rule ${e.matchedRule ?? c.dim("(policy default)")}`,
    `reason       ${e.reason ?? c.dim("—")}`,
    `result       ${e.result ?? "—"}`,
    `exit code    ${e.exitCode ?? "—"}`,
    `policy       ${e.policyDigest ? c.cyan(e.policyDigest.slice(0, 16) + "…") : c.dim("(not anchored)")}`,
  ];
  if (e.policyDrift) rows.push(c.yellow("policy drift  yes — policy changed mid-session"));
  const input = (typeof e.input === "object" && e.input !== null ? e.input : {}) as Record<string, unknown>;
  if (typeof input["command"] === "string") rows.push(`command      ${input["command"]}`);
  if (typeof input["file_path"] === "string") rows.push(`file         ${input["file_path"]}`);
  rows.push(`event hash   ${c.dim(e.hash.slice(0, 24) + "…")}`);
  return rows.join("\n");
}
