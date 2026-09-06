import { describe, expect, it } from "vitest";
import { decide, type ToolEvent } from "../src/core/decider.js";
import { loadPolicy } from "../src/core/policy.js";

const policy = loadPolicy(`
version: 1
default: allow
rules:
  - id: rm-recursive
    kind: command
    action: deny
    program: rm
    flags: ["-r", "-R", "--recursive"]
    reason: "recursive deletion is destructive"
  - id: git-force-push
    kind: command
    action: deny
    program: git
    subcommand: push
    flags: ["--force", "-f"]
    reason: "force push rewrites shared history"
`);

function bash(command: string): ToolEvent {
  return { tool: "Bash", input: { command } };
}

// Codex review corpus: every case here REALLY executed during the audit —
// the parser must deny all of them. These are regression tests, not theory.
const MUST_DENY: string[] = [
  // interpreter -c
  `bash -c "rm -rf /tmp/x"`,
  `sh -c "rm -rf /tmp/x"`,
  `zsh -c "rm -rf /tmp/x"`,
  `bash -c 'rm -rf /tmp/x'`,
  // control flow
  `if true; then rm -rf /tmp/x; fi`,
  `while false; do rm -rf /tmp/x; done`,
  `{ rm -rf /tmp/x; }`,
  // command substitution
  "echo `rm -rf /tmp/x`",
  "echo $(rm -rf /tmp/x)",
  "bash -c 'echo $(rm -rf /tmp/x)'",
  // obfuscation
  "rm -r${IFS}-f /tmp/x",
  // nested interpreter behind find
  `find . -exec sh -c "rm -rf /tmp/x" \\;`,
  // wrapper flag/value handling
  `env -- rm -rf /tmp/x`,
  `command -- rm -rf /tmp/x`,
  `xargs -0 rm -rf /tmp/x`,
  `sudo -u root rm -rf /tmp/x`,
  `sudo -- rm -rf /tmp/x`,
];

// false-positive contract: innocent commands must stay allowed
const MUST_ALLOW: string[] = [
  `echo "rm -rf /tmp/x"`,
  `echo "then do { rm }"`,
  `ls -la`,
  `npm test`,
  `echo $(date)`,
  `git commit -m "$(date)"`,
  `echo "bash -c is a word in a sentence"`,
  `grep -c "if" file.txt`,
  `git log --oneline -5`,
];

describe("bypass corpus (from Codex audit — all really executed)", () => {
  for (const cmd of MUST_DENY) {
    it(`denies: ${cmd}`, () => {
      const result = decide(policy, bash(cmd));
      expect(result.decision, `expected deny for: ${cmd}`).toBe("deny");
    });
  }

  for (const cmd of MUST_ALLOW) {
    it(`allows: ${cmd}`, () => {
      const result = decide(policy, bash(cmd));
      expect(result.decision, `expected allow for: ${cmd}`).toBe("allow");
    });
  }

  it("denies with the matched rule on the interpreter recursion path", () => {
    const result = decide(policy, bash(`bash -c "rm -rf /tmp/x"`));
    expect(result.matchedRule).toBe("rm-recursive");
  });
});
