import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { decide, type ToolEvent } from "../core/decider.js";
import type { Policy, Rule } from "../core/policy.js";
import { verifyEvents, verifyTrace, readTrace, type TraceEvent } from "../core/trace.js";
import { completePrompt } from "./provider.js";
import type { LlmConfig } from "./config.js";

export interface RuleProposal {
  kind: "command" | "path";
  action: "deny" | "ask" | "allow";
  program?: string;
  flags?: string[];
  pattern?: string;
  path?: string;
  reason: string;
}

export interface ProposalVerdict {
  proposal: RuleProposal;
  id: string;
  accepted: boolean;
  problems: string[];
  yaml: string;
  impact: { newBlocks: number; allowEvents: number };
}

/** False-positive corpus: any proposed rule that would block one of these is
 *  rejected automatically — the deterministic backstop for LLM output. */
export const FALSE_POSITIVE_CORPUS: readonly string[] = [
  `echo "rm -rf /tmp/x"`,
  "echo $(date)",
  `git commit -m "update"`,
  "npm test",
  "ls -la",
  "git status",
];

function stableId(prefix: string, proposal: RuleProposal): string {
  const h = createHash("sha256").update(JSON.stringify(proposal)).digest("hex").slice(0, 8);
  return `${prefix}-${h}`;
}

export function proposalToRule(proposal: RuleProposal): Rule | null {
  if (proposal.kind === "command" && typeof proposal.program === "string" && proposal.program !== "") {
    return {
      id: stableId("llm", proposal),
      kind: "command",
      action: proposal.action,
      program: proposal.program,
      ...(proposal.flags ? { flags: proposal.flags } : {}),
      ...(proposal.pattern ? { pattern: proposal.pattern } : {}),
      reason: proposal.reason,
    } as Rule;
  }
  if (proposal.kind === "path" && typeof proposal.path === "string" && proposal.path !== "") {
    return {
      id: stableId("llm", proposal),
      kind: "path",
      action: proposal.action,
      path: proposal.path,
      reason: proposal.reason,
    } as Rule;
  }
  return null;
}

export function proposalToYaml(proposal: RuleProposal): string {
  const rule = proposalToRule(proposal);
  if (!rule) return "";
  const lines: string[] = [];
  lines.push(`  - id: ${rule.id}`);
  lines.push(`    kind: ${rule.kind}`);
  lines.push(`    action: ${rule.action}`);
  if (rule.kind === "command") {
    const cr = rule as Extract<Rule, { kind: "command" }>;
    if (cr.program) lines.push(`    program: ${cr.program}`);
    if (cr.flags) lines.push(`    flags: [${cr.flags.map((f) => `"${f}"`).join(", ")}]`);
    if (cr.pattern) lines.push(`    pattern: '${cr.pattern}'`);
  } else {
    lines.push(`    path: "${(rule as Extract<Rule, { kind: "path" }>).path}"`);
  }
  lines.push(`    reason: "${proposal.reason}"`);
  return lines.join("\n");
}

/** Deterministic verification of an LLM proposal:
 *  1. schema check (must become a valid rule);
 *  2. false-positive corpus (must never block the innocent list);
 *  3. replay impact against real session ledgers. */
export function validateProposal(
  proposal: RuleProposal,
  existing: Policy,
  sessionFiles: string[],
): ProposalVerdict {
  const problems: string[] = [];
  const id = stableId("llm", proposal);
  const rule = proposalToRule(proposal);
  if (!rule) {
    problems.push("proposal does not form a valid rule (missing program or path)");
    return { proposal, id, accepted: false, problems, yaml: "", impact: { newBlocks: 0, allowEvents: 0 } };
  }

  const testPolicy: Policy = { ...existing, rules: [...existing.rules, rule] };

  for (const cmd of FALSE_POSITIVE_CORPUS) {
    const event: ToolEvent = { tool: "Bash", input: { command: cmd } };
    if (decide(testPolicy, event).decision !== "allow") {
      problems.push(`false positive: would block innocent command "${cmd}"`);
    }
  }

  let newBlocks = 0;
  let allowEvents = 0;
  for (const file of sessionFiles) {
    try {
      const events = readEvents(file);
      const integrity = verifyEvents(events);
      if (!integrity.ok) {
        problems.push(`skipped tampered session ${file} (${integrity.reason ?? "integrity failure"})`);
        continue;
      }
      for (const e of events) {
        const input = (typeof e.input === "object" && e.input !== null ? e.input : {}) as Record<string, unknown>;
        const event: ToolEvent = { tool: e.tool, input };
        if (typeof input["command"] !== "string" && typeof input["file_path"] !== "string") continue;
        allowEvents += 1;
        if (e.decision === "allow" && decide(testPolicy, event).decision !== "allow") newBlocks += 1;
      }
    } catch {
      problems.push(`unreadable session: ${file}`);
    }
  }

  if (newBlocks > 0 && proposal.action === "allow") {
    problems.push("an allow-proposal must never newly block events");
  }

  return {
    proposal,
    id,
    accepted: problems.length === 0,
    problems,
    yaml: proposalToYaml(proposal),
    impact: { newBlocks, allowEvents },
  };
}

function readEvents(file: string): TraceEvent[] {
  // ledger files are small; sync read keeps the validation pipeline pure
  const content = readFileSync(file, "utf8");
  return content
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as TraceEvent);
}

/** Deterministic data collection: recent verified sessions, summarized. */
export async function collectLedgerSummary(sessionsDir: string, sessionLimit = 3): Promise<string> {
  if (!existsSync(sessionsDir)) return JSON.stringify({ sessions: [] });
  const names = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
  const files = names
    .map((name) => {
      const path = join(sessionsDir, name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, sessionLimit);

  const sessions: Array<Record<string, unknown>> = [];
  for (const f of files) {
    try {
      const integrity = await verifyTrace(f.path);
      const events = await readTrace(f.path);
      sessions.push({
        file: f.path,
        integrity: integrity.ok ? "ok" : `tampered (${integrity.reason})`,
        decisions: events.map((e) => {
          const input = (typeof e.input === "object" && e.input !== null ? e.input : {}) as Record<string, unknown>;
          return {
            tool: e.tool,
            command: typeof input["command"] === "string" ? input["command"] : undefined,
            file_path: typeof input["file_path"] === "string" ? input["file_path"] : undefined,
            decision: e.decision,
            matchedRule: e.matchedRule ?? undefined,
            reason: e.reason ?? undefined,
          };
        }),
      });
    } catch {
      // skip unreadable ledgers
    }
  }
  return JSON.stringify({ note: "commands are agent attempts; deny means blocked before execution", sessions }, null, 1);
}

export function buildSuggestPrompt(summaryJson: string): string {
  return [
    "You are a security policy assistant for reins, a deterministic policy engine for AI coding agents.",
    "Analyze the ledger summary below and propose 0-3 NEW policy rules that reduce repeated dangerous patterns",
    "while keeping false positives near zero. Never propose rules that block package installs, test runs,",
    "version control reads, or file listing. Output STRICT JSON only, no prose:",
    '{"proposals":[{"kind":"command|path","action":"deny|ask|allow","program":"rm","flags":["-r"],"pattern":"regex (command rules only)","path":"glob (path rules only)","reason":"short human-readable reason"}]}',
    "",
    "LEDGER SUMMARY:",
    summaryJson,
  ].join("\n");
}

export function parseProposals(llmOutput: string): RuleProposal[] {
  const fenced = llmOutput.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1]! : llmOutput;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found in LLM output");
  const parsed = JSON.parse(raw.slice(start, end + 1)) as { proposals?: unknown };
  if (!Array.isArray(parsed.proposals)) throw new Error("LLM output missing proposals array");
  const out: RuleProposal[] = [];
  for (const raw2 of parsed.proposals) {
    const p = raw2 as Record<string, unknown>;
    if (p["kind"] !== "command" && p["kind"] !== "path") continue;
    if (p["action"] !== "deny" && p["action"] !== "ask" && p["action"] !== "allow") continue;
    if (typeof p["reason"] !== "string" || p["reason"].trim() === "") continue;
    out.push({
      kind: p["kind"] as RuleProposal["kind"],
      action: p["action"] as RuleProposal["action"],
      program: typeof p["program"] === "string" ? p["program"] : undefined,
      flags: Array.isArray(p["flags"]) ? (p["flags"] as string[]).filter((f) => typeof f === "string") : undefined,
      pattern: typeof p["pattern"] === "string" ? p["pattern"] : undefined,
      path: typeof p["path"] === "string" ? p["path"] : undefined,
      reason: p["reason"],
    });
  }
  return out;
}

export async function runSuggestPipeline(
  cfg: LlmConfig,
  sessionsDir: string,
  existing: Policy,
  sessionLimit = 3,
): Promise<{ verdicts: ProposalVerdict[]; prompt: string; llmOutput: string }> {
  const summary = await collectLedgerSummary(sessionsDir, sessionLimit);
  const prompt = buildSuggestPrompt(summary);
  const llmOutput = await completePrompt(prompt, cfg);
  const proposals = parseProposals(llmOutput);

  const sessionFiles = sessionFilesIn(sessionsDir, sessionLimit);
  const verdicts = proposals.map((p) => validateProposal(p, existing, sessionFiles));
  return { verdicts, prompt, llmOutput };
}

function sessionFilesIn(sessionsDir: string, limit: number): string[] {
  if (!existsSync(sessionsDir)) return [];
  return readdirSync(sessionsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(sessionsDir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, limit);
}
