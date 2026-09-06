import { existsSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { decide } from "../core/decider.js";
import { loadPolicy } from "../core/policy.js";
import { readTrace, verifyTrace } from "../core/trace.js";
import { DEFAULT_LLM_CONFIG, type LlmConfig } from "../llm/config.js";
import { completePrompt } from "../llm/provider.js";

export interface McpContext {
  policyPath: string;
  sessionsDir: string;
  /** optional LLM provider — read-only advisory tools only, never enforcement */
  llmConfig?: LlmConfig;
}

/** deterministic safer-alternative table: covers the most common denials
 *  without any LLM. advisory only — the hook re-decides every candidate. */
const ALTERNATIVE_TABLE: Array<{ match: RegExp; alternatives: string[]; note: string }> = [
  {
    match: /\bgit\s+push\b[^|]*?(--force\b|\s-f\b)/,
    alternatives: ["git push --force-with-lease"],
    note: "force-with-lease refuses when the remote moved since your last fetch",
  },
  {
    match: /^rm\s+(-\w*r\w*f?|--recursive)\b/,
    alternatives: ["move the target to a trash directory instead: mkdir -p .trash && mv <target> .trash/", "delete one specific file: rm <file>"],
    note: "recursive deletion — narrow the target or keep it recoverable",
  },
  {
    match: /\bchmod\s+777\b/,
    alternatives: ["chmod 755 <path>", "grant only the needed bit, e.g. chmod +x <path>"],
    note: "world-writable files are a common attack vector",
  },
  {
    match: /\bgit\s+reset\s+--hard\b/,
    alternatives: ["git stash push --include-untracked", "git restore -- <paths>"],
    note: "stash keeps the work recoverable",
  },
  {
    match: /\bcurl\b[^|]*\|\s*(?:ba|z|da)?sh\b/,
    alternatives: ["download to a file, inspect the script, then run it explicitly"],
    note: "never execute unreviewed downloaded code",
  },
  {
    match: /\bgit\s+clean\s+-[a-zA-Z]*f/,
    alternatives: ["git clean -n (dry run) first, then git clean -f on reviewed paths"],
    note: "dry-run before deleting untracked files",
  },
];

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
  const llm = ctx.llmConfig ?? DEFAULT_LLM_CONFIG;

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

    /** Recent decisions across the newest session ledgers. Corrupt or
     *  tampered ledgers are skipped and reported, never silently mixed in. */
    async recent_decisions(args: { limit?: number; verdict?: "allow" | "deny" | "ask" }) {
      const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
      const allFiles = await newestSessionFiles(ctx.sessionsDir, Number.MAX_SAFE_INTEGER);
      const files = allFiles.slice(0, 5);
      const out: Array<Record<string, unknown>> = [];
      const integrityWarnings: Array<{ file: string; reason: string }> = [];
      for (const f of files) {
        const integrity = await verifyTrace(f.path);
        if (!integrity.ok) {
          integrityWarnings.push({
            file: f.path,
            reason: `${integrity.reason ?? "integrity failure"} at event ${integrity.brokenAt}`,
          });
          continue; // tampered events must never pass as trusted audit data
        }
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
          if (out.length >= limit) break;
        }
        if (out.length >= limit) break;
      }
      return {
        decisions: out,
        scannedSessions: files.length - integrityWarnings.length,
        totalSessions: allFiles.length,
        integrityWarnings,
        truncated: allFiles.length > 5 ? "only the newest 5 sessions scanned" : undefined,
      };
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

    /** Aggregate decision counts across ALL ledgers, integrity-gated: events
     *  from tampered sessions are excluded from the trusted counts. */
    async stats() {
      const files = await newestSessionFiles(ctx.sessionsDir, Number.MAX_SAFE_INTEGER);
      let allow = 0;
      let deny = 0;
      let ask = 0;
      let tamperedSessions = 0;
      let events = 0;
      let scannedSessions = 0;
      const tamperedFiles: string[] = [];
      for (const f of files) {
        const integrity = await verifyTrace(f.path);
        if (!integrity.ok) {
          tamperedSessions += 1;
          tamperedFiles.push(f.path);
          continue; // untrusted — excluded from counts entirely
        }
        scannedSessions += 1;
        const eventsList = await readTrace(f.path);
        events += eventsList.length;
        for (const e of eventsList) {
          if (e.decision === "allow") allow += 1;
          else if (e.decision === "deny") deny += 1;
          else ask += 1;
        }
      }
      return {
        sessions: files.length,
        scannedSessions,
        events,
        allow,
        deny,
        ask,
        tamperedSessions,
        tamperedFiles: tamperedFiles.length > 0 ? tamperedFiles : undefined,
      };
    },

    /** Advisory safer-alternative suggestions for a denied command.
     *  Layer 1: deterministic table. Layer 2 (optional): LLM, with every
     *  candidate re-checked against the policy — the hook re-decides regardless. */
    async suggest_alternative(args: { command: string }) {
      const table = ALTERNATIVE_TABLE.find((a) => a.match.test(args.command));
      if (table) {
        return {
          command: args.command,
          source: "deterministic",
          alternatives: table.alternatives,
          note: table.note,
          llmUsed: false,
        };
      }
      if (llm.provider === "none") {
        return {
          command: args.command,
          source: "none",
          alternatives: [],
          note: "no deterministic alternative; configure the optional llm: section (docs/LLM.md) for AI suggestions",
          llmUsed: false,
        };
      }
      try {
        const prompt = [
          "A security policy denied this AI-agent command:",
          args.command,
          'Propose up to 3 safer alternative commands that accomplish a similar goal. STRICT JSON only:',
          '{"alternatives":["command one","command two"]}',
        ].join("\n");
        const out = await completePrompt(prompt, llm);
        const jsonMatch = out.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : "{}") as { alternatives?: unknown };
        const candidates = Array.isArray(parsed.alternatives)
          ? parsed.alternatives.filter((c): c is string => typeof c === "string")
          : [];
        const policy = loadInstalledPolicy();
        const allowed = candidates.filter(
          (c) => decide(policy, { tool: "Bash", input: { command: c } }).decision === "allow",
        );
        return {
          command: args.command,
          source: "llm",
          alternatives: allowed,
          rejectedByPolicy: candidates.length - allowed.length,
          note: "advisory only — the PreToolUse hook re-decides at execution time",
          llmUsed: true,
        };
      } catch (err) {
        return {
          command: args.command,
          source: "llm-error",
          alternatives: [],
          note: `LLM suggestion failed: ${err instanceof Error ? err.message : String(err)} — the denial still stands`,
          llmUsed: true,
        };
      }
    },
  };
}

export type ReinsToolHandlers = ReturnType<typeof createToolHandlers>;
