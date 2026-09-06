import type { LlmConfig } from "./config.js";
import { completePrompt } from "./provider.js";

export function buildExplainPrompt(snapshotMarkdown: string, audience: "dev" | "audit"): string {
  const audienceLine =
    audience === "audit"
      ? "Write for a compliance/audit reader: precise, neutral, process-focused."
      : "Write for the developer who ran the agent: concise, practical, action-focused.";
  return [
    "You are an incident-report writer for reins, an AI-agent audit tool.",
    "Below is a structured operation snapshot: every agent tool call, the policy decision made,",
    "and the integrity status of the ledger. Write a short incident report (markdown).",
    audienceLine,
    "Order: 1) ledger integrity verdict, 2) blocked actions (with rules), 3) allowed actions worth attention,",
    "4) recovery steps if any. Do not invent events that are not in the data. Quote commands verbatim.",
    "",
    "--- SNAPSHOT START ---",
    snapshotMarkdown,
    "--- SNAPSHOT END ---",
  ].join("\n");
}

export async function runExplain(
  cfg: LlmConfig,
  snapshotMarkdown: string,
  audience: "dev" | "audit",
): Promise<string> {
  const prompt = buildExplainPrompt(snapshotMarkdown, audience);
  return completePrompt(prompt, cfg);
}
