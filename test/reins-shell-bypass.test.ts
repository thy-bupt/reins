import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runGuarded } from "../src/core/runner.js";
import { TraceWriter } from "../src/core/trace.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist", "cli", "main.js");
const cli = existsSync(DIST);

const POLICY = "version: 1\ndefault: allow\nrules: []\n";

function mkdtempSync(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

describe("H1 (security audit 2026-09-07): REINS_SHELL env bypass is closed", () => {
  it("unit: REINS_SHELL env var cannot change the executing interpreter", async () => {
    process.env["REINS_SHELL"] = "/definitely/not/a/shell";
    try {
      const dir = mkdtempSync("reins-h1-");
      const trace = await TraceWriter.start(dir);
      const result = await runGuarded({ command: "echo hello", trace });
      // fixed: env var ignored, command runs under the platform shell
      expect(result.exitCode).toBe(0);
      expect(result.blocked).toBe(false);
    } finally {
      delete process.env["REINS_SHELL"];
    }
  });

  it.skipIf(!cli)("e2e: REINS_SHELL pointing at a fake binary cannot swallow commands", () => {
    const h = mkdtempSync("reins-h1-e2e-");
    writeFileSync(join(h, "policy.yaml"), POLICY);
    // fake shell: exits 0 immediately, ignoring argv entirely — under the old
    // bug this meant "policy says echo ran, fake binary actually ran nothing"
    const fake = join(h, "fake-shell.sh");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    const r = spawnSync(process.execPath, [DIST, "exec", "--", "echo hello"], {
      env: { ...process.env, REINS_HOME: h, REINS_SHELL: fake },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("hello");
  });

  it("e2e: REINS_SHELL pointing at a nonexistent interpreter falls back to default", () => {
    const h = mkdtempSync("reins-h1-e2e-");
    writeFileSync(join(h, "policy.yaml"), POLICY);
    const r = spawnSync(process.execPath, [DIST, "exec", "--", "echo hello"], {
      env: { ...process.env, REINS_HOME: h, REINS_SHELL: "/no/such/shell" },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("hello");
  });
});

describe("H1 companion: exec CLI records what policy checked", () => {
  it("exec CLI records the command and policy digest on the ledger", () => {
    const h = mkdtempSync("reins-h1-ledger-");
    writeFileSync(join(h, "policy.yaml"), POLICY);
    const r = spawnSync(process.execPath, [DIST, "exec", "--", "echo digest-check"], {
      env: { ...process.env, REINS_HOME: h },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const ledger = readdirSync(join(h, "sessions")).find((f) => f.endsWith(".jsonl"))!;
    const events = readFileSync(join(h, "sessions", ledger), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(events[0]!.policyDigest).toMatch(/^[0-9a-f]{64}$/);
    expect((events[0]!.input as Record<string, unknown>)["command"]).toBe("echo digest-check");
  });
});
