import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  client = new Client({ name: "reins-test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

afterAll(async () => {
  await client?.close();
});

describe.skipIf(!cli)("reins mcp server (protocol e2e)", () => {
  it("handshakes and exposes exactly the four read-only tools", async () => {
    const c = await getClient();
    const tools = await c.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(["check_command", "policy_summary", "recent_decisions", "stats"]);
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
});
