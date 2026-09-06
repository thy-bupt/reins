import { describe, expect, it } from "vitest";
import { RAILGUARD_HOOK_COMMAND, RAILGUARD_HOOK_MATCHER, mergeSettings } from "../src/adapters/claude/installer.js";

describe("mergeSettings", () => {
  it("adds a railguard PreToolUse hook entry to empty settings", () => {
    const { settings, changed } = mergeSettings({});
    expect(changed).toBe(true);

    const hooks = (settings as { hooks: { PreToolUse: Array<Record<string, unknown>> } }).hooks;
    expect(hooks.PreToolUse).toHaveLength(1);
    const entry = hooks.PreToolUse[0]!;
    expect(entry.matcher).toBe(RAILGUARD_HOOK_MATCHER);
    const innerHooks = entry.hooks as Array<{ type: string; command: string }>;
    expect(innerHooks).toHaveLength(1);
    expect(innerHooks[0]!.command).toBe(RAILGUARD_HOOK_COMMAND);
    expect(innerHooks[0]!.type).toBe("command");
  });

  it("preserves unrelated settings and other hooks", () => {
    const existing = {
      model: "opus",
      hooks: {
        PreToolUse: [
          {
            matcher: "Write",
            hooks: [{ type: "command", command: "my-other-tool guard" }],
          },
        ],
        PostToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: "logger" }] }],
      },
    };
    const { settings, changed } = mergeSettings(existing);

    expect(changed).toBe(true);
    expect((settings as { model: string }).model).toBe("opus");
    const pre = (settings as { hooks: { PreToolUse: Array<{ matcher: string }> } }).hooks.PreToolUse;
    expect(pre).toHaveLength(2);
    expect(pre[0]!.matcher).toBe("Write");
    expect(pre[1]!.matcher).toBe(RAILGUARD_HOOK_MATCHER);
    const post = (settings as { hooks: { PostToolUse: unknown[] } }).hooks.PostToolUse;
    expect(post).toHaveLength(1);
  });

  it("is idempotent: a second merge changes nothing", () => {
    const once = mergeSettings({});
    const twice = mergeSettings(once.settings);
    expect(twice.changed).toBe(false);

    const hooks = (twice.settings as { hooks: { PreToolUse: unknown[] } }).hooks.PreToolUse;
    expect(hooks).toHaveLength(1);
  });

  it("detects its own entry even when the user reordered hooks", () => {
    const once = mergeSettings({}).settings as {
      hooks: { PreToolUse: Array<Record<string, unknown>> };
    };
    const reordered = {
      hooks: { PreToolUse: [...(once.hooks.PreToolUse ?? [])].reverse() },
    };
    const again = mergeSettings(reordered);
    expect(again.changed).toBe(false);
    expect((again.settings as { hooks: { PreToolUse: unknown[] } }).hooks.PreToolUse).toHaveLength(1);
  });

  it("does not mutate the input object", () => {
    const existing = { hooks: { PreToolUse: [] as unknown[] } };
    const snapshot = JSON.stringify(existing);
    mergeSettings(existing);
    expect(JSON.stringify(existing)).toBe(snapshot);
  });
});
