import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLang, writeLang } from "../src/llm/config.js";

function makeCfg(lang: string): { dir: string; cfgPath: string } {
  const dir = join(tmpdir(), `reins-lang-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const cfgPath = join(dir, "config.yaml");
  writeFileSync(cfgPath, `lang: ${lang}\nllm:\n  provider: command\n  command: test\n`);
  return { dir, cfgPath };
}

describe("readLang / writeLang (round-5: bilingual TUI config)", () => {
  it("returns undefined when no config file exists", () => {
    expect(readLang(join(tmpdir(), "no-such-config.yaml"))).toBeUndefined();
  });

  it("reads lang from a config file", () => {
    const { cfgPath } = makeCfg("zh");
    expect(readLang(cfgPath)).toBe("zh");
  });

  it("returns en for unrecognized lang value", () => {
    const { cfgPath } = makeCfg("fr");
    expect(readLang(cfgPath)).toBeUndefined();
  });

  it("writeLang persists lang without destroying llm section", () => {
    const { cfgPath } = makeCfg("en");
    writeLang("zh", cfgPath);
    const cfg = readFileSync(cfgPath, "utf8");
    expect(cfg).toContain('"lang": "zh"');
    expect(cfg).toContain('"provider": "command"');
  });

  it("writeLang round-trips", () => {
    const cfgPath = join(tmpdir(), `reins-lang-rt-${Math.random().toString(36).slice(2)}`, "config.yaml");
    writeLang("zh", cfgPath);
    expect(readLang(cfgPath)).toBe("zh");
    writeLang("en", cfgPath);
    expect(readLang(cfgPath)).toBe("en");
  });
});
