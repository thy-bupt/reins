import type { Policy } from "../../core/policy.js";
import type { TraceWriter } from "../../core/trace.js";
import {
  normalizeSnakeCasePayload,
  runAdapterHook,
  type HookOutcome,
} from "../common.js";

/**
 * Codex PreToolUse hook handler. Codex's hook protocol mirrors Claude Code's:
 * snake_case payload on stdin, exit code 2 blocks with stderr as the reason,
 * and hookSpecificOutput.permissionDecision is supported. There is no
 * documented "ask" channel, so ask rules fail closed.
 */
export async function handlePreToolUse(
  payload: unknown,
  opts: { policy: Policy; trace: TraceWriter },
): Promise<HookOutcome> {
  return runAdapterHook(normalizeSnakeCasePayload(payload), {
    policy: opts.policy,
    trace: opts.trace,
    channel: "codex",
  });
}
