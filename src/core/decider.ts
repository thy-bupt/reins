import { expandFlags, compilePattern, findProgramCandidates, matchesPathGlob, parseSegments } from "./matchers.js";
import type { CommandRule, Policy, PolicyAction, Rule } from "./policy.js";
import type { Decision } from "./trace.js";

export interface ToolEvent {
  tool: string;
  input: Record<string, unknown>;
}

export interface DecisionResult {
  decision: PolicyAction | Decision;
  matchedRule?: string;
  reason?: string;
}

function toolsAllow(rule: Rule, tool: string): boolean {
  if (!rule.tools || rule.tools.length === 0) return true;
  return rule.tools.some((t) => t.toLowerCase() === tool.toLowerCase());
}

function decideCommand(policy: Policy, tool: string, raw: string): DecisionResult {
  const segments = parseSegments(raw);
  for (const rule of policy.rules) {
    if (rule.kind !== "command" || !toolsAllow(rule, tool)) continue;
    const cr = rule as CommandRule;

    if (cr.pattern !== undefined) {
      if (compilePattern(cr.pattern).test(raw)) {
        return { decision: cr.action, matchedRule: cr.id, reason: cr.reason };
      }
      continue;
    }

    const program = cr.program!.toLowerCase();
    const wantedFlags = cr.flags ? cr.flags.flatMap(expandFlags) : undefined;
    for (const seg of segments) {
      for (const cand of findProgramCandidates(seg)) {
        if (cand.program !== program) continue;
        if (cr.subcommand !== undefined && seg[cand.index + 1] !== cr.subcommand) continue;
        if (wantedFlags !== undefined && wantedFlags.length > 0) {
          const hit = wantedFlags.some((f) => cand.rest.includes(f));
          if (!hit) continue;
        }
        return { decision: cr.action, matchedRule: cr.id, reason: cr.reason };
      }
    }
  }
  return { decision: policy.default };
}

function decidePath(policy: Policy, tool: string, filePath: string): DecisionResult {
  for (const rule of policy.rules) {
    if (rule.kind !== "path" || !toolsAllow(rule, tool)) continue;
    if (matchesPathGlob(rule.path, filePath)) {
      return { decision: rule.action, matchedRule: rule.id, reason: rule.reason };
    }
  }
  return { decision: policy.default };
}

/** Evaluate a policy against a tool invocation. Routing is input-shape based
 *  (agent-agnostic): `input.command` -> command rules, `input.file_path` /
 *  `input.notebook_path` -> path rules, anything else -> policy default. */
export function decide(policy: Policy, event: ToolEvent): DecisionResult {
  const command = event.input["command"];
  if (typeof command === "string" && command.trim() !== "") {
    return decideCommand(policy, event.tool, command);
  }
  const filePath = event.input["file_path"] ?? event.input["notebook_path"];
  if (typeof filePath === "string" && filePath.trim() !== "") {
    return decidePath(policy, event.tool, filePath);
  }
  return { decision: policy.default };
}
