import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import * as clack from "@clack/prompts";
import { summarizeEvent } from "../cli/snapshot.js";
import { readTrace, verifyTrace, type TraceEvent } from "../core/trace.js";
import { c } from "./colors.js";
import { renderEventDetail, renderTimeline } from "./render.js";
import { strings, type Lang, type UiStrings } from "./i18n.js";

export interface UiContext {
  sessionsDir: string;
  policyPath: string;
  version: string;
  lang: Lang;
}

interface SessionFile {
  name: string;
  path: string;
  events: TraceEvent[];
  integrity: { ok: boolean; events: number; brokenAt?: number; reason?: string };
  driftCount: number;
  mtimeMs: number;
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
      mtimeMs: statSync(path).mtimeMs,
    });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Interactive session browser: pick a session → colored timeline → drill
 *  into an event. Bilingual (en/zh). Read-only — no enforcement, no LLM,
 *  no network. */
export async function runUi(ctx: UiContext): Promise<void> {
  const s = strings(ctx.lang);
  clack.intro(`${c.bold(`reins ${ctx.version}`)} — ${s.appTitle}`);

  if (!existsSync(ctx.sessionsDir) || (await listSessions(ctx.sessionsDir)).length === 0) {
    clack.log.warn(s.noSessions);
    clack.outro(s.exit);
    return;
  }

  let running = true;
  while (running) {
    const sessions = await listSessions(ctx.sessionsDir);
    const options: Array<{ value: string; label: string; hint?: string }> = sessions.map((sess, i) => ({
      value: String(i),
      label: sess.name,
      hint: `${sess.events.length} ${s.eventsLabel}${sess.integrity.ok ? "" : s.tamperedLabel}${sess.driftCount ? s.driftLabel : ""}`,
    }));
    options.push({ value: "__exit__", label: s.exit });

    const picked = await clack.select({ message: s.selectSession, options });
    if (clack.isCancel(picked) || picked === "__exit__") {
      running = false;
      continue;
    }
    const chosen = sessions[Number(picked)]!;
    await browseSession(chosen, s);
  }
  clack.outro(s.exit);
}

async function browseSession(chosen: SessionFile, s: UiStrings): Promise<void> {
  let back = false;
  while (!back) {
    const act = await clack.select({
      message: chosen.name,
      options: [
        { value: "timeline", label: s.actionTimeline, hint: s.actionTimelineHint },
        { value: "events", label: s.actionEvents, hint: s.actionEventsHint },
        { value: "verify", label: s.actionVerify, hint: s.actionVerifyHint },
        { value: "back", label: s.actionBack },
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
          strings: s,
        }),
      );
    }
    if (act === "events") {
      if (chosen.events.length === 0) {
        clack.log.warn(s.emptySession);
        continue;
      }
      const pick = await clack.select({
        message: s.actionEvents,
        options: chosen.events.map((e) => ({
          value: String(e.seq),
          label: `#${e.seq} ${e.decision.toUpperCase()} ${e.tool}`,
          hint: summarizeEvent(e).slice(0, 60),
        })),
      });
      if (clack.isCancel(pick)) continue;
      const chosenEvent = chosen.events[Number(pick)]!;
      clack.note(renderEventDetail(chosenEvent, s), `event #${chosenEvent.seq}`);
    }
    if (act === "verify") {
      const integrity = await verifyTrace(chosen.path);
      clack.log[integrity.ok ? "info" : "error"](
        integrity.ok ? s.verifyOk(integrity.events) : s.verifyFail(integrity.reason ?? "", integrity.brokenAt),
      );
    }
  }
}
