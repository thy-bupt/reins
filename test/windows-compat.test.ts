import { describe, expect, it } from "vitest";
import { matchesPathGlob, resolveShellCommand } from "../src/core/matchers.js";
import { loadPolicy } from "../src/core/policy.js";
import { decide } from "../src/core/decider.js";

describe("resolveShellCommand (win32 vs posix)", () => {
  it("uses /bin/bash -c style on posix", () => {
    const { file, args } = resolveShellCommand("posix", "echo hi");
    expect(file).toBe("/bin/bash");
    expect(args).toEqual(["-c", "echo hi"]);
  });

  it("uses cmd.exe /d /s /c on win32", () => {
    const { file, args } = resolveShellCommand("win32", "echo hi");
    expect(file?.toLowerCase()).toContain("cmd.exe");
    expect(args).toEqual(["/d", "/s", "/c", "echo hi"]);
  });

  it("honors the shell override on any platform", () => {
    const { file, args } = resolveShellCommand("win32", "echo hi", "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    expect(file).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    expect(args).toEqual(["-c", "echo hi"]);
  });

  it("leaves multi-line commands intact for the shell", () => {
    const { args } = resolveShellCommand("win32", "echo a && echo b");
    expect(args).toEqual(["/d", "/s", "/c", "echo a && echo b"]);
  });
});

describe("windows path matching", () => {
  const policy = loadPolicy(`
version: 1
default: allow
rules:
  - id: protect-env
    kind: path
    action: deny
    path: "**/.env*"
    reason: "secrets"
  - id: protect-ssh
    kind: path
    action: deny
    path: "**/.ssh/**"
    reason: "ssh keys"
`);

  it("matches backslash Windows paths against forward-slash globs", () => {
    expect(matchesPathGlob("**/.env*", "C:\\repo\\.env")).toBe(true);
    expect(matchesPathGlob("**/.env*", "C:\\repo\\.env.local")).toBe(true);
    expect(matchesPathGlob("**/.ssh/**", "C:\\Users\\tangh\\.ssh\\id_ed25519")).toBe(true);
  });

  it("denies Windows file writes through the decider", () => {
    const result = decide(policy, {
      tool: "Write",
      input: { file_path: "C:\\repo\\.env" },
    });
    expect(result.decision).toBe("deny");
    expect(result.matchedRule).toBe("protect-env");
  });

  it("does not flag benign Windows source files", () => {
    const result = decide(policy, {
      tool: "Write",
      input: { file_path: "C:\\repo\\src\\index.ts" },
    });
    expect(result.decision).toBe("allow");
  });
});
