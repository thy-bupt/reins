import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

  it("rejects unspecified, IPv4-mapped, ULA and link-local IPv6 endpoints (round-4 review)", () => {
    for (const bad of ["http://0.0.0.0:8080", "http://[::ffff:127.0.0.1]:8080", "http://[fc00::1]:8080", "http://[fe80::1]:8080", "http://[::1]:9000"]) {
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
      { kind: "command", action: "deny", pattern: "rm -rf", reason: "blocks echo of scary text" },
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
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
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


describe("round-4 review hardening (proposals)", () => {
  const existing = loadPolicy("version: 1\ndefault: allow\nrules: []\n");

  it("rejects YAML injection attempts inside reason", () => {
    const verdict = validateProposal(
      {
        kind: "command",
        action: "deny",
        program: "mkfs",
        reason: 'safe"\n  - id: injected\n    kind: command\n    action: deny\n    program: echo\n    reason: injected',
      },
      existing,
      [],
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.problems.some((p) => p.includes("control characters"))).toBe(true);
  });

  it("accepts legitimate proposals and marks provenance in reason", () => {
    const verdict = validateProposal(
      { kind: "command", action: "deny", program: "mkfs", reason: "formats filesystems" },
      existing,
      [],
    );
    expect(verdict.accepted).toBe(true);
    expect(verdict.rule?.reason).toContain("[llm-suggested");
  });

  it("rejects an overly broad path rule", () => {
    const verdict = validateProposal(
      { kind: "path", action: "deny", path: "**", reason: "block all files" },
      existing,
      [],
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.problems.some((p) => p.includes("overly broad"))).toBe(true);
  });

  it("path false-positive corpus catches innocent-path blocking rules", () => {
    const verdict = validateProposal(
      { kind: "path", action: "deny", path: "**/README.md", reason: "no readmes" },
      existing,
      [],
    );
    expect(verdict.accepted).toBe(false);
    expect(verdict.problems.some((p) => p.includes("false positive"))).toBe(true);
  });

  it("caps proposals at 3", () => {
    const many = JSON.stringify({
      proposals: [1, 2, 3, 4, 5].map((i) => ({
        kind: "command",
        action: "deny",
        program: `prog${i}`,
        reason: `r${i}`,
      })),
    });
    expect(parseProposals(many)).toHaveLength(3);
  });
});

describe.skipIf(!cli)("suggest --apply e2e (round-4 P0-1 regression)", () => {
  const PROPOSALS = JSON.stringify({
    proposals: [{ kind: "command", action: "deny", program: "mkfs", reason: "formats filesystems" }],
  });
  // fake provider script: ignore stdin, emit fixed proposals JSON. A node
  // script (not `cat`) so it works under cmd.exe on win32 too.
  function setup(h: string, initialPolicy: string) {
    writeFileSync(join(h, "policy.yaml"), initialPolicy);
    const script = join(h, "fake-llm.js");
    writeFileSync(script, `console.log(${JSON.stringify(PROPOSALS)});\n`);
    writeFileSync(join(h, "config.yaml"), `llm:\n  provider: command\n  command: node "${script}"\n`);
  }

  it("apply on rules: [] produces a valid policy that the hook then loads", async () => {
    const h = mkdtempSyncDir();
    setup(h, "version: 1\ndefault: allow\nrules: []\n");
    const apply = spawnSync(process.execPath, [DIST, "suggest", "--apply"], {
      env: { ...process.env, REINS_HOME: h },
      encoding: "utf8",
    });
    expect(apply.status, `apply failed: ${apply.stderr}`).toBe(0);

    const hook = spawnSync(process.execPath, [DIST, "hook", "claude"], {
      env: { ...process.env, REINS_HOME: h },
      input: JSON.stringify({ session_id: "post-apply", tool_name: "Bash", tool_input: { command: "mkfs /dev/sda1" } }),
      encoding: "utf8",
    });
    expect(hook.status).toBe(2);
    expect(hook.stderr).toContain("llm-");
    expect(hook.stderr).toContain("formats filesystems");
  }, 15_000);

  it("apply on a policy with existing rules keeps both old and new", async () => {
    const h = mkdtempSyncDir();
    setup(
      h,
      "version: 1\ndefault: allow\nrules:\n  - id: rm-recursive\n    kind: command\n    action: deny\n    program: rm\n    flags: [\"-r\"]\n    reason: pre-existing\n",
    );
    const apply = spawnSync(process.execPath, [DIST, "suggest", "--apply"], {
      env: { ...process.env, REINS_HOME: h },
      encoding: "utf8",
    });
    expect(apply.status).toBe(0);

    const policy = loadPolicy(readFileSync(join(h, "policy.yaml"), "utf8"));
    const ids = policy.rules.map((r) => r.id);
    expect(ids).toContain("rm-recursive");
    expect(ids.some((id) => id.startsWith("llm-"))).toBe(true);
  }, 15_000);

  it("an all-rejected round leaves policy.yaml byte-identical", async () => {
    const h = mkdtempSyncDir();
    const original = "version: 1\ndefault: allow\nrules: []\n";
    writeFileSync(join(h, "policy.yaml"), original);
    // over-broad path proposal → rejected by validation
    const script = join(h, "fake.js");
    writeFileSync(script, `console.log(${JSON.stringify(JSON.stringify({ proposals: [{ kind: "path", action: "deny", path: "**", reason: "block all" }] }))});\n`);
    writeFileSync(join(h, "config.yaml"), `llm:\n  provider: command\n  command: node "${script}"\n`);

    const apply = spawnSync(process.execPath, [DIST, "suggest", "--apply"], {
      env: { ...process.env, REINS_HOME: h },
      encoding: "utf8",
    });
    expect(apply.status).toBe(1);
    expect(readFileSync(join(h, "policy.yaml"), "utf8")).toBe(original);
  }, 15_000);
});
