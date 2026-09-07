import { c } from "./colors.js";
import type { UiStrings } from "./i18n.js";
import { summarizeEvent } from "../cli/snapshot.js";
import type { TraceEvent } from "../core/trace.js";

export interface TimelineMeta {
  sourceLabel: string;
  integrityOk: boolean;
  integrityNote?: string;
  driftCount: number;
  strings: UiStrings;
}

/** Colored, TUI-flavored timeline. Decision labels are color-coded
 *  (green/yellow/red), drift sessions get a banner. Pure function. */
export function renderTimeline(events: TraceEvent[], meta: TimelineMeta): string {
  const s = meta.strings;
  const verdict = meta.integrityOk ? c.green(s.chainIntact) : c.red(s.chainTampered(meta.integrityNote ?? ""));

  const lines: string[] = [];
  lines.push(`${c.bold("◈ " + meta.sourceLabel)}  ${c.dim(`${events.length} ${s.eventsLabel}`)}`);
  lines.push(verdict);
  if (meta.driftCount > 0) lines.push(c.yellow(s.driftBanner(meta.driftCount)));
  lines.push("");

  if (events.length === 0) {
    lines.push(c.dim(s.emptySession));
    return lines.join("\n");
  }

  for (const e of events) {
    const { label, colorize } = c.decision(e.decision);
    const rule = e.matchedRule ? c.cyan(` [${e.matchedRule}]`) : "";
    const reason = e.reason ? c.dim(` — ${e.reason}`) : "";
    const marker = e.policyDrift ? c.yellow(` ${s.driftRow}`) : "";
    lines.push(
      `${c.bold(`#${String(e.seq)}`)} ${c.dim(e.ts.slice(11, 19))} ${colorize(label)} ${c.cyan(e.tool.padEnd(9))} ${summarizeEvent(e)}${rule}${reason}${marker}`,
    );
  }
  return lines.join("\n");
}

/** Full event detail card for the drill-in view. */
export function renderEventDetail(e: TraceEvent, strings_: UiStrings): string {
  const s = strings_;
  const { label, colorize } = c.decision(e.decision);
  const rows: string[] = [
    `${s.timestampLabel}    ${e.ts}`,
    `${s.toolLabel}         ${e.tool}`,
    `${s.decisionLabel}     ${colorize(label)}`,
    `${s.ruleLabel} ${e.matchedRule ?? c.dim(s.ruleDefault)}`,
    `${s.reasonLabel}       ${e.reason ?? c.dim("—")}`,
    `${s.resultLabel}       ${e.result ?? "—"}`,
    `${s.exitCodeLabel}    ${e.exitCode ?? "—"}`,
    `${s.policyLabel}       ${e.policyDigest ? c.cyan(e.policyDigest.slice(0, 16) + "…") : c.dim(s.policyNotAnchored)}`,
  ];
  if (e.policyDrift) rows.push(c.yellow(`${s.driftRow}  ${s.driftYesLabel}`));
  const input = (typeof e.input === "object" && e.input !== null ? e.input : {}) as Record<string, unknown>;
  if (typeof input["command"] === "string") rows.push(`${s.commandLabel}      ${input["command"]}`);
  if (typeof input["file_path"] === "string") rows.push(`${s.fileLabel}         ${input["file_path"]}`);
  rows.push(`${s.eventHashLabel}   ${c.dim(e.hash.slice(0, 24) + "…")}`);
  return rows.join("\n");
}
