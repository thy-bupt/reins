import { mergeHooksEntry } from "../common.js";

export const GEMINI_HOOK_MATCHER = "run_shell_command|write_file|replace";
export const GEMINI_HOOK_COMMAND = "railguard hook gemini";
const GEMINI_EVENT = "BeforeTool";

/** Merge the railguard BeforeTool entry into Gemini CLI settings.json. */
export function mergeGeminiSettings(existing: unknown) {
  return mergeHooksEntry(existing, {
    event: GEMINI_EVENT,
    matcher: GEMINI_HOOK_MATCHER,
    command: GEMINI_HOOK_COMMAND,
    timeout: 15,
  });
}

export function hasGeminiHook(settingsContent: string | null): boolean {
  if (settingsContent === null) return false;
  try {
    return mergeGeminiSettings(JSON.parse(settingsContent)).changed === false;
  } catch {
    return false;
  }
}
