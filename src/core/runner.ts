import { spawn } from "node:child_process";
import type { DecisionResult } from "./decider.js";
import { TraceWriter } from "./trace.js";

export interface RunGuardedOptions {
  command: string;
  trace: TraceWriter;
  cwd?: string;
  shell?: string;
  /** precomputed policy decision; deny/ask block without executing. */
  decision?: DecisionResult;
}

export interface RunResult {
  blocked: boolean;
  exitCode: number;
}

/**
 * Execute a shell command through the rail: policy gate first, then process
 * supervision, then an auditable trace record with the outcome.
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
    });
    return { blocked: true, exitCode: 2 };
  }

  const shell = opts.shell ?? process.env.REINS_SHELL ?? "/bin/bash";
  const input: Record<string, unknown> = { command: opts.command };
  if (opts.cwd !== undefined) input.cwd = opts.cwd;

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(shell, ["-c", opts.command], {
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
  });

  return { blocked: false, exitCode };
}
