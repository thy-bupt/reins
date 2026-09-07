import { anonymizePath, redactCommand } from "../core/redact.js";
import type { LlmConfig } from "./config.js";
import { completePrompt } from "./provider.js";

export interface LlmSnapshotEvent {
  ts: string;
  tool: string;
  decision: string;
  matchedRule?: string;
  reason?: string;
  command?: string;
  filePath?: string;
}

export interface LlmSnapshotMeta {
  agent: string;
  sessionId: string;
  integrityOk: boolean;
  integrityNote?: string;
}

/** LLM-safe snapshot renderer: unlike the forensic snapshot this contains NO
 *  absolute filesystem paths, no diffs, no policy file locations — only the
 *  redacted decision timeline an incident narrative needs. */
export function buildLlmSnapshot(events: LlmSnapshotEvent[], meta: LlmSnapshotMeta): string {
  const verdict = meta.integrityOk
    ? "hash chain OK"
    : `TAMPERED (${meta.integrityNote ?? "integrity failure"}) — events after the break are untrusted`;
  const lines: string[] = [];
  lines.push(`agent: ${meta.agent} · session: ${meta.sessionId} · ledger integrity: ${verdict}`);
  lines.push("");
  for (const e of events) {
    const action = e.command ?? (e.filePath ? `${e.tool}: ${anonymizePath(e.filePath)}` : "(no command/path)");
    const rule = e.matchedRule ? ` [${e.matchedRule}]` : "";
    const reason = e.reason ? ` — ${redactCommand(e.reason)}` : "";
    lines.push(`- ${e.ts} ${e.decision.toUpperCase()} ${e.tool}: ${redactCommand(action)}${rule}${reason}`);
  }
  return lines.join("\n");
}

export function buildExplainPrompt(snapshotText: string, audience: "dev" | "audit"): string {
  const audienceLine =
    audience === "audit"
      ? "Write for a compliance/audit reader: precise, neutral, process-focused."
      : "Write for the developer who ran the agent: concise, practical, action-focused.";
  return [
    "You are an incident-report writer for reins, an AI-agent audit tool.",
    "Below is a structured operation timeline: every agent tool call, the policy decision made,",
    "and the integrity status of the ledger. Write a short incident report (markdown).",
    audienceLine,
    "Order: 1) ledger integrity verdict, 2) blocked actions (with rules), 3) allowed actions worth attention,",
    "4) recovery steps if any. Do not invent events that are not in the data. Quote commands as given.",
    "",
    "--- TIMELINE START ---",
    snapshotText,
    "--- TIMELINE END ---",
  ].join("\n");
}

export async function runExplain(
  cfg: LlmConfig,
  snapshotText: string,
  audience: "dev" | "audit",
): Promise<string> {
  const prompt = buildExplainPrompt(snapshotText, audience);
  return completePrompt(prompt, cfg);
}
