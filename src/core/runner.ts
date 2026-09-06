import { spawn } from "node:child_process";
import { TraceWriter } from "./trace.js";

export interface RunGuardedOptions {
  command: string;
  trace: TraceWriter;
  cwd?: string;
  shell?: string;
}

export interface RunResult {
  blocked: boolean;
  exitCode: number;
}

/**
 * Execute a shell command through the rail: appends an auditable trace event
 * with the outcome. Policy evaluation lands in the decider (M2); this module
 * only owns process supervision and the exec trace record.
 */
export async function runGuarded(opts: RunGuardedOptions): Promise<RunResult> {
  const shell = opts.shell ?? process.env.RAILGUARD_SHELL ?? "/bin/bash";
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
    result: exitCode === 0 ? "ok" : "error",
    exitCode,
  });

  return { blocked: false, exitCode };
}
