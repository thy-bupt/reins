import { describe, expect, it } from "vitest";
import { loadPolicy, PolicyError } from "../src/core/policy.js";

const validPolicy = `
version: 1
name: test
default: allow
rules:
  - id: rm-recursive
    kind: command
    action: deny
    program: rm
    flags: ["-r", "--recursive"]
    reason: recursive deletion
  - id: pipe-to-shell
    kind: command
    action: deny
    pattern: "\\\\|\\\\s*sh(\\\\s|$)"
    reason: piping into shell
  - id: protect-env
    kind: path
    action: deny
    path: "**/.env*"
    reason: secrets
`;

describe("loadPolicy", () => {
  it("loads a valid policy with rules intact", () => {
    const policy = loadPolicy(validPolicy);
    expect(policy.version).toBe(1);
    expect(policy.name).toBe("test");
    expect(policy.default).toBe("allow");
    expect(policy.rules).toHaveLength(3);
    const rule = policy.rules[0]!;
    expect(rule).toMatchObject({ id: "rm-recursive", kind: "command", action: "deny" });
  });

  it("defaults to allow-all when the default key is absent", () => {
    const policy = loadPolicy(`
version: 1
rules:
  - id: deny-everything
    kind: path
    action: deny
    path: "**/secret/**"
    reason: nope
`);
    expect(policy.default).toBe("allow");
  });

  it("rejects an unknown schema version", () => {
    expect(() => loadPolicy("version: 2\nrules: []\n")).toThrow(PolicyError);
    expect(() => loadPolicy("version: 2\nrules: []\n")).toThrow(/version/i);
  });

  it("rejects invalid yaml with a clear error", () => {
    expect(() => loadPolicy("rules: [ this is: not: valid")).toThrow(PolicyError);
  });

  it("rejects a rule with neither program nor pattern", () => {
    expect(() =>
      loadPolicy(`
version: 1
rules:
  - id: broken
    kind: command
    action: deny
    reason: ???
`),
    ).toThrow(/program|pattern/i);
  });

  it("rejects a rule with both program and pattern", () => {
    expect(() =>
      loadPolicy(`
version: 1
rules:
  - id: greedy
    kind: command
    action: deny
    program: rm
    pattern: "rm.*"
    reason: ???
`),
    ).toThrow(/mutually exclusive/i);
  });

  it("rejects an invalid regex pattern at load time, not at match time", () => {
    expect(() =>
      loadPolicy(`
version: 1
rules:
  - id: bad-regex
    kind: command
    action: deny
    pattern: "([unclosed"
    reason: ???
`),
    ).toThrow(/regex/i);
  });

  it("rejects an unknown action", () => {
    expect(() =>
      loadPolicy(`
version: 1
rules:
  - id: weird
    kind: command
    action: nuke
    program: rm
    reason: ???
`),
    ).toThrow(/action/i);
  });

  it("rejects a rule with a missing id", () => {
    expect(() =>
      loadPolicy(`
version: 1
rules:
  - kind: path
    action: deny
    path: "**/.env*"
    reason: ???
`),
    ).toThrow(/id/i);
  });

  it("rejects duplicate rule ids", () => {
    expect(() =>
      loadPolicy(`
version: 1
rules:
  - id: dup
    kind: path
    action: deny
    path: "**/a/**"
    reason: x
  - id: dup
    kind: path
    action: deny
    path: "**/b/**"
    reason: y
`),
    ).toThrow(/duplicate/i);
  });
});
