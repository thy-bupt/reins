import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLang, writeLang } from "../src/llm/config.js";

describe("readLang / writeLang (round-5: bilingual TUI config)", () => {
  it("returns undefined when no config file exists", () => {
    expect(readLang(join(tmpdir(), "no-such-config.yaml"))).toBeUndefined();
  });

  it("reads lang from a config file", () => {
    const dir = join(tmpdir(), `reins-lang-${Math.random().toString(36).slice(2)}`);
    const cfgPath = join(dir, "config.yaml");
    writeFileSync(cfgPath, "lang: zh\nllm:\n  provider: command\n  command: test\n");
    expect(readLang(cfgPath)).toBe("zh");
  });

  it("returns en for unrecognized lang value", () => {
    const dir = join(tmpdir(), `reins-lang-${Math.random().toString(36).slice(2)}`);
    const cfgPath = join(dir, "config.yaml");
    writeFileSync(cfgPath, "lang: fr\n");
    expect(readLang(cfgPath)).toBe("en");
  });

  it("writeLang persists lang without destroying llm section", () => {
    const dir = join(tmpdir(), `reins-lang-${Math.random().toString(36).slice(2)}`);
    const cfgPath = join(dir, "config.yaml");
    writeFileSync(cfgPath, "lang: en\nllm:\n  provider: command\n  command: test\n");
    writeLang("zh", cfgPath);
    const cfg = readFileSync(cfgPath, "utf8");
    expect(cfg).toContain("lang: zh");
    expect(cfg).toContain("provider: command");
  });

  it("writeLang round-trips", () => {
    const cfgPath = join(tmpdir(), `reins-lang-rt-${Math.random().toString(36).slice(2)}`, "config.yaml");
    writeLang("zh", cfgPath);
    expect(readLang(cfgPath)).toBe("zh");
    writeLang("en", cfgPath);
    expect(readLang(cfgPath)).toBe("en");
  });
});
