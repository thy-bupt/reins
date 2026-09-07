import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, existsSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_STALE_MS = 10_000;
const LOCK_UNPARSEABLE_GRACE_MS = 30_000;

/** The ledger boundary is REINS_HOME and everything under it — not just the
 *  leaf file name. `sessions/` or REINS_HOME itself being symlinks lets a
 *  hook write evidence outside the home (found by round-5 black-box review);
 *  both are rejected here. Also self-heals directory modes to 0700. */
export async function ensureSecureLedgerDirs(reinsHome: string, sessionsDir: string): Promise<void> {
  const targets: Array<[string, string]> = [
    ["reins home", reinsHome],
    ["sessions", sessionsDir],
  ];
  for (const [label, dir] of targets) {
    if (existsSync(dir)) {
      const lst = await lstat(dir);
      if (lst.isSymbolicLink()) {
        throw new CorruptTraceError(`refusing: ${label} directory (${dir}) is a symlink`);
      }
      if (!lst.isDirectory()) {
        throw new CorruptTraceError(`refusing: ${label} path (${dir}) is not a directory`);
      }
    }
  }
  await mkdir(reinsHome, { recursive: true, mode: DIR_MODE });
  await chmod(reinsHome, DIR_MODE).catch(() => {});
  await mkdir(sessionsDir, { recursive: true, mode: DIR_MODE });
  await chmod(sessionsDir, DIR_MODE).catch(() => {});
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Steal decision, extracted for testing: a lock held by a LIVE process is
 *  never stolen — no matter how old. Dead-pid locks are stolen after the
 *  stale window; unparseable locks get a longer grace window. */
export function shouldStealLock(
  raw: string | null,
  now: number,
  firstSeenAt: number,
): boolean {
  if (raw === null) return false;
  let parsed: { pid?: number; createdAt?: number };
  try {
    parsed = JSON.parse(raw) as { pid?: number; createdAt?: number };
  } catch {
    return now - firstSeenAt > LOCK_UNPARSEABLE_GRACE_MS;
  }
  const pid = parsed.pid;
  const createdAt = parsed.createdAt;
  if (typeof pid !== "number" || typeof createdAt !== "number") {
    return now - firstSeenAt > LOCK_UNPARSEABLE_GRACE_MS;
  }
  if (pidAlive(pid)) return false; // slow but live writer: never snatched
  return now - createdAt > LOCK_STALE_MS;
}

/** Cross-process advisory lock: concurrent hooks (parallel tool calls of one
 *  agent session) must not interleave appends and break the hash chain.
 *  The lock file records `{pid, createdAt, token}`; a lock is only stolen
 *  when its recorded pid is dead (or the lock is unparseable) after the
 *  grace window — a slow but live writer never gets its lock snatched. */
async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const token = randomBytes(16).toString("hex");
  const firstSeenAt = Date.now();
  for (;;) {
    let fd;
    try {
      fd = await open(lockPath, "wx", FILE_MODE);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        let existing: string | null;
        try {
          existing = readFileSync(lockPath, "utf8");
        } catch {
          existing = null;
        }
        if (shouldStealLock(existing, Date.now(), firstSeenAt)) {
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
    await ensureSecureLedgerDirs(sessionsDir, sessionsDir);
    // create the file eagerly so an empty session is verifiable, not a dangling id;
    // "wx" refuses to follow a symlink planted between the check and creation
    try {
      await writeFile(filePath, "", { flag: "wx", mode: FILE_MODE });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    return new TraceWriter(filePath, 0, GENESIS_HASH);
  }

  /** Re-open an existing session file (or create it) and continue its hash
   *  chain. Refuses to append to a tampered or corrupt trace — fail closed.
   *  Symlinked session files AND symlinked ledger directories are rejected
   *  (the ledger must stay inside sessions/, even if an attacker pre-plants
   *  a link at either level). */
  static async open(filePath: string): Promise<TraceWriter> {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true, mode: DIR_MODE });
    } else {
      const dirStat = await lstat(dir);
      if (dirStat.isSymbolicLink()) {
        throw new CorruptTraceError(`refusing to append: ledger directory ${dir} is a symlink`);
      }
    }
    if (existsSync(filePath)) {
      const lst = await lstat(filePath);
      if (lst.isSymbolicLink()) {
        throw new CorruptTraceError(`refusing to append: ${filePath} is a symlink`);
      }
    }
    if (!existsSync(filePath)) {
      try {
        await writeFile(filePath, "", { flag: "wx", mode: FILE_MODE });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
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

      // append through an O_NOFOLLOW descriptor opened right after the lstat
      // identity check — the kernel itself refuses to follow a symlink swapped
      // in between the checks (closes the lstat→open TOCTOU window)
      const lst = existsSync(this.filePath) ? await lstat(this.filePath) : null;
      if (lst?.isSymbolicLink()) {
        throw new CorruptTraceError(`refusing to append: ${this.filePath} is a symlink`);
      }
      const noFollow = fsConstants.O_NOFOLLOW ?? 0;
      let fh;
      try {
        fh = await open(this.filePath, fsConstants.O_WRONLY | fsConstants.O_APPEND | noFollow, FILE_MODE);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ELOOP") {
          throw new CorruptTraceError(`refusing to append: ${this.filePath} is a symlink (race detected)`);
        }
        throw err;
      }
      try {
        const fst = await fh.stat();
        if (!fst.isFile()) {
          throw new CorruptTraceError(`refusing to append: ${this.filePath} is not a regular file`);
        }
        // identity re-check: the fd must still be the same inode we just
        // stat'ed — a swap between lstat and open lands here
        if (lst && (fst.dev !== lst.dev || fst.ino !== lst.ino)) {
          throw new CorruptTraceError(`refusing to append: ${this.filePath} changed identity between checks`);
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
