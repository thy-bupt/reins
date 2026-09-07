import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { anonymizePath } from "../src/core/redact.js";
import { TraceWriter } from "../src/core/trace.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist", "cli", "main.js");
const cli = existsSync(DIST);

describe("round-5 P1: LLM outbound data boundaries", () => {
  it("anonymizePath folds home paths and collapses foreign absolute paths", () => {
    expect(anonymizePath("/tmp/build-123/config.ts")).toMatch(/^<ABS_PATH>\/config\.ts$/);
    expect(anonymizePath("/srv/company-repo/customer.csv")).toMatch(/^<ABS_PATH>\//);
    expect(anonymizePath("/Volumes/X/a.txt")).toMatch(/^<ABS_PATH>\//);
    expect(anonymizePath("relative/path.ts")).toBe("relative/path.ts");
  });

  it.skipIf(!cli)("suggest --session does not leak sibling sessions to the provider", async () => {
    const h = join(tmpdir(), `reins-privacy-${Math.random().toString(36).slice(2)}`);
    const sessions = join(h, "sessions");
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    writeFileSync(join(h, "policy.yaml"), "version: 1\ndefault: allow\nrules: []\n");

    // fake provider script: tees the received prompt to a capture file, then
    // emits a fixed proposals JSON (deterministic fake LLM)
    const capture = join(h, "captured-prompt.txt");
    const proposalsFile = join(h, "fake.json");
    writeFileSync(proposalsFile, JSON.stringify({
      proposals: [{ kind: "command", action: "deny", program: "mkfs", reason: "formats filesystems" }],
    }));
    const script = join(h, "fake-llm.sh");
    writeFileSync(script, `#!/bin/sh\ncat > '${capture}'\nprintf '%s' "$(cat '${proposalsFile}')"\n`);
    writeFileSync(join(h, "config.yaml"), `llm:\n  provider: command\n  command: sh '${script}'\n`);

    // two ledgers: target (user-selected) + sensitive sibling (NOT selected)
    const w1 = await TraceWriter.open(join(sessions, "claude-target.jsonl"));
    await w1.append({ tool: "Bash", input: { command: "echo from-target" }, decision: "allow", result: "ok", exitCode: 0 });
    const w2 = await TraceWriter.open(join(sessions, "claude-other-sensitive.jsonl"));
    await w2.append({ tool: "Bash", input: { command: "OTHER_SESSION_MARKER" }, decision: "allow", result: "ok", exitCode: 0 });

    const r = spawnSync(process.execPath, [DIST, "suggest", "--session", join(sessions, "claude-target.jsonl")], {
      env: { ...process.env, REINS_HOME: h },
      encoding: "utf8",
    });
    expect(r.status, `suggest failed: ${r.stderr}`).toBe(0);

    const captured = readFileSync(capture, "utf8");
    expect(captured).toContain("claude-target.jsonl");
    expect(captured).toContain("from-target");
    // the sibling's ledger name AND its content must never reach the provider
    expect(captured).not.toContain("other-sensitive");
    expect(captured).not.toContain("OTHER_SESSION_MARKER");
  });
});
