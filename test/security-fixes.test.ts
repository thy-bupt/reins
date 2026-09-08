import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { sanitizeSessionId, sanitizeTraceInput } from "../src/adapters/common.js";
import { readTrace, verifyTrace } from "../src/core/trace.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist", "cli", "main.js");
const cli = existsSync(DIST);

function home(): string {
  const dir = join(tmpdir(), `reins-sec-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// spawnSync honors the `input` option (async execFile does NOT — stdin would
// stay open and the hook would wait forever)
function runHook(env: string, payload: string) {
  return spawnSync(process.execPath, [DIST, "hook", "claude"], {
    env: { ...process.env, REINS_HOME: env },
    input: payload,
    encoding: "utf8",
  });
}

/** genuinely concurrent hook invocation (async spawn + stdin write) */
function runHookAsync(env: string, payload: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [DIST, "hook", "claude"], {
      env: { ...process.env, REINS_HOME: env },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (d) => (stderr += String(d)));
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
    child.on("error", reject);
    child.stdin!.write(payload);
    child.stdin!.end();
  });
}

describe("sanitizeSessionId (Codex finding 3: path traversal)", () => {
  it("passes safe ids through untouched", () => {
    expect(sanitizeSessionId("claude", "12a23ba8-7f4e-452a")).toBe("12a23ba8-7f4e-452a");
    expect(sanitizeSessionId("claude", "demo.v2_test-x")).toBe("demo.v2_test-x");
  });

  it("hashes traversal and control-character ids instead of rejecting", () => {
    for (const evil of ["x/../../escape", "..", "/etc/passwd", "a/b", "x\ny", "."]) {
      const safe = sanitizeSessionId("claude", evil);
      expect(safe).toMatch(/^h-[0-9a-f]{32}$/);
      expect(safe).not.toContain("/");
      expect(safe).not.toContain("..");
    }
    // same input → same hash (stable sessions), different input → different hash
    expect(sanitizeSessionId("claude", "x/../../escape")).toBe(sanitizeSessionId("claude", "x/../../escape"));
    expect(sanitizeSessionId("claude", "x/../../escape")).not.toBe(sanitizeSessionId("codex", "x/../../escape"));
  });
});

describe.skipIf(!cli)("session traversal e2e (Codex finding 3)", () => {
  it("keeps the ledger inside sessions/ even with an evil session_id", async () => {
    const h = home();
    const evil = { session_id: "x/../../escape", tool_name: "Bash", tool_input: { command: "ls" } };
    const r = runHook(h, JSON.stringify(evil));
    expect(r.status).toBe(0);

    expect(existsSync(join(h, "escape.jsonl"))).toBe(false);
    expect(existsSync(join(h, "sessions"))).toBe(true);
    const files = readdirSync(join(h, "sessions"));
    expect(files.some((f) => f.startsWith("claude-h-"))).toBe(true);
  });
});

describe("sanitizeTraceInput (Codex finding 5: privacy whitelist)", () => {
  it("keeps command + cwd, drops everything else", () => {
    const out = sanitizeTraceInput({ command: "curl -H 'Auth: token' example.com", extra: "secret" }) as Record<string, unknown>;
    expect(out).toEqual({ command: "curl -H 'Auth: token' example.com" });
  });

  it("keeps file path but replaces content with hash + length", () => {
    const content = "TOP-SECRET-CONTENT";
    const out = sanitizeTraceInput({ file_path: "/repo/note.txt", content }) as Record<string, unknown>;
    expect(out["file_path"]).toBe("/repo/note.txt");
    expect(JSON.stringify(out)).not.toContain("TOP-SECRET-CONTENT");
    expect(out["contentSha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(out["contentLength"]).toBe(content.length);
  });

  it("records nothing for unknown input shapes", () => {
    expect(sanitizeTraceInput({ weird: "payload", token: "abc" })).toEqual({});
  });
});

describe("privacy e2e: Write content never reaches the ledger", () => {
  it("stores file_path + contentSha256 only", async () => {
    const h = home();
    const payload = JSON.stringify({
      session_id: "privacy",
      tool_name: "Write",
      tool_input: { file_path: "/repo/.env", content: "TOP-SECRET-CONTENT" },
    });
    await runHook(h, payload);

    const ledger = join(h, "sessions", "claude-privacy.jsonl");
    const events = await readTrace(ledger);
    const input = events[0]!.input as Record<string, unknown>;
    expect(input["file_path"]).toBe("/repo/.env");
    expect(JSON.stringify(events)).not.toContain("TOP-SECRET-CONTENT");
    expect(events[0]!.decision).toBe("deny"); // .env protection unaffected by sanitization
  });
});

describe("installer config preservation (Codex finding 4.1/4.2)", () => {
  it("init opencode refuses to overwrite a foreign plugin file", async () => {
    const h = home();
    const pluginPath = join(h, "reins.js");
    writeFileSync(pluginPath, "// USER CODE — do not touch");
    const init = spawnSync(process.execPath, [DIST, "init", "opencode", "--settings", pluginPath], {
      env: { ...process.env, REINS_HOME: h },
      encoding: "utf8",
    });

    expect(init.status).toBe(2);
    expect(readFileSync(pluginPath, "utf8")).toBe("// USER CODE — do not touch");
  });

  it("init mcp refuses to overwrite a foreign reins-named MCP entry", async () => {
    const h = home();
    const cfg = join(h, "claude.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { reins: { type: "stdio", command: "my-own-reins", args: [] } } }), { mode: 0o600 });
    const init = spawnSync(process.execPath, [DIST, "init", "mcp", "--settings", cfg], {
      env: { ...process.env, REINS_HOME: h },
      encoding: "utf8",
    });

    expect(init.status).toBe(2);
    const after = JSON.parse(readFileSync(cfg, "utf8")) as { mcpServers: { reins: { command: string } } };
    expect(after.mcpServers.reins.command).toBe("my-own-reins");
  });

  it("uninstall mcp leaves a foreign reins-named entry alone", async () => {
    const h = home();
    const cfg = join(h, "claude.json");
    writeFileSync(cfg, JSON.stringify({ mcpServers: { reins: { type: "stdio", command: "my-own-reins", args: [] } } }), { mode: 0o600 });
    const un = spawnSync(process.execPath, [DIST, "uninstall", "mcp", "--settings", cfg], {
      env: { ...process.env, REINS_HOME: h },
      encoding: "utf8",
    });

    expect(un.status).toBe(0);
    const after = JSON.parse(readFileSync(cfg, "utf8")) as { mcpServers: { reins: { command: string } } };
    expect(after.mcpServers.reins.command).toBe("my-own-reins");
  });
});

describe.skipIf(!cli)("concurrent hooks (Codex finding 2: ledger chain under parallel tool calls)", () => {
  it("survives 24 concurrent hooks on one session with an intact chain", async () => {
    const h = home();
    mkdirSync(join(h, "sessions"), { recursive: true, mode: 0o700 });
    writeFileSync(join(h, "policy.yaml"), "version: 1\ndefault: allow\nrules: []\n");

    const calls = Array.from({ length: 24 }, (_, i) =>
      runHookAsync(h, JSON.stringify({ session_id: "concurrent", tool_name: "Bash", tool_input: { command: `echo ${i}` } })),
    );
    const settled = await Promise.allSettled(calls);
    const rejected = settled.filter((s) => s.status === "rejected");
    const nonZero = settled
      .filter((s) => s.status === "fulfilled")
      .map((s) => (s as PromiseFulfilledResult<{ code: number | null }>).value.code)
      .filter((code) => code !== 0);
    expect(rejected, "no spawn errors").toHaveLength(0);
    expect(nonZero, "all concurrent hooks should exit 0").toHaveLength(0);

    const integrity = await verifyTrace(join(h, "sessions", "claude-concurrent.jsonl"));
    expect(integrity.ok).toBe(true);
    expect(integrity.events).toBe(24);

    const events = await import("../src/core/trace.js").then((m) => m.readTrace(join(h, "sessions", "claude-concurrent.jsonl")));
    expect(events.map((e) => e.seq).sort((a, b) => a - b)).toEqual([...Array(24).keys()]);
  }, 30_000);
});

describe("trace + config permissions (Codex finding 4.3)", () => {
  // POSIX mode bits don't exist on win32 (chmod only toggles read-only) —
  // the 0700/0600 contract is a posix guarantee; Windows relies on ACLs.
  it.skipIf(process.platform === "win32")("creates sessions dir 0700 and trace files 0600", async () => {
    const h = home();
    const payload = JSON.stringify({ session_id: "perm", tool_name: "Bash", tool_input: { command: "ls" } });
    await runHook(h, payload);
    expect(statSync(join(h, "sessions")).mode & 0o777).toBe(0o700);
    expect(statSync(join(h, "sessions", "claude-perm.jsonl")).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("preserves 0600 on settings through init (no mode widening)", async () => {
    const h = home();
    const settings = join(h, "settings.json");
    writeFileSync(settings, "{}", { mode: 0o600 });
    await promisify(execFile)(process.execPath, [DIST, "init", "claude", "--settings", settings], {
      env: { ...process.env, REINS_HOME: h },
    });
    expect(statSync(settings).mode & 0o777).toBe(0o600);
  });
});
