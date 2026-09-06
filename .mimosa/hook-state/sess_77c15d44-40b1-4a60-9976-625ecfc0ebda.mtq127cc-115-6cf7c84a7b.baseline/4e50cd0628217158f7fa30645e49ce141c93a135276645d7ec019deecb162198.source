import { mergeHooksEntry } from "../common.js";

export const GROK_HOOK_COMMAND = "reins hook grok";
export const GROK_EVENT = "PreToolUse";

/** Grok Build reads standalone JSON files from ~/.grok/hooks/*.json. Each file
 *  is {"hooks": {"PreToolUse": [group, ...]}}. We omit `matcher` so every
 *  tool call is policy-checked; non-command/file inputs fall through to the
 *  policy default. Existing groups (the user's own or other tools') in the
 *  same reins file are preserved. */
export function grokHooksFileContent(existingContent: string | null): string {
  let existing: unknown = {};
  if (existingContent !== null && existingContent.trim() !== "") {
    try {
      existing = JSON.parse(existingContent);
    } catch {
      existing = {};
    }
  }
  const { settings } = mergeHooksEntry(existing, {
    event: GROK_EVENT,
    // no matcher: check every tool call
    command: GROK_HOOK_COMMAND,
    timeout: 10,
  });
  return JSON.stringify(settings, null, 2) + "\n";
}

export function hasGrokHook(existingContent: string | null): boolean {
  if (existingContent === null) return false;
  try {
    const { changed } = mergeHooksEntry(JSON.parse(existingContent), {
      event: GROK_EVENT,
      command: GROK_HOOK_COMMAND,
    });
    return !changed;
  } catch {
    return false;
  }
}
