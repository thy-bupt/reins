import type { Policy } from "../../core/policy.js";
import type { TraceWriter } from "../../core/trace.js";
import {
  normalizeSnakeCasePayload,
  runAdapterHook,
  type HookOutcome,
} from "../common.js";

/**
 * Claude Code PreToolUse hook handler. Protocol:
 *  - deny  -> exit code 2, reason on stderr (fed back to the agent)
 *  - ask   -> exit 0 + JSON permissionDecision on stdout
 *  - allow -> exit 0, silent
 * Malformed payloads fail closed: exit 2.
 */
export async function handlePreToolUse(
  payload: unknown,
  opts: { policy: Policy; trace: TraceWriter; policyDigest?: string },
): Promise<HookOutcome> {
  return runAdapterHook(normalizeSnakeCasePayload(payload), {
    policy: opts.policy,
    trace: opts.trace,
    channel: "claude",
    policyDigest: opts.policyDigest,
  });
}
