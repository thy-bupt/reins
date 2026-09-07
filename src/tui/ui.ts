import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { summarizeEvent } from "../cli/snapshot.js";
import { readTrace, verifyTrace, type TraceEvent } from "../core/trace.js";
import { renderEventDetail, renderTimeline } from "./render.js";

export interface UiContext {
  sessionsDir: string;
  policyPath: string;
  version: string;
}

interface SessionFile {
  name: string;
  path: string;
  events: TraceEvent[];
  integrity: { ok: boolean; events: number; brokenAt?: number; reason?: string };
  driftCount: number;
}

async function listSessions(sessionsDir: string): Promise<SessionFile[]> {
  if (!existsSync(sessionsDir)) return [];
  const out: SessionFile[] = [];
  for (const name of readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"))) {
    const path = join(sessionsDir, name);
    const events = await readTrace(path);
    const integrity = await verifyTrace(path);
      const drifts = new Set(
        events.map((e: TraceEvent) => e.policyDigest).filter((d: unknown): d is string => typeof d === "string"),
      );
      out.push({
        name,
        path,
        events,
        integrity,
        driftCount: drifts.size > 1 ? drifts.size : 0,
      });
  }
  return out.sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
}

/** Interactive session browser: pick a session → colored timeline → drill
 *  into an event. Only runs in a real TTY (clack prompts need one); callers
 *  must fall back to plain output otherwise. Read-only — no enforcement,
 *  no LLM, no network. */
export async function runUi(ctx: UiContext): Promise<void> {
  clack.intro(`reins ${ctx.version} — session browser`);

  if (!existsSync(ctx.sessionsDir) || (await listSessions(ctx.sessionsDir)).length === 0) {
    clack.log.warn("no sessions yet — agent decisions will appear here once a reins-protected agent runs");
    clack.outro("done");
    return;
  }

  let running = true;
  while (running) {
    const sessions = await listSessions(ctx.sessionsDir);
    const options: Array<{ value: string; label: string; hint?: string }> = sessions.map((s, i) => ({
      value: String(i),
      label: s.name,
      hint: `${s.events.length} events${s.integrity.ok ? "" : " · TAMPERED"}${s.driftCount ? " · drift" : ""}`,
    }));
    options.push({ value: "__exit__", label: "退出 Exit" });

    const picked = await clack.select({ message: "选择会话 Session", options });
    if (clack.isCancel(picked) || picked === "__exit__") {
      running = false;
      continue;
    }
    const chosen = sessions[Number(picked)]!;
    await browseSession(chosen);
  }
  clack.outro("done");
}

async function browseSession(chosen: SessionFile): Promise<void> {
  let back = false;
  while (!back) {
    const act = await clack.select({
      message: chosen.name,
      options: [
        { value: "timeline", label: "时间线 Timeline", hint: "colored decision timeline" },
        { value: "events", label: "事件详情 Events", hint: "drill into a single decision" },
        { value: "verify", label: "校验 Verify", hint: "re-verify the hash chain now" },
        { value: "back", label: "返回 Back" },
      ],
    });
    if (clack.isCancel(act) || act === "back") {
      back = true;
      continue;
    }
    if (act === "timeline") {
      clack.log.message(
        renderTimeline(chosen.events, {
          sourceLabel: chosen.name,
          integrityOk: chosen.integrity.ok,
          integrityNote: chosen.integrity.reason,
          driftCount: chosen.driftCount,
        }),
      );
    }
    if (act === "events") {
      if (chosen.events.length === 0) {
        clack.log.warn("(empty session)");
        continue;
      }
      const pick = await clack.select({
        message: "选择事件 Event",
        options: chosen.events.map((e) => ({
          value: String(e.seq),
          label: `#${e.seq} ${e.decision.toUpperCase()} ${e.tool}`,
          hint: summarizeEvent(e).slice(0, 60),
        })),
      });
      if (clack.isCancel(pick)) continue;
      const chosenEvent = chosen.events[Number(pick)]!;
      clack.note(renderEventDetail(chosenEvent), `event #${chosenEvent.seq}`);
    }
    if (act === "verify") {
      const integrity = await verifyTrace(chosen.path);
      clack.log[integrity.ok ? "info" : "error"](
        integrity.ok
          ? `✔ ${integrity.events} events, chain intact`
          : `✗ TAMPERED: ${integrity.reason} at event ${integrity.brokenAt}`,
      );
    }
  }
}
