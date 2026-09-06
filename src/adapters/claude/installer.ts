export const RAILGUARD_HOOK_MATCHER = "Bash|Write|Edit|MultiEdit|NotebookEdit";
export const RAILGUARD_HOOK_COMMAND = "railguard hook claude";

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}

interface HookEntry {
  matcher: string;
  hooks: HookCommand[];
}

interface SettingsWithHooks {
  hooks?: { [event: string]: HookEntry[] | undefined };
  [key: string]: unknown;
}

export interface MergeResult {
  settings: Record<string, unknown>;
  changed: boolean;
}

function isRailguardEntry(entry: HookEntry): boolean {
  return Array.isArray(entry.hooks) && entry.hooks.some((h) => h.command === RAILGUARD_HOOK_COMMAND);
}

/** Pure merge: ensure exactly one railguard PreToolUse entry, preserve all
 *  other settings. Idempotent and non-mutating. */
export function mergeSettings(existing: unknown): MergeResult {
  const settings: SettingsWithHooks =
    typeof existing === "object" && existing !== null
      ? (structuredClone(existing) as SettingsWithHooks)
      : {};

  const hooks = settings.hooks ?? (settings.hooks = {});
  const preToolUse = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];

  if (preToolUse.some(isRailguardEntry)) {
    return { settings: settings as Record<string, unknown>, changed: false };
  }

  preToolUse.push({
    matcher: RAILGUARD_HOOK_MATCHER,
    hooks: [{ type: "command", command: RAILGUARD_HOOK_COMMAND, timeout: 15 }],
  });
  hooks.PreToolUse = preToolUse;
  return { settings: settings as Record<string, unknown>, changed: true };
}
