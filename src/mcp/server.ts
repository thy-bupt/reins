import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";
import { resolvePolicyPath, sessionsDir } from "../core/home.js";
import { loadLlmConfig } from "../llm/config.js";
import { createToolHandlers } from "./tools.js";

const require = createRequire(import.meta.url);
const VERSION: string = require("../../package.json").version;

/** Read-only MCP surface over the reins core. Enforcement never lives here:
 *  the PreToolUse hook decides regardless of what this server answers. */
export async function runMcpServer(): Promise<void> {
  const ctx = {
    policyPath: resolvePolicyPath(),
    sessionsDir: sessionsDir(),
    llmConfig: loadLlmConfig(),
  };
  const handlers = createToolHandlers(ctx);

  const server = new McpServer({ name: "reins", version: VERSION });

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

  server.tool(
    "suggest_alternative",
    "Advisory safer-alternative suggestions for a DENIED command. Read-only; the PreToolUse hook re-decides every candidate.",
    { command: z.string().describe("the denied command to find alternatives for") },
    async ({ command }) => asText(await handlers.suggest_alternative({ command })),
  );

  await server.connect(new StdioServerTransport());
  // stdio transport keeps the process alive until the client disconnects
  await new Promise(() => {});
}

// direct-run entry (round-2 review finding): `node dist/mcp/server.js` also
// works — running the bare module used to exit silently with no hint
import { pathToFileURL } from "node:url";
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runMcpServer().catch((err: unknown) => {
    process.stderr.write(`[reins] MCP server error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}

function asText(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}
