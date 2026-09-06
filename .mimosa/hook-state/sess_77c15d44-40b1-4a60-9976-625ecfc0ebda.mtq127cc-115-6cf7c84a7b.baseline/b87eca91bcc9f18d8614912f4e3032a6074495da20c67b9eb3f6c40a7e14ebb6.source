import type { Policy } from "../../core/policy.js";
import type { TraceWriter } from "../../core/trace.js";
import {
  normalizeCamelCasePayload,
  runAdapterHook,
  type HookOutcome,
} from "../common.js";

/**
 * Grok Build PreToolUse hook handler. Grok sends the Claude-style payload in
 * camelCase and blocks on exit code 2 (stderr becomes the reason). Note: Grok
 * Build itself fails open on hook crashes/timeouts — our hook always exits
 * cleanly; see README limitations.
 */
export async function handlePreToolUse(
  payload: unknown,
  opts: { policy: Policy; trace: TraceWriter },
): Promise<HookOutcome> {
  return runAdapterHook(normalizeCamelCasePayload(payload), {
    policy: opts.policy,
    trace: opts.trace,
    channel: "grok",
  });
}
