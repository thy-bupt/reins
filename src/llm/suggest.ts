import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stringify as yamlStringify } from "yaml";
import { decide } from "../core/decider.js";
import { anonymizePath, redactCommand } from "../core/redact.js";
import type { Policy, Rule } from "../core/policy.js";
import { loadPolicy } from "../core/policy.js";
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
  rule?: Rule;
  id: string;
  accepted: boolean;
  problems: string[];
  yaml?: string;
  impact: { newBlocks: number; allowEvents: number };
}

const MAX_PROPOSALS = 3;
const MAX_FIELD_LENGTH = 200;

/** False-positive corpora: any proposed rule that would block one of these is
 *  rejected automatically — the deterministic backstop for LLM output. */
export const FALSE_POSITIVE_CORPUS: readonly string[] = [
  `echo "rm -rf /tmp/x"`,
  "echo $(date)",
  `git commit -m "update"`,
  "npm test",
  "ls -la",
  "git status",
];

export const FALSE_POSITIVE_PATH_CORPUS: readonly string[] = [
  "README.md",
  "src/index.ts",
  "package.json",
  "package-lock.json",
  "node_modules/.bin/tool",
  "/tmp/work.txt",
];

/** overly broad path globs are rejected outright — "block everything" rules
 *  would otherwise pass validation when no session events match them */
const OVERLY_BROAD_PATHS: ReadonlySet<string> = new Set([
  "**",
  "/**",
  "**/*",
  "**/**",
  "*",
  "~/**",
  "$HOME/**",
]);

function hasControlChars(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x08\x0a-\x1f\x7f]/.test(s);
}

function stableId(prefix: string, proposal: RuleProposal): string {
  const h = createHash("sha256").update(JSON.stringify(proposal)).digest("hex").slice(0, 8);
  return `${prefix}-${h}`;
}

function sanitizeProposalField(value: string, what: string, problems: string[]): string | null {
  if (value.length > MAX_FIELD_LENGTH) {
    problems.push(`${what} exceeds ${MAX_FIELD_LENGTH} characters`);
    return null;
  }
  if (hasControlChars(value)) {
    problems.push(`${what} contains control characters or newlines`);
    return null;
  }
  return value;
}

function proposalToRule(
  proposal: RuleProposal,
  existing: Policy,
  problems: string[],
): Rule | null {
  // reason hygiene — check control chars on the RAW text first (fail closed
  // on newlines/control chars before any collapsing), then normalize
  if (hasControlChars(proposal.reason)) {
    problems.push("reason contains control characters or newlines");
    return null;
  }
  const rawReason = proposal.reason.replace(/\s+/g, " ").trim();
  if (rawReason.length > MAX_FIELD_LENGTH) {
    problems.push(`reason exceeds ${MAX_FIELD_LENGTH} characters`);
    return null;
  }
  const reason = `[llm-suggested ${new Date().toISOString().slice(0, 10)}] ${rawReason}`;
  const ruleId = stableId("llm", proposal);

  if (proposal.kind === "command") {
    const hasProgram = typeof proposal.program === "string" && proposal.program !== "";
    const hasPattern = typeof proposal.pattern === "string" && proposal.pattern !== "";
    if (hasProgram && hasPattern) {
      problems.push("command rule cannot have both program and pattern");
      return null;
    }
    if (!hasProgram && !hasPattern) {
      problems.push("command rule needs program or pattern");
      return null;
    }
    if (hasProgram && sanitizeProposalField(proposal.program!, "program", problems) === null) return null;
    if (proposal.flags && proposal.flags.some((f) => hasControlChars(f))) {
      problems.push("flags contain control characters");
      return null;
    }
    if (hasPattern && sanitizeProposalField(proposal.pattern!, "pattern", problems) === null) return null;
    if (hasPattern) {
      try {
        new RegExp(proposal.pattern!);
      } catch {
        problems.push("pattern is not a valid regex");
        return null;
      }
    }
    return {
      id: ruleId,
      kind: "command",
      action: proposal.action,
      ...(hasProgram ? { program: proposal.program } : {}),
      ...(proposal.flags ? { flags: proposal.flags } : {}),
      ...(hasPattern ? { pattern: proposal.pattern } : {}),
      reason,
    } as Rule;
  }

  if (typeof proposal.path !== "string") {
    problems.push("path rule without path");
    return null;
  }
  const safePath = sanitizeProposalField(proposal.path, "path", problems);
  if (safePath === null) return null;
  const normalized = safePath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (OVERLY_BROAD_PATHS.has(normalized) || OVERLY_BROAD_PATHS.has(safePath)) {
    problems.push(`overly broad path rule ("${safePath}") — narrow it to a specific subtree`);
    return null;
  }
  return {
    id: ruleId,
    kind: "path",
    action: proposal.action,
    path: safePath,
    reason,
  } as Rule;
}

/** Deterministic verification of an LLM proposal — the full gate:
 *  1. field sanitization (length, control chars) + over-broad path rejection;
 *  2. rule object → YAML stringify → loadPolicy ROUND-TRIP (no hand-built
 *     YAML, no injection surface);
 *  3. false-positive corpora (commands AND paths);
 *  4. replay impact against real session ledgers.
 *  The generated YAML is only produced after every gate passes. */
export function validateProposal(
  proposal: RuleProposal,
  existing: Policy,
  sessionFiles: string[],
): ProposalVerdict {
  const problems: string[] = [];
  const id = stableId("llm", proposal);
  const fail = () => ({ proposal, id, accepted: false, problems, yaml: undefined, impact: { newBlocks: 0, allowEvents: 0 } });

  const rule = proposalToRule(proposal, existing, problems);
  if (!rule) return fail();

  // YAML stringify + round-trip: the composed policy MUST parse back with the
  // new rule inside — this is what makes YAML injection structurally impossible
  const testPolicy: Policy = { version: 1, name: existing.name, default: existing.default, rules: [...existing.rules, rule] };
  let testText: string;
  try {
    testText = yamlStringify(testPolicy);
    const reparsed = loadPolicy(testText);
    if (reparsed.rules.length !== testPolicy.rules.length) {
      problems.push("round-trip lost rules");
      return fail();
    }
  } catch (err) {
    problems.push(`generated policy failed validation: ${err instanceof Error ? err.message : String(err)}`);
    return fail();
  }

  for (const cmd of FALSE_POSITIVE_CORPUS) {
    if (decide(testPolicy, { tool: "Bash", input: { command: cmd } }).decision !== "allow") {
      problems.push(`false positive: would block innocent command "${cmd}"`);
    }
  }
  for (const p of FALSE_POSITIVE_PATH_CORPUS) {
    if (decide(testPolicy, { tool: "Write", input: { file_path: p } }).decision !== "allow") {
      problems.push(`false positive: would block innocent path "${p}"`);
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
        if (typeof input["command"] !== "string" && typeof input["file_path"] !== "string") continue;
        allowEvents += 1;
        if (e.decision === "allow" && decide(testPolicy, { tool: e.tool, input }).decision !== "allow") newBlocks += 1;
      }
    } catch {
      problems.push(`unreadable session: ${file}`);
    }
  }

  if (newBlocks > 0 && proposal.action === "allow") {
    problems.push("an allow-proposal must never newly block events");
  }

  const accepted = problems.length === 0;
  return {
    proposal,
    rule: accepted ? rule : undefined,
    id,
    accepted,
    problems,
    yaml: accepted ? trimmedRuleYaml(testText, rule.id) : undefined,
    impact: { newBlocks, allowEvents },
  };
}

/** extract just the accepted rule's YAML block from the round-tripped policy */
function trimmedRuleYaml(composedPolicyText: string, ruleId: string): string {
  const lines = composedPolicyText.split("\n");
  const start = lines.findIndex((l) => l.includes(`id: ${ruleId}`));
  if (start === -1) return "";
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i]!;
    if (i > start && /^ {2}- id:/.test(l)) break; // next rule starts
    out.push(l.startsWith("  ") ? l.slice(2) : l);
  }
  return out.join("\n");
}

function readEvents(file: string): TraceEvent[] {
  // ledger files are small; sync read keeps the validation pipeline pure
  const content = readFileSync(file, "utf8");
  return content
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as TraceEvent);
}

/** Deterministic, REDACTED data collection for the LLM prompt — built from
 *  the EXPLICIT caller-selected file list only. Commands are secret-redacted,
 *  absolute paths are anonymized, ledger files referenced by basename. */
export async function collectLedgerSummaryFromFiles(sessionFiles: string[]): Promise<string> {
  const sessions: Array<Record<string, unknown>> = [];
  for (const f of sessionFiles) {
    try {
      const integrity = await verifyTrace(f);
      const events = await readTrace(f);
      sessions.push({
        ledger: basename(f),
        integrity: integrity.ok ? "ok" : `tampered (${integrity.reason})`,
        decisions: events.map((e) => {
          const input = (typeof e.input === "object" && e.input !== null ? e.input : {}) as Record<string, unknown>;
          return {
            tool: e.tool,
            command: typeof input["command"] === "string" ? redactCommand(input["command"]) : undefined,
            file_path: typeof input["file_path"] === "string" ? anonymizePath(input["file_path"]) : undefined,
            decision: e.decision,
            matchedRule: e.matchedRule ?? undefined,
            reason: e.reason ?? undefined,
          };
        }),
      });
    } catch {
      // skip unreadable ledgers — they are also reported by validateProposal
    }
  }
  return JSON.stringify({ note: "commands are agent attempts (redacted); deny means blocked before execution", sessions }, null, 1);
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

export function buildSuggestPrompt(summaryJson: string): string {
  return [
    "You are a security policy assistant for reins, a deterministic policy engine for AI coding agents.",
    "Analyze the ledger summary below and propose 0-3 NEW policy rules that reduce repeated dangerous patterns",
    "while keeping false positives near zero. Never propose rules that block package installs, test runs,",
    "version control reads, or file listing. Never propose overly broad path globs like **.",
    "Output STRICT JSON only, no prose:",
    '{"proposals":[{"kind":"command|path","action":"deny|ask|allow","program":"rm","flags":["-r"],"pattern":"regex (command rules only)","path":"glob (path rules only)","reason":"short single-line reason"}]}',
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
  for (const entry of parsed.proposals.slice(0, MAX_PROPOSALS)) {
    const p = entry as Record<string, unknown>;
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

/** Full suggest pipeline over EXPLICIT session files: the summary is built
 *  only from the caller-selected file list — no directory re-scan, so
 *  sibling ledgers the user did not select never reach the provider. */
export async function runSuggestPipeline(
  cfg: LlmConfig,
  existing: Policy,
  sessionFiles: string[],
  _sessionLimit = 3,
): Promise<{ verdicts: ProposalVerdict[]; prompt: string; llmOutput: string }> {
  const summary = await collectLedgerSummaryFromFiles(sessionFiles);
  const prompt = buildSuggestPrompt(summary);
  const llmOutput = await completePrompt(prompt, cfg);
  const proposals = parseProposals(llmOutput);
  const verdicts = proposals.map((p) => validateProposal(p, existing, sessionFiles));
  return { verdicts, prompt, llmOutput };
}
