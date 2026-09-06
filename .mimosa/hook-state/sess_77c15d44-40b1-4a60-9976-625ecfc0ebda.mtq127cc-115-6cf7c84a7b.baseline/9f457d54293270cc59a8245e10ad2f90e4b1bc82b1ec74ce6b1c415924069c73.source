import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolvePolicyPath, sessionsDir } from "../core/home.js";
import { createToolHandlers } from "./tools.js";

/** Read-only MCP surface over the reins core. Enforcement never lives here:
 *  the PreToolUse hook decides regardless of what this server answers. */
export async function runMcpServer(): Promise<void> {
  const ctx = { policyPath: resolvePolicyPath(), sessionsDir: sessionsDir() };
  const handlers = createToolHandlers(ctx);

  const server = new McpServer({ name: "reins", version: "0.2.0" });

  server.tool(
    "check_command",
    "Dry-run a command against the installed reins policy. Read-only: nothing is executed. The PreToolUse hook re-decides at execution time.",
    { command: z.string().describe("the shell command to evaluate"), tool: z.string().optional().describe("tool name to evaluate as (default Bash)") },
    async ({ command, tool }) =>
      asText(handlers.check_command({ command, tool: tool ?? undefined })),
  );

  server.tool(
    "recent_decisions",
    "Review recent decisions from the reins ledger (newest first). Optionally filter by verdict.",
    {
      limit: z.number().optional().describe("max decisions to return (default 20, max 100)"),
      verdict: z.enum(["allow", "deny", "ask"]).optional().describe("filter by decision"),
    },
    async ({ limit, verdict }) => asText(await handlers.recent_decisions({ limit, verdict })),
  );

  server.tool(
    "policy_summary",
    "The currently installed reins policy: every rule with its action and reason.",
    {},
    async () => asText(await handlers.policy_summary()),
  );

  server.tool(
    "stats",
    "Aggregate decision counts across all reins session ledgers (with integrity check).",
    {},
    async () => asText(await handlers.stats()),
  );

  await server.connect(new StdioServerTransport());
  // stdio transport keeps the process alive until the client disconnects
  await new Promise(() => {});
}

function asText(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}
