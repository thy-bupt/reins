import type { Policy } from "../../core/policy.js";
import type { TraceWriter } from "../../core/trace.js";
import {
  normalizeLoosePayload,
  runAdapterHook,
  type HookOutcome,
} from "../common.js";

/**
 * pi hook handler. pi runs our generated extension in-process; the extension
 * subscribes to `tool_call`, shells out to `reins hook pi` with our
 * payload contract ({ tool, args }), and returns { block: true, reason } when
 * the policy denies. There is no ask channel: ask rules fail closed.
 */
export async function handleToolCall(
  payload: unknown,
  opts: { policy: Policy; trace: TraceWriter },
): Promise<HookOutcome> {
  return runAdapterHook(normalizeLoosePayload(payload), {
    policy: opts.policy,
    trace: opts.trace,
    channel: "pi",
  });
}
