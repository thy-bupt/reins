import { parse as parseYaml } from "yaml";

export type PolicyAction = "allow" | "deny" | "ask";

export interface CommandRule {
  id: string;
  kind: "command";
  action: PolicyAction;
  reason: string;
  /** basename of the program to match (e.g. "rm"). Mutually exclusive with pattern. */
  program?: string;
  /** token that must immediately follow the program (e.g. "push" for git push). */
  subcommand?: string;
  /** any of these flags (after short-flag expansion) triggers the rule. */
  flags?: string[];
  /** regex tested against the raw command string. Mutually exclusive with program. */
  pattern?: string;
  /** restrict the rule to these tool names; empty/absent = all command tools. */
  tools?: string[];
}

export interface PathRule {
  id: string;
  kind: "path";
  action: PolicyAction;
  reason: string;
  /** glob matched against absolute paths (dot-aware). */
  path: string;
  tools?: string[];
}

export type Rule = CommandRule | PathRule;

export interface Policy {
  version: 1;
  name?: string;
  /** decision when no rule matches. Defaults to "allow". */
  default: PolicyAction;
  rules: Rule[];
}

export class PolicyError extends Error {}

const ACTIONS: ReadonlySet<string> = new Set(["allow", "deny", "ask"]);

function expectString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PolicyError(`rule ${what} must be a non-empty string`);
  }
  return value;
}

function validateRule(raw: unknown, index: number): Rule {
  if (typeof raw !== "object" || raw === null) {
    throw new PolicyError(`rule #${index} must be a mapping`);
  }
  const r = raw as Record<string, unknown>;
  const id = expectString(r.id, `#${index} id`);
  const where = `"${id}"`;

  if (typeof r.kind !== "string" || !["command", "path"].includes(r.kind)) {
    throw new PolicyError(`rule ${where}: kind must be "command" or "path"`);
  }
  if (typeof r.action !== "string" || !ACTIONS.has(r.action)) {
    throw new PolicyError(
      `rule ${where}: action must be one of "allow", "deny", "ask" (got ${JSON.stringify(r.action)})`,
    );
  }
  if (typeof r.reason !== "string" || r.reason.trim() === "") {
    throw new PolicyError(`rule ${where}: a human-readable reason is required`);
  }
  if (r.tools !== undefined) {
    if (
      !Array.isArray(r.tools) ||
      r.tools.some((t) => typeof t !== "string" || t.trim() === "")
    ) {
      throw new PolicyError(`rule ${where}: tools must be a list of non-empty strings`);
    }
  }

  if (r.kind === "command") {
    const hasProgram = r.program !== undefined;
    const hasPattern = r.pattern !== undefined;
    if (hasProgram && hasPattern) {
      throw new PolicyError(`rule ${where}: program and pattern are mutually exclusive (use one)`);
    }
    if (!hasProgram && !hasPattern) {
      throw new PolicyError(`rule ${where}: command rules need either "program" or "pattern"`);
    }
    if (hasProgram) expectString(r.program, `${where} program`);
    if (hasPattern) {
      const pattern = expectString(r.pattern, `${where} pattern`);
      try {
        new RegExp(pattern);
      } catch (err) {
        throw new PolicyError(`rule ${where}: invalid regex pattern: ${String(err)}`);
      }
    }
    if (r.flags !== undefined) {
      if (!Array.isArray(r.flags) || r.flags.some((f) => typeof f !== "string" || f === "")) {
        throw new PolicyError(`rule ${where}: flags must be a list of non-empty strings`);
      }
    }
    if (r.subcommand !== undefined) expectString(r.subcommand, `${where} subcommand`);
    return r as unknown as CommandRule;
  }

  expectString(r.path, `${where} path`);
  return r as unknown as PathRule;
}

export function loadPolicy(yamlText: string): Policy {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new PolicyError(`invalid policy yaml: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new PolicyError("policy must be a yaml mapping with a version and rules");
  }
  const doc = raw as Record<string, unknown>;

  if (doc.version !== 1) {
    throw new PolicyError(
      `unsupported policy schema version: ${JSON.stringify(doc.version)} (expected 1)`,
    );
  }
  const def = doc.default ?? "allow";
  if (typeof def !== "string" || !ACTIONS.has(def)) {
    throw new PolicyError(`policy default must be one of "allow", "deny", "ask"`);
  }

  const rawRules = doc.rules;
  if (!Array.isArray(rawRules)) {
    throw new PolicyError("policy rules must be a list");
  }

  const rules = rawRules.map(validateRule);
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      throw new PolicyError(`duplicate rule id: ${rule.id}`);
    }
    seen.add(rule.id);
  }

  return {
    version: 1,
    name: typeof doc.name === "string" ? doc.name : undefined,
    default: def as PolicyAction,
    rules,
  };
}
