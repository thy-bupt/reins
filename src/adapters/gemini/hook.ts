import type { Policy } from "../../core/policy.js";
import type { TraceWriter } from "../../core/trace.js";
import {
  normalizeSnakeCasePayload,
  runAdapterHook,
  type HookOutcome,
} from "../common.js";

/**
 * Gemini CLI BeforeTool hook handler. The payload shape is the same
 * snake_case JSON as Claude Code (tool_name / tool_input), and exit code 2
 * blocks with stderr as the rejection reason. There is no documented "ask"
 * channel, so ask rules fail closed with the reason on stderr.
 */
export async function handleBeforeTool(
  payload: unknown,
  opts: { policy: Policy; trace: TraceWriter },
): Promise<HookOutcome> {
  return runAdapterHook(normalizeSnakeCasePayload(payload), {
    policy: opts.policy,
    trace: opts.trace,
    channel: "gemini",
  });
}
