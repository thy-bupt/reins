import { hasHooksEntry, mergeHooksEntry } from "../common.js";

export const REINS_HOOK_MATCHER = "Bash|Write|Edit|MultiEdit|NotebookEdit";
export const REINS_HOOK_COMMAND = "reins hook claude";
const CLAUDE_EVENT = "PreToolUse";

/** Merge the reins PreToolUse entry into Claude Code settings.json. */
export function mergeSettings(existing: unknown) {
  return mergeHooksEntry(existing, {
    event: CLAUDE_EVENT,
    matcher: REINS_HOOK_MATCHER,
    command: REINS_HOOK_COMMAND,
    timeout: 15,
  });
}

/** true when the settings already carry the reins hook entry. */
export function hasReinsHook(settings: unknown): boolean {
  return hasHooksEntry(settings, { event: CLAUDE_EVENT, command: REINS_HOOK_COMMAND });
}
