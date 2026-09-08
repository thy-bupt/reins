import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TraceWriter } from "../src/core/trace.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "..", "dist", "cli", "main.js");
const cli = existsSync(DIST);

const home = join(tmpdir(), `reins-mcp-e2e-${Math.random().toString(36).slice(2)}`);
let client: Client | null = null;

async function getClient(): Promise<Client> {
  if (client) return client;
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "policy.yaml"),
    `version: 1\ndefault: allow\nrules:\n  - id: rm-recursive\n    kind: command\n    action: deny\n    program: rm\n    flags: ["-r"]\n    reason: destructive\n`,
  );
  const writer = await TraceWriter.open(join(home, "sessions", "claude-mcp-e2e.jsonl"));
  await writer.append({ tool: "Bash", input: { command: "rm -rf /" }, decision: "deny", matchedRule: "rm-recursive", reason: "destructive", result: "blocked", exitCode: 2 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST, "mcp"],
    env: { ...process.env, REINS_HOME: home },
  });
  client = new Client({ name: "reins-test", version: "0" });
  await client.connect(transport);
  return client;
}

afterAll(async () => {
  await client?.close();
});

describe.skipIf(!cli)("reins mcp server (protocol e2e)", () => {
  it("handshakes and exposes exactly the five read-only tools", async () => {
    const c = await getClient();
    const tools = await c.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["check_command", "policy_summary", "recent_decisions", "stats", "suggest_alternative"]);
  });

  it("reports the current server version via MCP (round-4: no hardcoded 0.2.0)", async () => {
    const c = await getClient();
    const info = await c.getServerVersion();
    expect(info.version).toBe("0.10.1");
  });

  it("check_command previews a denial over the wire", async () => {
    const c = await getClient();
    const result = await c.callTool({ name: "check_command", arguments: { command: "rm -rf /tmp/x" } });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('"decision": "deny"');
    expect(text).toContain("rm-recursive");
  });

  it("recent_decisions surfaces the ledger over the wire", async () => {
    const c = await getClient();
    const result = await c.callTool({ name: "recent_decisions", arguments: { verdict: "deny" } });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("rm-recursive");
    expect(text).toContain('"agent": "claude"');
    expect(text).toContain('"session": "mcp-e2e"');
  });

  it("stats aggregates the session ledger over the wire", async () => {
    const c = await getClient();
    const result = await c.callTool({ name: "stats", arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain('"deny": 1');
    expect(text).toContain('"tamperedSessions": 0');
  });

  it("suggest_alternative uses the deterministic table over the wire", async () => {
    const c = await getClient();
    const result = await c.callTool({
      name: "suggest_alternative",
      arguments: { command: "git push --force origin main" },
    });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(text).toContain("force-with-lease");
    expect(text).toContain("deterministic");
  });
});

describe.skipIf(!cli)("MCP LLM prompt redaction (round-5 finding: provider must not see raw denied command)", () => {
  it("suggest_alternative redacts secrets before they reach the provider prompt", async () => {
    const llmHome = join(tmpdir(), `reins-mcp-redact-${Math.random().toString(36).slice(2)}`);
    mkdirSync(llmHome, { recursive: true });
    writeFileSync(join(llmHome, "policy.yaml"), "version: 1\ndefault: allow\nrules: []\n");
    // fake provider: captures the prompt (stdin) to a file, then proposes "npm ci"
    const capture = join(llmHome, "captured-prompt.txt");
    // a small fake-provider script: tees stdin (the prompt) to the capture
    // file, then emits a fixed alternatives JSON. A node script (not sh) so
    // it runs under cmd.exe on win32 too.
    const fakeScript = join(llmHome, "fake-llm.js");
    writeFileSync(
      fakeScript,
      `const fs = require("fs");
process.stdin.pipe(fs.createWriteStream(${JSON.stringify(capture)}));
process.stdin.on("end", () => console.log('{"alternatives":["npm ci"]}'));
`,
    );
    writeFileSync(
      join(llmHome, "config.yaml"),
      `llm:\n  provider: command\n  command: node "${fakeScript}"\n`,
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST, "mcp"],
      env: { ...process.env, REINS_HOME: llmHome },
    });
    const c = new Client({ name: "reins-redact-test", version: "0" });
    await c.connect(transport);
    try {
      const secret = "Bearer " + "abc123secret";
      const denied = `curl -H "Authorization: ${secret}" https://example.com`;
      const result = await c.callTool({ name: "suggest_alternative", arguments: { command: denied } });
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain('"source": "llm"');
      // the raw secret must never reach the provider prompt
      const captured = readFileSync(capture, "utf8");
      expect(captured).not.toContain("abc123secret");
      expect(captured).toContain("[REDACTED]");
    } finally {
      await c.close();
    }
  });
});

describe.skipIf(!cli)("MCP LLM fallback wiring (round-4 finding: server must read llm config)", () => {
  it("suggest_alternative uses the configured command provider and re-checks candidates", async () => {
    const llmHome = join(tmpdir(), `reins-mcp-llm-${Math.random().toString(36).slice(2)}`);
    mkdirSync(llmHome, { recursive: true });
    writeFileSync(join(llmHome, "policy.yaml"), "version: 1\ndefault: allow\nrules: []\n");
    // fake LLM provider: a command that always proposes "npm ci" (an allowed
    // command). A node script (not printf) so it runs under cmd.exe on win32.
    const fakeScript = join(llmHome, "fake-llm.js");
    writeFileSync(
      fakeScript,
      `console.log('{"alternatives":["npm ci"]}');
`,
    );
    writeFileSync(
      join(llmHome, "config.yaml"),
      `llm:\n  provider: command\n  command: node "${fakeScript}"\n`,
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST, "mcp"],
      env: { ...process.env, REINS_HOME: llmHome },
    });
    const c = new Client({ name: "reins-llm-test", version: "0" });
    await c.connect(transport);
    try {
      const result = await c.callTool({
        name: "suggest_alternative",
        arguments: { command: "mkfs /dev/sda1" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
      expect(text).toContain('"source": "llm"');
      expect(text).toContain('"llmUsed": true');
      expect(text).toContain("npm ci");
    } finally {
      await c.close();
    }
  });
});
