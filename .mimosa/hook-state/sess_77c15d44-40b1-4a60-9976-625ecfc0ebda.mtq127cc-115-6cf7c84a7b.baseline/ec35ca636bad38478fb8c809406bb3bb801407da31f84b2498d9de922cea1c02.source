import { decide } from "../core/decider.js";
import type { Policy, PolicyAction } from "../core/policy.js";

export interface ReplayableEvent {
  seq: number;
  ts: string;
  tool: string;
  input: unknown;
  decision: string;
}

export interface ReplayEntry {
  seq: number;
  tool: string;
  summary: string;
  matchedRule?: string;
  reason?: string;
  to: PolicyAction;
}

export interface ReplayChange {
  seq: number;
  from: string;
  to: PolicyAction;
  matchedRule?: string;
}

export interface ReplayReport {
  policyName: string;
  reviewed: number;
  skipped: number;
  wouldBlock: ReplayEntry[];
  wouldAllow: ReplayEntry[];
  alreadyBlocked: ReplayEntry[];
  wouldChange: ReplayChange[];
}

function summarize(tool: string, input: Record<string, unknown>): string | null {
  if (typeof input["command"] === "string" && input["command"].trim() !== "") {
    return String(input["command"]);
  }
  const path = input["file_path"] ?? input["notebook_path"];
  if (typeof path === "string" && path.trim() !== "") {
    return `${tool}: ${path}`;
  }
  return null;
}

function entryFrom(seq: number, tool: string, summary: string, result: ReturnType<typeof decide>): ReplayEntry {
  return {
    seq,
    tool,
    summary,
    matchedRule: result.matchedRule,
    reason: result.reason,
    to: result.decision,
  };
}

/** Re-evaluate a recorded session under a candidate policy without executing
 *  anything. Old "deny" events are reported separately from new blocks. */
export function replaySession(events: ReplayableEvent[], policy: Policy): ReplayReport {
  const report: ReplayReport = {
    policyName: policy.name ?? "unnamed policy",
    reviewed: 0,
    skipped: 0,
    wouldBlock: [],
    wouldAllow: [],
    alreadyBlocked: [],
    wouldChange: [],
  };

  for (const event of events) {
    const input =
      typeof event.input === "object" && event.input !== null
        ? (event.input as Record<string, unknown>)
        : {};
    const summary = summarize(event.tool, input);
    if (summary === null) {
      report.skipped += 1;
      continue;
    }
    report.reviewed += 1;

    const result = decide(policy, { tool: event.tool, input });
    const entry = entryFrom(event.seq, event.tool, summary, result);
    const oldDecision = event.decision;

    if (oldDecision === "deny") {
      report.alreadyBlocked.push(entry);
    } else if (result.decision === "allow") {
      report.wouldAllow.push(entry);
    } else {
      report.wouldBlock.push(entry);
    }

    if (oldDecision !== result.decision) {
      report.wouldChange.push({
        seq: event.seq,
        from: oldDecision,
        to: result.decision,
        matchedRule: result.matchedRule,
      });
    }
  }

  return report;
}

export function formatReplayReport(report: ReplayReport): string {
  const lines: string[] = [];
  lines.push(`replay under "${report.policyName}": ${report.reviewed} reviewed, ${report.skipped} skipped`);

  if (report.wouldBlock.length > 0) {
    lines.push(`\nwould be blocked (${report.wouldBlock.length}):`);
    for (const e of report.wouldBlock) {
      lines.push(`  #${e.seq}  ${e.tool.padEnd(8)} ${truncate(e.summary)}  [${e.matchedRule ?? "default"}] ${e.reason ?? ""}`);
    }
  } else {
    lines.push("\nnothing new would be blocked.");
  }

  if (report.alreadyBlocked.length > 0) {
    lines.push(`\nalready blocked in the original session (${report.alreadyBlocked.length})`);
  }
  if (report.wouldChange.length > 0) {
    lines.push(`\ndecisions that would change (${report.wouldChange.length}):`);
    for (const c of report.wouldChange) {
      lines.push(`  #${c.seq}  ${c.from} → ${c.to}${c.matchedRule ? `  [${c.matchedRule}]` : ""}`);
    }
  }
  return lines.join("\n");
}

function truncate(s: string, max = 80): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
