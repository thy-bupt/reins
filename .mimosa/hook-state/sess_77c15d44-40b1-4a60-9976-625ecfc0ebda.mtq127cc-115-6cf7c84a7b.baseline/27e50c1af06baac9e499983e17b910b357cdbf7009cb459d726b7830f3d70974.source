import { describe, expect, it } from "vitest";
import { ensureHooksFeature, codexHooksFileContent, CODEX_HOOK_COMMAND } from "../src/adapters/codex/installer.js";

describe("codexHooksFileContent", () => {
  it("creates a hooks.json with a matcher-less PreToolUse group", () => {
    const parsed = JSON.parse(codexHooksFileContent(null)) as {
      hooks: { PreToolUse: Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }> };
    };
    const group = parsed.hooks.PreToolUse[0]!;
    expect(group.matcher).toBeUndefined();
    expect(group.hooks[0]!.command).toBe(CODEX_HOOK_COMMAND);
    expect(group.hooks[0]!.type).toBe("command");
  });

  it("is idempotent", () => {
    const once = codexHooksFileContent(null);
    const twice = codexHooksFileContent(once);
    const parsed = JSON.parse(twice) as { hooks: { PreToolUse: unknown[] } };
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
  });

  it("preserves foreign hook groups", () => {
    const existing = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "mine.py" }] }] },
    });
    const merged = codexHooksFileContent(existing);
    const parsed = JSON.parse(merged) as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } };
    expect(parsed.hooks.PreToolUse).toHaveLength(2);
    expect(parsed.hooks.PreToolUse[0]!.hooks[0]!.command).toBe("mine.py");
  });
});

describe("ensureHooksFeature (config.toml surgery)", () => {
  it("returns a minimal config when none exists", () => {
    const { content, changed } = ensureHooksFeature(null);
    expect(changed).toBe(true);
    expect(content).toContain("[features]");
    expect(content).toMatch(/hooks\s*=\s*true/);
  });

  it("appends a features section to a config without one, preserving content and comments", () => {
    const config = `# my codex config\nmodel = "o4"\n\n[projects."/repo"]\ntrust = "trusted"\n`;
    const { content, changed } = ensureHooksFeature(config);
    expect(changed).toBe(true);
    expect(content).toContain("# my codex config");
    expect(content).toMatch(/\[features\]\nhooks = true/);
    expect(content).toContain('model = "o4"');
    expect(content).toContain('trust = "trusted"');
  });

  it("inserts hooks=true into an existing [features] table without one", () => {
    const config = `model = "o4"\n\n[features]\nweb_search = true\n\n[mcp_servers.x]\ncommand = "y"\n`;
    const { content, changed } = ensureHooksFeature(config);
    expect(changed).toBe(true);
    expect(content).toMatch(/\[features\]\nweb_search = true\nhooks = true\n/);
    // hooks must land inside [features], not inside the next table
    const featuresIdx = content.indexOf("[features]");
    const nextTableIdx = content.indexOf("[mcp_servers.x]");
    const hooksIdx = content.indexOf("hooks = true");
    expect(hooksIdx).toBeGreaterThan(featuresIdx);
    expect(hooksIdx).toBeLessThan(nextTableIdx);
  });

  it("flips an existing hooks = false to true", () => {
    const config = `[features]\nhooks = false\n`;
    const { content, changed } = ensureHooksFeature(config);
    expect(changed).toBe(true);
    expect(content).toMatch(/hooks = true/);
    expect(content).not.toMatch(/hooks = false/);
  });

  it("reports no change when hooks is already true", () => {
    const config = `[features]\nhooks = true\n`;
    const { changed } = ensureHooksFeature(config);
    expect(changed).toBe(false);
  });

  it("does not confuse [features.foo] subtables with the [features] table", () => {
    const config = `model = "m"\n\n[features.sub]\nx = 1\n`;
    const { content, changed } = ensureHooksFeature(config);
    expect(changed).toBe(true);
    const ownFeatures = content.indexOf("[features]\n");
    const subtable = content.indexOf("[features.sub]");
    expect(ownFeatures).toBeGreaterThanOrEqual(0);
    expect(ownFeatures).not.toBe(subtable);
    expect(content.indexOf("hooks = true")).toBeGreaterThan(ownFeatures - 1);
  });
});
