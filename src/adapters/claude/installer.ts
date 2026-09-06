import { hasHooksEntry, mergeHooksEntry } from "../common.js";

export const RAILGUARD_HOOK_MATCHER = "Bash|Write|Edit|MultiEdit|NotebookEdit";
export const RAILGUARD_HOOK_COMMAND = "railguard hook claude";
const CLAUDE_EVENT = "PreToolUse";

/** Merge the railguard PreToolUse entry into Claude Code settings.json. */
export function mergeSettings(existing: unknown) {
  return mergeHooksEntry(existing, {
    event: CLAUDE_EVENT,
    matcher: RAILGUARD_HOOK_MATCHER,
    command: RAILGUARD_HOOK_COMMAND,
    timeout: 15,
  });
}

/** true when the settings already carry the railguard hook entry. */
export function hasRailguardHook(settings: unknown): boolean {
  return hasHooksEntry(settings, { event: CLAUDE_EVENT, command: RAILGUARD_HOOK_COMMAND });
}
