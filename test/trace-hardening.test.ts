import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CorruptTraceError, TraceWriter, verifyTrace } from "../src/core/trace.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist", "cli", "main.js");
const cli = existsSync(DIST);

async function tmpDir() {
  return mkdtemp(join(tmpdir(), "reins-hardening-"));
}

describe("P0-1: append re-verifies the chain under the lock", () => {
  it("refuses to append after the open trace is tampered with", async () => {
    const dir = await tmpDir();
    const writer = await TraceWriter.open(join(dir, "s.jsonl"));
    await writer.append({ tool: "Bash", input: { command: "ls" }, decision: "allow" });

    // tamper with the committed event behind the writer's back
    const lines = (await readFile(join(dir, "s.jsonl"), "utf8")).trim().split("\n");
    const tampered = JSON.parse(lines[0]!) as Record<string, unknown>;
    tampered.decision = "deny";
    lines[0] = JSON.stringify(tampered);
    writeFileSync(join(dir, "s.jsonl"), lines.join("\n") + "\n");

    await expect(
      writer.append({ tool: "Bash", input: { command: "echo next" }, decision: "allow" }),
    ).rejects.toThrow(CorruptTraceError);

    // the tampered file must be unchanged: no new event appended on top of a broken chain
    const after = (await readFile(join(dir, "s.jsonl"), "utf8")).trim().split("\n");
    expect(after).toHaveLength(1);
    const integrity = await verifyTrace(join(dir, "s.jsonl"));
    expect(integrity.ok).toBe(false);
  });

  it("still accepts normal sequential appends (lock does not block legit writers)", async () => {
    const dir = await tmpDir();
    const writer = await TraceWriter.open(join(dir, "s.jsonl"));
    await writer.append({ tool: "Bash", input: { command: "a" }, decision: "allow" });
    await writer.append({ tool: "Bash", input: { command: "b" }, decision: "allow" });
    const integrity = await verifyTrace(join(dir, "s.jsonl"));
    expect(integrity).toMatchObject({ ok: true, events: 2 });
  });
});

describe("P0-2: symlinked session files are rejected", () => {
  it("TraceWriter.open refuses a symlinked ledger", async () => {
    const dir = await tmpDir();
    const outside = join(dir, "outside.jsonl");
    writeFileSync(outside, "hello\n");
    const link = join(dir, "sessions");
    const fs = await import("node:fs");
    fs.symlinkSync(outside, link, "file");

    await expect(TraceWriter.open(link)).rejects.toThrow(/symlink/);
    expect(readFileSync(outside, "utf8")).toBe("hello\n");
  });

  it.skipIf(!cli)("hook refuses to write through a planted symlink (e2e)", async () => {
    const h = await tmpDir();
    writeFileSync(join(h, "policy.yaml"), "version: 1\ndefault: allow\nrules: []\n");
    const outside = join(h, "outside.jsonl");
    writeFileSync(outside, "hello\n");
    const sessions = join(h, "sessions");
    const fs = await import("node:fs");
    fs.mkdirSync(sessions, { recursive: true });
    fs.symlinkSync(outside, join(sessions, "claude-link.jsonl"), "file");

    const r = spawnSync(process.execPath, [DIST, "hook", "claude"], {
      env: { ...process.env, REINS_HOME: h },
      input: JSON.stringify({ session_id: "link", tool_name: "Bash", tool_input: { command: "ls" } }),
      encoding: "utf8",
    });

    // fail-closed: the hook must not exit 0 (which would mean it wrote through the link)
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("symlink");
    expect(readFileSync(outside, "utf8")).toBe("hello\n");
    void existsSync;
  });
});
