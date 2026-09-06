import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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
    result: event.result,
    exitCode: event.exitCode,
    prevHash: event.prevHash,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function newSessionId(): string {
  const t = new Date().toISOString().replace(/[:.]/g, "-");
  return `${t}-${randomBytes(3).toString("hex")}`;
}

export class TraceWriter {
  private constructor(
    readonly filePath: string,
    private nextSeq: number,
    private prevHash: string,
  ) {}

  static async start(sessionsDir: string): Promise<TraceWriter> {
    const filePath = join(sessionsDir, `${newSessionId()}.jsonl`);
    await mkdir(dirname(filePath), { recursive: true });
    // create the file eagerly so an empty session is verifiable, not a dangling id
    await writeFile(filePath, "", { flag: "w" });
    return new TraceWriter(filePath, 0, GENESIS_HASH);
  }

  async append(entry: TraceEntryInput): Promise<TraceEvent> {
    const event: Omit<TraceEvent, "hash"> = {
      seq: this.nextSeq,
      ts: new Date().toISOString(),
      tool: entry.tool,
      input: entry.input,
      decision: entry.decision,
      reason: entry.reason,
      result: entry.result,
      exitCode: entry.exitCode,
      prevHash: this.prevHash,
    };
    const full: TraceEvent = { ...event, hash: hashEvent(event) };
    await appendFile(this.filePath, JSON.stringify(full) + "\n", "utf8");
    this.nextSeq += 1;
    this.prevHash = full.hash;
    return full;
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
    throw new Error(`cannot read trace file ${filePath}: ${String(err)}`);
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
