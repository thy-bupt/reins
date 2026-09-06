import type { Policy } from "../../core/policy.js";
import type { TraceWriter } from "../../core/trace.js";
import {
  normalizeLoosePayload,
  runAdapterHook,
  type HookOutcome,
} from "../common.js";

/**
 * opencode hook handler. opencode runs our generated plugin in-process; the
 * plugin shells out to `railguard hook opencode` with our payload contract
 * ({ tool, args }) and throws on a non-zero exit, which blocks the tool call.
 * There is no ask channel: ask rules fail closed.
 */
export async function handleToolExecute(
  payload: unknown,
  opts: { policy: Policy; trace: TraceWriter },
): Promise<HookOutcome> {
  return runAdapterHook(normalizeLoosePayload(payload), {
    policy: opts.policy,
    trace: opts.trace,
    channel: "opencode",
  });
}
