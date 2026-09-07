import { createHash } from "node:crypto";
import { homedir } from "node:os";

/** Shared redaction for anything reins sends to an LLM or writes to an
 *  evidence file. Lives in core so adapters, CLI and the LLM layer all use
 *  exactly one implementation. */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, "Bearer [REDACTED]"],
  [/\b(?:sk|pk)-[A-Za-z0-9]{8,}/g, "[REDACTED-KEY]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED-AWS-KEY]"],
  [
    /\b(?:api[_-]?key|token|password|passwd|secret|authorization)\s*[=:]\s*"?[^\s"'&]{4,}/gi,
    "$1=[REDACTED]",
  ],
  [/\b(?:ghp|github_pat)_[A-Za-z0-9_]{10,}/g, "[REDACTED-GITHUB-TOKEN]"],
];

export function redactCommand(command: string): string {
  let out = command;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Replace the user's home prefix with `~` so absolute local paths never
 *  leave the machine (LLM prompts, exports). */
export function tildePath(p: string): string {
  const home = homedir();
  if (home && (p === home || p.startsWith(home + "/"))) return "~" + p.slice(home.length);
  return p;
}

export function commandDigest(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}
