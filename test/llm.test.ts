import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadLlmConfig, InvalidLlmConfigError } from "../src/llm/config.js";
import { assertPublicHttpUrl } from "../src/llm/provider.js";
import { parseProposals, validateProposal } from "../src/llm/suggest.js";
import { loadPolicy } from "../src/core/policy.js";
import { TraceWriter } from "../src/core/trace.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist", "cli", "main.js");
const cli = existsSync(DIST);

describe("loadLlmConfig", () => {
  it("returns provider none when no config file exists", () => {
    const cfg = loadLlmConfig(join(tmpdir(), "no-such-config.yaml"));
    expect(cfg.provider).toBe("none");
  });

  it("reads a command provider", () => {
    const dir = mkdtempSyncDir();
    const cfgPath = join(dir, "config.yaml");
    writeFileSync(cfgPath, "llm:\n  provider: command\n  command: 'ollama run qwen2.5'\n");
    const cfg = loadLlmConfig(cfgPath);
    expect(cfg.provider).toBe("command");
    expect(cfg.command).toBe("ollama run qwen2.5");
  });

  it("degrades to none when a command provider has no command", () => {
    const dir = mkdtempSyncDir();
    const cfgPath = join(dir, "config.yaml");
    writeFileSync(cfgPath, "llm:\n  provider: command\n");
    expect(loadLlmConfig(cfgPath).provider).toBe("none");
  });

  it("throws InvalidLlmConfigError on unparseable yaml (user error, not silent off)", () => {
    const dir = mkdtempSyncDir();
    const cfgPath = join(dir, "config.yaml");
    writeFileSync(cfgPath, "llm: [ this is: broken");
    expect(() => loadLlmConfig(cfgPath)).toThrow(InvalidLlmConfigError);
  });
});

describe("assertPublicHttpUrl", () => {
  it("allows public https endpoints", () => {
    expect(() => assertPublicHttpUrl("https://api.openai.com/v1")).not.toThrow();
  });
  it("rejects loopback and private targets", () => {
    for (const bad of ["http://localhost:11434/v1", "http://127.0.0.1:8080", "http://10.0.0.5/v1", "http://192.168.1.1/v1", "file:///etc/passwd"]) {
      expect(() => assertPublicHttpUrl(bad), bad).toThrow();
    }
  });
});

describe("parseProposals", () => {
  it("parses fenced JSON proposals", () => {
    const out = '```json\n{"proposals":[{"kind":"command","action":"deny","program":"curl","reason":"test"}]}\n```';
    const proposals = parseProposals(out);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: "command", program: "curl" });
  });

  it("extracts JSON embedded in prose", () => {
    const proposals = parseProposals('Here is my analysis: {"proposals":[{"kind":"path","action":"deny","path":"**/infra/**","reason":"critical"}]} done');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.kind).toBe("path");
  });

  it("throws on non-JSON output", () => {
    expect(() => parseProposals("sorry, I cannot help with that")).toThrow(/JSON/);
  });

  it("drops entries with missing action or reason", () => {
    const out = '{"proposals":[{"kind":"command","action":"deny","program":"rm","reason":"ok"},{"kind":"command","action":"denyyy","program":"rm","reason":"x"},{"kind":"command","action":"deny","program":"rm"}]}';
    expect(parseProposals(out)).toHaveLength(1);
  });
});

describe("validateProposal (deterministic verification of LLM output)", () => {
  const existing = loadPolicy("version: 1\ndefault: allow\nrules: []\n");

  it("rejects a proposal that would block an innocent corpus command", () => {
    const verdict = validateProposal(
      { kind: "command", action: "deny", program: "echo", pattern: "rm -rf", reason: "blocks echo of scary text" },
      existing,
      [],
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.problems.some((p) => p.includes("false positive"))).toBe(true);
  });

  it("accepts a scoped dangerous-command rule with zero corpus false positives", () => {
    const verdict = validateProposal(
      { kind: "command", action: "deny", program: "mkfs", reason: "formats filesystems" },
      existing,
      [],
    );
    expect(verdict.accepted).toBe(true);
    expect(verdict.yaml).toContain("program: mkfs");
  });

  it("reports replay impact against real session ledgers", async () => {
    const dir = mkdtempSyncDir();
    const sessions = join(dir, "sessions");
    const writer = await TraceWriter.open(join(sessions, "claude-impact.jsonl"));
    await writer.append({
      tool: "Bash",
      input: { command: "mkfs /dev/sda1" },
      decision: "allow", // was allowed under the empty policy
    });
    const verdict = validateProposal(
      { kind: "command", action: "deny", program: "mkfs", reason: "formats filesystems" },
      existing,
      [join(sessions, "claude-impact.jsonl")],
    );
    expect(verdict.accepted).toBe(true);
    expect(verdict.impact.newBlocks).toBe(1);
    expect(verdict.impact.allowEvents).toBe(1);
  });
});

describe.skipIf(!cli)("LLM CLI graceful degradation (provider=none)", () => {
  it("reins suggest exits non-zero with configuration guidance", () => {
    const h = mkdtempSyncDir();
    const r = spawnSync(process.execPath, [DIST, "suggest"], {
      env: { ...process.env, REINS_HOME: h },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("LLM is not configured");
    expect(r.stderr).toContain("docs/LLM.md");
  });

  it("reins explain exits non-zero with configuration guidance", () => {
    const h = mkdtempSyncDir();
    const r = spawnSync(process.execPath, [DIST, "explain"], {
      env: { ...process.env, REINS_HOME: h },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("LLM is not configured");
  });
});

function mkdtempSyncDir(): string {
  const dir = join(tmpdir(), `reins-llm-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
