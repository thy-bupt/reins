import { decide, type ToolEvent } from "../core/decider.js";
import type { Policy } from "../core/policy.js";
import { TraceWriter } from "../core/trace.js";

export interface HookOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type HookChannel = "claude" | "gemini" | "grok" | "codex" | "opencode" | "pi";

export const FAIL_CLOSED_STDERR =
  "[railguard] invalid hook payload — blocking (fail-closed). Run `railguard doctor` if this persists.";

export interface ChannelEncoding {
  /** channels with a real "ask" channel render ask as JSON; others fail closed */
  supportsAsk: boolean;
}

const ENCODINGS: Record<HookChannel, ChannelEncoding> = {
  claude: { supportsAsk: true },
  gemini: { supportsAsk: false },
  grok: { supportsAsk: false },
  codex: { supportsAsk: false },
  opencode: { supportsAsk: false },
  pi: { supportsAsk: false },
};

/**
 * Shared adapter engine: normalize (per agent, upstream) → decide → trace →
 * encode (per channel). A null event means the payload was malformed and the
 * hook fails closed.
 */
export async function runAdapterHook(
  event: ToolEvent | null,
  opts: { policy: Policy; trace: TraceWriter; channel: HookChannel },
): Promise<HookOutcome> {
  if (event === null) {
    await opts.trace.append({
      tool: "unknown",
      input: null,
      decision: "deny",
      reason: FAIL_CLOSED_STDERR,
      result: "blocked",
      exitCode: 2,
    });
    return { exitCode: 2, stdout: "", stderr: FAIL_CLOSED_STDERR };
  }

  const result = decide(opts.policy, event);

  await opts.trace.append({
    tool: event.tool,
    input: event.input,
    decision: result.decision,
    reason: result.reason,
    matchedRule: result.matchedRule,
    result: result.decision === "deny" ? "blocked" : undefined,
    exitCode: result.decision === "deny" ? 2 : undefined,
  });

  const channel = ENCODINGS[opts.channel];

  if (result.decision === "deny") {
    return {
      exitCode: 2,
      stdout: "",
      stderr: `[railguard] blocked by rule "${result.matchedRule ?? "default"}": ${result.reason ?? "policy denied this action"}`,
    };
  }

  if (result.decision === "ask") {
    if (!channel.supportsAsk) {
      // no interactive ask channel on this agent: fail closed with the reason
      return {
        exitCode: 2,
        stdout: "",
        stderr: `[railguard] requires human approval (ask) — rule "${result.matchedRule ?? "default"}": ${result.reason ?? "policy wants a human decision"}`,
      };
    }
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

/** Claude Code, Codex and Gemini CLI share the same snake_case payload shape
 *  (tool_name / tool_input). Codex's own test suite asserts these exact keys. */
export function normalizeSnakeCasePayload(payload: unknown): ToolEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p["tool_name"] !== "string" || p["tool_name"].trim() === "") return null;
  const toolInput = p["tool_input"];
  if (typeof toolInput !== "object" || toolInput === null) return null;
  return {
    tool: p["tool_name"],
    input: toolInput as Record<string, unknown>,
  };
}

/** Grok Build sends the same fields in camelCase. */
export function normalizeCamelCasePayload(payload: unknown): ToolEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p["toolName"] !== "string" || p["toolName"].trim() === "") return null;
  const toolInput = p["toolInput"];
  if (typeof toolInput !== "object" || toolInput === null) return null;
  return {
    tool: p["toolName"],
    input: toolInput as Record<string, unknown>,
  };
}

/** In-process agents (opencode plugin, pi extension) call `railguard hook
 *  <agent>` with our own contract: { tool, args }. Tool input keys vary per
 *  agent ("command", "filePath", "path"…) — pick the ones the decider knows. */
export function normalizeLoosePayload(payload: unknown): ToolEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p["tool"] !== "string" || p["tool"].trim() === "") return null;
  const args = typeof p["args"] === "object" && p["args"] !== null ? (p["args"] as Record<string, unknown>) : {};
  const input: Record<string, unknown> = {};

  const command = args["command"];
  if (typeof command === "string" && command.trim() !== "") input["command"] = command;

  const path = args["file_path"] ?? args["filePath"] ?? args["path"] ?? args["notebook_path"];
  if (typeof path === "string" && path.trim() !== "") input["file_path"] = path;

  return { tool: p["tool"], input };
}

export function sessionIdFrom(payload: unknown, fallbackPrefix: string): string {
  if (typeof payload === "object" && payload !== null) {
    const p = payload as Record<string, unknown>;
    for (const key of ["session_id", "sessionId", "sessionID"]) {
      const value = p[key];
      if (typeof value === "string" && value.trim() !== "") return value;
    }
  }
  return `${fallbackPrefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}

interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

function entryHasCommand(entry: unknown, command: string): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const hooks = (entry as { hooks?: unknown }).hooks;
  return Array.isArray(hooks) && hooks.some((h) => (h as { command?: string })?.command === command);
}

/** Pure merge for hook-object settings (Claude Code, Gemini CLI, Codex
 *  hooks.json): ensure exactly one railguard entry for the event, preserve
 *  everything else. Idempotent and non-mutating. Omit `matcher` to check
 *  every tool call. */
export function mergeHooksEntry(
  existing: unknown,
  opts: { event: string; matcher?: string; command: string; timeout?: number },
): { settings: Record<string, unknown>; changed: boolean } {
  const settings: Record<string, unknown> =
    typeof existing === "object" && existing !== null
      ? (structuredClone(existing) as Record<string, unknown>)
      : {};

  const hooks =
    typeof settings["hooks"] === "object" && settings["hooks"] !== null
      ? (settings["hooks"] as Record<string, unknown>)
      : (settings["hooks"] = {});

  const list = Array.isArray(hooks[opts.event]) ? (hooks[opts.event] as unknown[]) : [];

  if (list.some((e) => entryHasCommand(e, opts.command))) {
    return { settings, changed: false };
  }

  const hook: HookCommand = { type: "command", command: opts.command, timeout: opts.timeout };
  const entry: HookEntry = { hooks: [hook] };
  if (opts.matcher !== undefined) entry.matcher = opts.matcher;
  hooks[opts.event] = [...list, entry];
  return { settings, changed: true };
}

/** true when settings already carry a railguard hook entry for the event. */
export function hasHooksEntry(
  settings: unknown,
  opts: { event: string; command: string },
): boolean {
  if (typeof settings !== "object" || settings === null) return false;
  const hooks = (settings as Record<string, unknown>)["hooks"];
  if (typeof hooks !== "object" || hooks === null) return false;
  const list = (hooks as Record<string, unknown>)[opts.event];
  return Array.isArray(list) && list.some((e) => entryHasCommand(e, opts.command));
}
