import type { DecisionResult } from "../../core/decider.js";
import type { Policy } from "../../core/policy.js";
import { decide } from "../../core/decider.js";
import { TraceWriter } from "../../core/trace.js";

export interface ClaudeHookPayload {
  session_id?: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface HookOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const FAIL_CLOSED_STDERR = "[railguard] invalid hook payload — blocking (fail-closed). Run `railguard doctor` if this persists.";

/**
 * PreToolUse hook handler. Protocol:
 *  - deny  -> exit code 2, reason on stderr (fed back to the agent)
 *  - ask   -> exit 0 + JSON permissionDecision on stdout
 *  - allow -> exit 0, silent
 * Malformed payloads fail closed: exit 2.
 */
export async function handlePreToolUse(
  payload: unknown,
  opts: { policy: Policy; trace: TraceWriter },
): Promise<HookOutcome> {
  const event = normalize(payload);
  if (!event) {
    await opts.trace.append({
      tool: "unknown",
      input: payload ?? null,
      decision: "deny",
      reason: FAIL_CLOSED_STDERR,
      result: "blocked",
      exitCode: 2,
    });
    return { exitCode: 2, stdout: "", stderr: FAIL_CLOSED_STDERR };
  }

  const result: DecisionResult = decide(opts.policy, {
    tool: event.tool_name,
    input: event.tool_input ?? {},
  });

  await opts.trace.append({
    tool: event.tool_name,
    input: event.tool_input,
    decision: result.decision,
    reason: result.reason,
    matchedRule: result.matchedRule,
    result: result.decision === "deny" ? "blocked" : undefined,
    exitCode: result.decision === "deny" ? 2 : undefined,
  });

  if (result.decision === "deny") {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `[railguard] blocked by rule "${result.matchedRule ?? "default"}": ${result.reason ?? "policy denied this action"}`,
    };
  }

  if (result.decision === "ask") {
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: `[railguard] ${result.matchedRule ?? "default"}: ${result.reason ?? "policy wants a human decision"}`,
        },
      }),
      stderr: "",
    };
  }

  return { exitCode: 0, stdout: "", stderr: "" };
}

function normalize(payload: unknown): ClaudeHookPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p["tool_name"] !== "string" || p["tool_name"].trim() === "") return null;
  const toolInput = p["tool_input"];
  if (typeof toolInput !== "object" || toolInput === null) return null;
  return {
    session_id: typeof p["session_id"] === "string" ? p["session_id"] : undefined,
    tool_name: p["tool_name"] as string,
    tool_input: toolInput as Record<string, unknown>,
  };
}
