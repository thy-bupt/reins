import { spawn } from "node:child_process";
import type { DecisionResult } from "./decider.js";
import { resolveShellCommand } from "./matchers.js";
import { TraceWriter } from "./trace.js";

export interface RunGuardedOptions {
  command: string;
  trace: TraceWriter;
  cwd?: string;
  /** precomputed policy decision; deny/ask block without executing. */
  decision?: DecisionResult;
  /** sha256 of the policy used for the decision — recorded on the ledger. */
  policyDigest?: string;
}

export interface RunResult {
  blocked: boolean;
  exitCode: number;
}

/**
 * Execute a shell command through the rail: policy gate first, then process
 * supervision, then an auditable trace record with the outcome.
 *
 * The executing interpreter is ALWAYS the platform default (/bin/bash on
 * posix, cmd.exe on win32) — the same interpreter family the policy was
 * evaluated against. There is deliberately no env or caller override
 * (H1, security audit 2026-09-07): letting the caller pick the interpreter
 * would allow the checked string and the executed content to diverge.
 */
export async function runGuarded(opts: RunGuardedOptions): Promise<RunResult> {
  const decision = opts.decision;

  if (decision && (decision.decision === "deny" || decision.decision === "ask")) {
    // ask has no interactive channel in headless exec mode: fail closed.
    await opts.trace.append({
      tool: "exec",
      input: { command: opts.command },
      decision: decision.decision,
      reason: decision.reason,
      matchedRule: decision.matchedRule,
      result: "blocked",
      exitCode: 2,
      policyDigest: opts.policyDigest,
    });
    return { blocked: true, exitCode: 2 };
  }

  const { file, args } = resolveShellCommand(
    process.platform === "win32" ? "win32" : "posix",
    opts.command,
  );
  const input: Record<string, unknown> = { command: opts.command };
  if (opts.cwd !== undefined) input.cwd = opts.cwd;

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });

  await opts.trace.append({
    tool: "exec",
    input,
    decision: "allow",
    reason: decision?.reason,
    matchedRule: decision?.matchedRule,
    result: exitCode === 0 ? "ok" : "error",
    exitCode,
    policyDigest: opts.policyDigest,
  });

  return { blocked: false, exitCode };
}
