import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shouldStealLock } from "../src/core/trace.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist", "cli", "main.js");
const cli = existsSync(DIST);

const POLICY = "version: 1\ndefault: allow\nrules: []\n";

function mkdtempSync(prefix: string): string {
  const dir = join(tmpdir(), `${prefix}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function octalMode(p: string): string {
  return (statSync(p).mode & 0o777).toString(8);
}

describe("P0: ledger directory boundary (round-5 review)", () => {
  it.skipIf(!cli)("sessions/ as a symlink: hook refuses and external target is untouched", () => {
    const h = mkdtempSync("reins-bnd-");
    writeFileSync(join(h, "policy.yaml"), POLICY);
    const outside = join(h, "outside");
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    symlinkSync(outside, join(h, "sessions"), "dir");

    const r = spawnSync(process.execPath, [DIST, "hook", "claude"], {
      env: { ...process.env, REINS_HOME: h },
      input: JSON.stringify({ session_id: "esc", tool_name: "Bash", tool_input: { command: "ls" } }),
      encoding: "utf8",
    });

    // fail-closed: hook must not exit 0, and nothing may be written through the link
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("symlink");
    expect(readdirSync(outside)).toHaveLength(0);
  });

  it("TraceWriter.open refuses when the ledger directory is a symlink", async () => {
    const h = await mkdtemp(join(tmpdir(), "reins-bnd-"));
    const outside = join(h, "outside.jsonl");
    writeFileSync(outside, "keep\n");
    const sessions = join(h, "sessions");
    symlinkSync(outside, sessions, "file");

    const run = async () => {
      const { TraceWriter: TW } = await import("../src/core/trace.js");
      return TW.open(sessions);
    };
    await expect(run()).rejects.toThrow(/symlink/);
    expect(readFileSync(outside, "utf8")).toBe("keep\n");
  });

  it("REINS_HOME as a symlink: hook refuses (fail-closed, defined behavior)", () => {
    const h = mkdtempSync("reins-bnd-");
    writeFileSync(join(h, "policy.yaml"), POLICY);
    const realHome = mkdtempSync("reins-bnd-real-");
    symlinkSync(realHome, join(h, "linked-home"), "dir");

    const r = spawnSync(process.execPath, [DIST, "hook", "claude"], {
      env: { ...process.env, REINS_HOME: join(h, "linked-home") },
      input: JSON.stringify({ session_id: "esc2", tool_name: "Bash", tool_input: { command: "ls" } }),
      encoding: "utf8",
    });
    // defined behavior: a symlinked REINS_HOME is rejected outright
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("symlink");
    // nothing written into the real home either
    expect(existsSync(join(realHome, "sessions"))).toBe(false);
  });

  // POSIX mode bits are not representable on win32 (chmod only toggles
  // read-only) — the 0700 contract is asserted on posix only.
  it.skipIf(!cli || process.platform === "win32")("init creates .reins and sessions with mode 0700 (round-5: init left 0755)", async () => {
    const h = await mkdtemp(join(tmpdir(), "reins-initmode-"));
    writeFileSync(join(h, "policy.yaml"), POLICY);
    const r = spawnSync(process.execPath, [DIST, "init", "claude"], {
      env: { ...process.env, HOME: h, REINS_HOME: join(h, ".reins") },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(octalMode(join(h, ".reins"))).toBe("700"); // .reins home
    expect(octalMode(join(h, ".reins", "sessions"))).toBe("700"); // sessions
  });

  it.skipIf(process.platform === "win32")("init heals a pre-existing world-readable sessions dir", async () => {
    const h = await mkdtemp(join(tmpdir(), "reins-initmode-"));
    writeFileSync(join(h, "policy.yaml"), POLICY);
    const sessions = join(h, ".reins", "sessions");
    mkdirSync(sessions, { recursive: true, mode: 0o755 });
    const r = spawnSync(process.execPath, [DIST, "init", "claude"], {
      env: { ...process.env, HOME: h, REINS_HOME: join(h, ".reins") },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(octalMode(sessions)).toBe("700");
  });
});

describe("lock steal semantics (round-4 finding: live writer never snatched)", () => {
  it("never steals a lock held by a live process, regardless of age", () => {
    // our own pid is trivially alive
    const lock = JSON.stringify({ pid: process.pid, createdAt: Date.now() - 120_000, token: "t" });
    expect(shouldStealLock(lock, Date.now(), Date.now())).toBe(false);
  });

  it("steals a dead-pid lock after the stale window", () => {
    // a pid this high is essentially never alive
    const deadPid = 4_194_304;
    const lock = JSON.stringify({ pid: deadPid, createdAt: Date.now() - 120_000 });
    expect(shouldStealLock(lock, Date.now(), Date.now())).toBe(true);
  });

  it("keeps the grace window for unparseable locks", () => {
    expect(shouldStealLock("garbage", Date.now(), Date.now() - 5_000)).toBe(false);
    expect(shouldStealLock("garbage", Date.now(), Date.now() - 31_000)).toBe(true);
  });
});
