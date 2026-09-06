import { existsSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { decide } from "../core/decider.js";
import { loadPolicy } from "../core/policy.js";
import { readTrace, verifyTrace } from "../core/trace.js";

export interface McpContext {
  policyPath: string;
  sessionsDir: string;
}

interface SessionFile {
  path: string;
  agent: string;
  session: string;
  mtimeMs: number;
}

async function newestSessionFiles(sessionsDir: string, count: number): Promise<SessionFile[]> {
  if (!existsSync(sessionsDir)) return [];
  const names = (await readdir(sessionsDir)).filter((f) => f.endsWith(".jsonl"));
  const withMeta = await Promise.all(
    names.map(async (name) => {
      const path = join(sessionsDir, name);
      const m = await stat(path);
      const stem = name.replace(/\.jsonl$/, "");
      const idx = stem.indexOf("-");
      return {
        path,
        agent: idx === -1 ? "unknown" : stem.slice(0, idx),
        session: idx === -1 ? stem : stem.slice(idx + 1),
        mtimeMs: m.mtimeMs,
      };
    }),
  );
  withMeta.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withMeta.slice(0, count);
}

/** Pure, read-only tool handlers shared by the MCP server and its tests.
 *  NOTHING here may execute commands or write state — this layer is
 *  cooperative (agent-initiated) and must never gain enforcement powers. */
export function createToolHandlers(ctx: McpContext) {
  const loadInstalledPolicy = () => loadPolicy(readFileSync(ctx.policyPath, "utf8"));

  return {
    /** Dry-run a command against the installed policy. The hook still decides
     *  at execution time; this only previews the verdict. */
    check_command(args: { command: string; tool?: string }) {
      const policy = loadInstalledPolicy();
      const result = decide(policy, { tool: args.tool ?? "Bash", input: { command: args.command } });
      return {
        command: args.command,
        decision: result.decision,
        matchedRule: result.matchedRule ?? null,
        reason: result.reason ?? null,
        note:
          result.decision === "allow"
            ? "allowed by policy preview — the PreToolUse hook re-decides at execution time"
            : "will be blocked by the PreToolUse hook; do not retry the same command",
      };
    },

    /** Recent decisions across the newest session ledgers. */
    async recent_decisions(args: { limit?: number; verdict?: "allow" | "deny" | "ask" }) {
      const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
      const files = await newestSessionFiles(ctx.sessionsDir, 5);
      const out: Array<Record<string, unknown>> = [];
      for (const f of files) {
        try {
          const events = await readTrace(f.path);
          for (const e of [...events].reverse()) {
            if (args.verdict && e.decision !== args.verdict) continue;
            const input = (typeof e.input === "object" && e.input !== null ? e.input : {}) as Record<string, unknown>;
            out.push({
              agent: f.agent,
              session: f.session,
              seq: e.seq,
              ts: e.ts,
              tool: e.tool,
              action: typeof input["command"] === "string" ? input["command"] : (input["file_path"] ?? null),
              decision: e.decision,
              matchedRule: e.matchedRule ?? null,
              reason: e.reason ?? null,
            });
            if (out.length >= limit) {
              return { decisions: out, truncated: files.length >= 5 ? "newest 5 sessions scanned" : undefined };
            }
          }
        } catch {
          // unreadable/corrupt ledger — skip it, never crash the read-only surface
        }
      }
      return { decisions: out, truncated: undefined };
    },

    /** The installed policy in agent-readable form. */
    async policy_summary() {
      const policy = loadInstalledPolicy();
      return {
        name: policy.name ?? "(unnamed)",
        default: policy.default,
        ruleCount: policy.rules.length,
        rules: policy.rules.map((r) => ({
          id: r.id,
          kind: r.kind,
          action: r.action,
          reason: r.reason,
        })),
      };
    },

    /** Aggregate decision counts across all ledgers (integrity-checked). */
    async stats() {
      const files = await newestSessionFiles(ctx.sessionsDir, 50);
      let allow = 0;
      let deny = 0;
      let ask = 0;
      let tamperedSessions = 0;
      let events = 0;
      for (const f of files) {
        const integrity = await verifyTrace(f.path);
        if (!integrity.ok) tamperedSessions += 1;
        try {
          const eventsList = await readTrace(f.path);
          events += eventsList.length;
          for (const e of eventsList) {
            if (e.decision === "allow") allow += 1;
            else if (e.decision === "deny") deny += 1;
            else ask += 1;
          }
        } catch {
          // corrupt line — already reflected in tamperedSessions
        }
      }
      return { sessions: files.length, events, allow, deny, ask, tamperedSessions };
    },
  };
}

export type ReinsToolHandlers = ReturnType<typeof createToolHandlers>;
