import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_STALE_MS = 10_000;
const LOCK_MAX_AGE_MS = 60_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Cross-process advisory lock: concurrent hooks (parallel tool calls of one
 *  agent session) must not interleave appends and break the hash chain.
 *  The lock file records `{pid, createdAt, token}`; a lock is only stolen
 *  when its recorded pid is dead (or the lock is unparseable) after the
 *  stale window — a slow but live writer never gets its lock snatched. */
async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const token = randomBytes(16).toString("hex");
  const startedAt = Date.now();
  for (;;) {
    let fd;
    try {
      fd = await open(lockPath, "wx", FILE_MODE);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        let stolen = false;
        try {
          const raw = readFileSync(lockPath, "utf8");
          const parsed = JSON.parse(raw) as { pid: number; createdAt: number };
          const age = Date.now() - parsed.createdAt;
          if (age > LOCK_STALE_MS && !pidAlive(parsed.pid)) stolen = true;
          if (age > LOCK_MAX_AGE_MS) stolen = true;
        } catch {
          if (Date.now() - startedAt > LOCK_STALE_MS) stolen = true; // unparseable lock
        }
        if (stolen) {
          await rm(lockPath, { force: true });
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 2 + Math.random() * 6));
        continue;
      }
      throw err;
    }
    try {
      await fd.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: Date.now(), token })}\n`, "utf8");
      return await fn();
    } finally {
      await fd.close();
      await rm(lockPath, { force: true });
    }
  }
}

export const GENESIS_HASH = "genesis";

export type Decision = "allow" | "deny" | "ask";
export type TraceResult = "ok" | "error" | "blocked";

export interface TraceEvent {
  seq: number;
  ts: string;
  tool: string;
  input: unknown;
  decision: Decision;
  reason?: string;
  matchedRule?: string;
  result?: TraceResult;
  exitCode?: number;
  /** sha256 of the policy file this decision was made under — lets replay
   *  and audits bind every verdict to the exact policy version. */
  policyDigest?: string;
  /** set when this event is the first observed under a different policy
   *  digest than the rest of the session (policy changed mid-session). */
  policyDrift?: boolean;
  prevHash: string;
  hash: string;
}

export type TraceEntryInput = Omit<TraceEvent, "seq" | "ts" | "prevHash" | "hash">;

function hashEvent(event: Omit<TraceEvent, "hash">): string {
  const canonical = JSON.stringify({
    seq: event.seq,
    ts: event.ts,
    tool: event.tool,
    input: event.input,
    decision: event.decision,
    reason: event.reason,
    matchedRule: event.matchedRule,
    result: event.result,
    exitCode: event.exitCode,
    policyDigest: event.policyDigest,
    policyDrift: event.policyDrift,
    prevHash: event.prevHash,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function newSessionId(): string {
  const t = new Date().toISOString().replace(/[:.]/g, "-");
  return `${t}-${randomBytes(8).toString("hex")}`;
}

export class TraceWriter {
  private constructor(
    readonly filePath: string,
    private nextSeq: number,
    private prevHash: string,
  ) {}

  static async start(sessionsDir: string): Promise<TraceWriter> {
    const filePath = join(sessionsDir, `${newSessionId()}.jsonl`);
    await mkdir(dirname(filePath), { recursive: true, mode: DIR_MODE });
    // create the file eagerly so an empty session is verifiable, not a dangling id
    await writeFile(filePath, "", { flag: "w", mode: FILE_MODE });
    return new TraceWriter(filePath, 0, GENESIS_HASH);
  }

  /** Re-open an existing session file (or create it) and continue its hash
   *  chain. Refuses to append to a tampered or corrupt trace — fail closed.
   *  Symlinked session files are rejected (the ledger must stay inside
   *  sessions/, even if an attacker pre-plants a link). */
  static async open(filePath: string): Promise<TraceWriter> {
    await mkdir(dirname(filePath), { recursive: true, mode: DIR_MODE });
    if (existsSync(filePath)) {
      const lst = await lstat(filePath);
      if (lst.isSymbolicLink()) {
        throw new CorruptTraceError(`refusing to append: ${filePath} is a symlink`);
      }
    }
    if (!existsSync(filePath)) {
      await writeFile(filePath, "", { flag: "w", mode: FILE_MODE });
      return new TraceWriter(filePath, 0, GENESIS_HASH);
    }
    const integrity = await verifyTrace(filePath);
    if (!integrity.ok) {
      throw new CorruptTraceError(
        `refusing to append to a tampered or corrupt trace (${integrity.reason ?? "unknown"} at event ${integrity.brokenAt}): ${filePath}`,
      );
    }
    const events = await readTrace(filePath);
    const last = events[events.length - 1];
    return new TraceWriter(filePath, last ? last.seq + 1 : 0, last ? last.hash : GENESIS_HASH);
  }

  async append(entry: TraceEntryInput): Promise<TraceEvent> {
    // under the lock: re-read, re-verify the FULL chain, then append via an
    // already-opened file descriptor (symlink re-checked before open — the
    // ledger may have been tampered with after our open())
    return withFileLock(`${this.filePath}.lock`, async () => {
      if (existsSync(this.filePath)) {
        const lst = await lstat(this.filePath);
        if (lst.isSymbolicLink()) {
          throw new CorruptTraceError(`refusing to append: ${this.filePath} is a symlink`);
        }
      }
      const events = await readTrace(this.filePath);
      const integrity = verifyEvents(events);
      if (!integrity.ok) {
        throw new CorruptTraceError(
          `refusing to append to a tampered or corrupt trace (${integrity.reason ?? "unknown"} at event ${integrity.brokenAt}): ${this.filePath}`,
        );
      }
      const last = events[events.length - 1];
      const seq = last ? last.seq + 1 : 0;
      const prevHash = last ? last.hash : GENESIS_HASH;

      // policy drift: this decision was made under a different policy than
      // the previous event in the same session — recorded on the event itself
      const policyDrift =
        entry.policyDigest !== undefined &&
        last?.policyDigest !== undefined &&
        last.policyDigest !== entry.policyDigest;

      const event: Omit<TraceEvent, "hash"> = {
        seq,
        ts: new Date().toISOString(),
        tool: entry.tool,
        input: entry.input,
        decision: entry.decision,
        reason: entry.reason,
        matchedRule: entry.matchedRule,
        result: entry.result,
        exitCode: entry.exitCode,
        policyDigest: entry.policyDigest,
        policyDrift: policyDrift || undefined,
        prevHash,
      };
      const full: TraceEvent = { ...event, hash: hashEvent(event) };

      // append through an open descriptor; re-check the lstat identity right
      // before opening to shrink the check-then-use window
      const lst = await lstat(this.filePath).catch(() => null);
      if (lst?.isSymbolicLink()) {
        throw new CorruptTraceError(`refusing to append: ${this.filePath} is a symlink`);
      }
      const fh = await open(this.filePath, "a", FILE_MODE);
      try {
        const fst = await fh.stat();
        if (!fst.isFile()) {
          throw new CorruptTraceError(`refusing to append: ${this.filePath} is not a regular file`);
        }
        await fh.writeFile(JSON.stringify(full) + "\n", "utf8");
      } finally {
        await fh.close();
      }
      this.nextSeq = seq + 1;
      this.prevHash = full.hash;
      return full;
    });
  }
}

export interface VerifyResult {
  ok: boolean;
  events: number;
  brokenAt?: number;
  reason?: string;
}

class CorruptTraceError extends Error {}

export async function readTrace(filePath: string): Promise<TraceEvent[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err) {
    throw new Error(`cannot read trace file ${filePath}: ${String(err)}`, { cause: err });
  }
  const events: TraceEvent[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "") {
      // only the final line may be empty (trailing newline)
      if (i === lines.length - 1) continue;
      throw new CorruptTraceError(`trace ${filePath}: unexpected empty line at ${i + 1}`);
    }
    let parsed: TraceEvent;
    try {
      parsed = JSON.parse(line) as TraceEvent;
    } catch {
      throw new CorruptTraceError(`trace ${filePath}: partial or corrupt line at ${i + 1}`);
    }
    events.push(parsed);
  }
  return events;
}

/** Verify an in-memory event list (hash chain, genesis, seq continuity). */
export function verifyEvents(events: TraceEvent[]): VerifyResult {
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const expected = hashEvent(e);
    if (expected !== e.hash) {
      return { ok: false, events: events.length, brokenAt: i, reason: "hash mismatch" };
    }
    if (i === 0) {
      if (e.prevHash !== GENESIS_HASH) {
        return { ok: false, events: events.length, brokenAt: 0, reason: "bad genesis" };
      }
    } else if (e.prevHash !== events[i - 1]!.hash) {
      return { ok: false, events: events.length, brokenAt: i, reason: "chain break" };
    }
    if (e.seq !== i) {
      return { ok: false, events: events.length, brokenAt: i, reason: "seq gap" };
    }
  }
  return { ok: true, events: events.length };
}

export async function verifyTrace(filePath: string): Promise<VerifyResult> {
  let events: TraceEvent[];
  try {
    events = await readTrace(filePath);
  } catch (err) {
    if (err instanceof CorruptTraceError) {
      return { ok: false, events: 0, reason: err.message };
    }
    throw err;
  }
  return verifyEvents(events);
}
