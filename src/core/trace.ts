import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Cross-process advisory lock: concurrent hooks (parallel tool calls of one
 *  agent session) must not interleave appends and break the hash chain.
 *  Stale locks (older than 10s — crashed writer) are stolen. */
async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  let startedAt = Date.now();
  for (;;) {
    let fd;
    try {
      fd = await open(lockPath, "wx", FILE_MODE);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        if (Date.now() - startedAt > 10_000) {
          await rm(lockPath, { force: true }); // steal stale lock and retry immediately
          startedAt = Date.now();
          continue;
        }
        await new Promise((resolve) => setTimeout(resolve, 2 + Math.random() * 6));
        continue;
      }
      throw err;
    }
    try {
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
   *  chain. Refuses to append to a tampered or corrupt trace — fail closed. */
  static async open(filePath: string): Promise<TraceWriter> {
    await mkdir(dirname(filePath), { recursive: true, mode: DIR_MODE });
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
    // re-read and re-verify the chain under the lock: another hook process
    // may have appended between our open() and this append()
    return withFileLock(`${this.filePath}.lock`, async () => {
      const events = await readTrace(this.filePath);
      const last = events[events.length - 1];
      const seq = last ? last.seq + 1 : 0;
      const prevHash = last ? last.hash : GENESIS_HASH;

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
        prevHash,
      };
      const full: TraceEvent = { ...event, hash: hashEvent(event) };
      await appendFile(this.filePath, JSON.stringify(full) + "\n", { encoding: "utf8", mode: FILE_MODE });
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
