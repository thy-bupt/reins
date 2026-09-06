import { mergeHooksEntry } from "../common.js";

export const CODEX_HOOK_COMMAND = "railguard hook codex";
const CODEX_EVENT = "PreToolUse";

/** Codex reads ~/.codex/hooks.json (same shape Claude Code uses), gated by
 *  `[features] hooks = true` in config.toml. No matcher: every tool call is
 *  policy-checked. */
export function codexHooksFileContent(existingContent: string | null): string {
  let existing: unknown = {};
  if (existingContent !== null && existingContent.trim() !== "") {
    try {
      existing = JSON.parse(existingContent);
    } catch {
      existing = {};
    }
  }
  const { settings } = mergeHooksEntry(existing, {
    event: CODEX_EVENT,
    command: CODEX_HOOK_COMMAND,
    timeout: 15,
  });
  return JSON.stringify(settings, null, 2) + "\n";
}

export function hasCodexHook(existingContent: string | null): boolean {
  if (existingContent === null) return false;
  try {
    const { changed } = mergeHooksEntry(JSON.parse(existingContent), {
      event: CODEX_EVENT,
      command: CODEX_HOOK_COMMAND,
    });
    return !changed;
  } catch {
    return false;
  }
}

/**
 * Line surgery on config.toml to guarantee `[features] hooks = true` while
 * preserving comments, formatting, and every other table. A full TOML
 * parse/serialize round-trip would destroy user comments — not acceptable
 * for a config file we don't own.
 */
export function ensureHooksFeature(configToml: string | null): { content: string; changed: boolean } {
  const original = configToml ?? "";
  const lines = original.split("\n");

  let featuresIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() === "[features]") {
      featuresIdx = i;
      break;
    }
  }

  if (featuresIdx === -1) {
    if (original.trim() === "") {
      return { content: "[features]\nhooks = true\n", changed: true };
    }
    const glue = original.endsWith("\n") ? "\n" : "\n\n";
    return { content: original + glue + "[features]\nhooks = true\n", changed: true };
  }

  // inside the [features] table, until the next table header
  for (let i = featuresIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      // insert after the last non-blank line of the table, before any
      // trailing blank lines that separate it from the next header
      let insertAt = i;
      while (insertAt - 1 > featuresIdx && lines[insertAt - 1]!.trim() === "") insertAt--;
      lines.splice(insertAt, 0, "hooks = true");
      return { content: lines.join("\n"), changed: true };
    }
    const hooksKey = /^(\s*)hooks\s*=(.*)$/.exec(line);
    if (hooksKey) {
      if (hooksKey[2]!.trim() === "true") {
        return { content: original, changed: false };
      }
      lines[i] = `${hooksKey[1]}hooks = true`;
      return { content: lines.join("\n"), changed: true };
    }
  }

  // table runs to EOF without a hooks key
  lines.splice(lines.length, 0, "hooks = true");
  return { content: lines.join("\n"), changed: true };
}

export function configTomlHasHooksEnabled(configToml: string | null): boolean {
  if (configToml === null) return false;
  const lines = configToml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== "[features]") continue;
    for (let j = i + 1; j < lines.length; j++) {
      const trimmed = lines[j]!.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) break;
      if (/^hooks\s*=\s*true\s*$/.test(trimmed)) return true;
    }
    break;
  }
  return false;
}
