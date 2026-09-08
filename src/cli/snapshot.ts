import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import type { VerifyResult, TraceEvent } from "../core/trace.js";

export interface GitContext {
  repoRoot: string;
  head: string;
  subject: string;
  dirty: string[];
  diffs?: Record<string, string>;
}

export interface SnapshotData {
  sourceFile: string;
  agent: string;
  sessionId: string;
  eventCount: number;
  timeRange: { first?: string; last?: string };
  integrity: VerifyResult;
  policy: { name?: string; rules: number; sha256: string; source: string };
  git: GitContext | null;
  denied: TraceEvent[];
  allowed: TraceEvent[];
  fileWrites: TraceEvent[];
  generatedAt: string;
}

export function deriveAgentAndSession(filePath: string): { agent: string; sessionId: string } {
  const base = basename(filePath).replace(/\.jsonl$/, "");
  const idx = base.indexOf("-");
  if (idx === -1) return { agent: "unknown", sessionId: base };
  return { agent: base.slice(0, idx), sessionId: base.slice(idx + 1) };
}

export function summarizeEvent(e: TraceEvent): string {
  const input = (typeof e.input === "object" && e.input !== null ? e.input : {}) as Record<string, unknown>;
  if (typeof input["command"] === "string" && input["command"] !== "") return input["command"];
  const path = input["file_path"] ?? input["notebook_path"];
  if (typeof path === "string" && path !== "") return `${e.tool}: ${path}`;
  return "(no command/path)";
}

function gitRun(args: string[], cwd?: string): string | null {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return (r.stdout ?? "").trim();
}

/** Correlate the session's touched paths with git state at snapshot time.
 *  Returns null when none of the paths live inside a git repository. */
export async function collectGitContext(paths: string[], withDiffs: boolean): Promise<GitContext | null> {
  let repoRoot: string | null = null;
  for (const p of paths) {
    const dir = dirname(p);
    if (dir === "" || !isAbsolute(dir)) continue;
    const top = gitRun(["rev-parse", "--show-toplevel"], dir);
    if (top) {
      repoRoot = top;
      break;
    }
  }
  if (!repoRoot) return null;

  // git resolves symlinks (macOS /tmp -> /private/tmp); compare like with like
  let realRoot = repoRoot;
  try {
    realRoot = realpathSync(repoRoot);
  } catch {
    /* keep as-is */
  }
  repoRoot = realRoot;

  const head = gitRun(["rev-parse", "HEAD"], repoRoot) ?? "(no commits yet)";
  const subject = gitRun(["log", "-1", "--format=%s"], repoRoot) ?? "";
  const dirty = (gitRun(["status", "--porcelain"], repoRoot) ?? "").split("\n").filter((l) => l !== "");

  const ctx: GitContext = { repoRoot, head, subject, dirty };

  if (withDiffs) {
    const diffs: Record<string, string> = {};
    for (const p of paths) {
      let realPath = p;
      try {
        realPath = realpathSync(p);
      } catch {
        /* file may be gone; fall back to the recorded path */
      }
      // git's repoRoot and a realpath'd file path can spell the same
      // directory differently on win32 (8.3 short names: RUNNER~1 vs
      // runneradmin), so string prefix checks are unreliable — match
      // directory identity via stat instead, and rebuild the repo-relative
      // path from basenames while walking up.
      let rel: string | null = null;
      {
        let rootStat: ReturnType<typeof statSync> | null = null;
        try {
          rootStat = statSync(repoRoot);
        } catch {
          /* repoRoot missing: fall through to no-diff */
        }
        const parts: string[] = [];
        for (let cur = realPath; rootStat !== null; ) {
          let same = false;
          try {
            const s = statSync(cur);
            same = s.dev === rootStat.dev && s.ino === rootStat.ino;
          } catch {
            /* file may be gone */
          }
          if (same) break;
          const parent = dirname(cur);
          if (parent === cur) break;
          parts.unshift(basename(cur));
          cur = parent;
        }
        if (rootStat !== null) rel = parts.join("/");
      }
      if (rel === null || rel === "" || diffs[rel] !== undefined) continue;
      const diff = gitRun(["diff", "HEAD", "--", rel], repoRoot);
      if (diff) diffs[rel] = diff;
    }
    if (Object.keys(diffs).length > 0) ctx.diffs = diffs;
  }
  return ctx;
}

export function policySha256(policyYaml: string): string {
  return createHash("sha256").update(policyYaml).digest("hex");
}

function truncate(s: string, max = 70): string {
  const one = s.replace(/\n/g, "\\n");
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

export function buildSnapshotMarkdown(data: SnapshotData): string {
  const lines: string[] = [];
  lines.push(`# reins operation snapshot`);
  lines.push("");
  lines.push(`- source: \`${data.sourceFile}\` (agent: **${data.agent}**, session: \`${data.sessionId}\`)`);
  lines.push(`- generated: ${data.generatedAt}`);
  lines.push(
    `- events: ${data.eventCount}` +
      (data.timeRange.first ? ` (${data.timeRange.first} → ${data.timeRange.last ?? data.timeRange.first})` : ""),
  );

  lines.push("");
  lines.push(`## integrity`);
  lines.push("");
  if (data.integrity.ok) {
    lines.push(`✅ hash chain: OK (${data.integrity.events} events)`);
  } else {
    lines.push(
      `⚠️ **TAMPERED** — ${data.integrity.reason ?? "integrity failure"} at event ${data.integrity.brokenAt} ` +
        `(${data.integrity.events} events parsed). Evidence from that point on is untrustworthy; preserved here for forensics.`,
    );
  }

  lines.push("");
  lines.push(`## policy`);
  lines.push("");
  lines.push(`- name: ${data.policy.name ?? "(unnamed)"} (${data.policy.rules} rules)`);
  lines.push(`- sha256: \`${data.policy.sha256}\``);
  lines.push(`- source: \`${data.policy.source}\``);

  lines.push("");
  lines.push(`## git context`);
  lines.push("");
  if (!data.git) {
    lines.push(`no git context: the session's touched paths live outside any repository.`);
  } else {
    lines.push(`- repo: \`${data.git.repoRoot}\``);
    lines.push(`- HEAD: \`${data.git.head.slice(0, 12)}\`${data.git.subject ? ` — ${data.git.subject}` : ""}`);
    if (data.git.dirty.length > 0) {
      lines.push(`- working tree at snapshot time:`);
      for (const d of data.git.dirty) lines.push(`  - \`${d}\``);
    } else {
      lines.push(`- working tree clean at snapshot time`);
    }

    const hints: string[] = [];
    for (const e of data.fileWrites) {
      const p = String((e.input as Record<string, unknown>)["file_path"]);
      hints.push(`- \`${p}\` (${e.decision}, seq ${e.seq}) → discard a working-tree change: \`git restore -- ${p}\``);
    }
    for (const e of data.denied) {
      hints.push(`- seq ${e.seq} was **blocked** (${e.matchedRule ?? "default"}) — nothing to undo`);
    }
    for (const e of data.allowed) {
      if ((e.matchedRule ?? "").startsWith("git-") || /git\s+(push|reset|rebase|filter)/.test(summarizeEvent(e))) {
        hints.push(`- seq ${e.seq} rewrote git state → inspect \`git reflog\` / \`git fsck --lost-found\``);
      }
    }
    if (hints.length > 0) {
      lines.push("");
      lines.push(`### recovery hints (against current HEAD — verify before running)`);
      lines.push("");
      lines.push(...hints);
    }
    if (data.git.diffs && Object.keys(data.git.diffs).length > 0) {
      lines.push("");
      lines.push(`### current diffs for touched files`);
      for (const [path, diff] of Object.entries(data.git.diffs)) {
        lines.push("");
        lines.push(`#### \`${path}\``);
        lines.push("");
        lines.push("```diff");
        lines.push(diff);
        lines.push("```");
      }
    }
  }

  lines.push("");
  lines.push(`## timeline`);
  lines.push("");
  lines.push(`| seq | time | tool | action | decision | rule | result |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- |`);
  for (const e of data.allowed.concat(data.denied).sort((a, b) => a.seq - b.seq)) {
    const input = (typeof e.input === "object" && e.input !== null ? e.input : {}) as Record<string, unknown>;
    const command = typeof input["command"] === "string" ? `\`${truncate(input["command"])}\`` : `\`${truncate(summarizeEvent(e))}\``;
    lines.push(
      `| ${e.seq} | ${e.ts} | ${e.tool} | ${command} | ${e.decision} | ${e.matchedRule ?? "—"} | ${e.result ?? "—"} |`,
    );
  }

  if (data.denied.length > 0) {
    lines.push("");
    lines.push(`## denied actions (${data.denied.length})`);
    lines.push("");
    for (const e of data.denied) {
      lines.push(`- seq ${e.seq}: \`${truncate(summarizeEvent(e))}\` — ${e.reason ?? "(no reason recorded)"}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
