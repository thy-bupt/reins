/** Minimal ANSI styling with automatic degradation: colors are emitted only
 *  when stdout is a TTY and NO_COLOR is unset. Zero dependencies. */

let cachedEnabled: boolean | null = null;

function enabled(): boolean {
  if (cachedEnabled === null) {
    cachedEnabled = Boolean(process.stdout.isTTY) && !process.env["NO_COLOR"];
  }
  return cachedEnabled;
}

/** test hook: force-recompute the enabled flag */
export function resetColorCache(): void {
  cachedEnabled = null;
}

function wrap(code: string, s: string): string {
  return enabled() ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export const c = {
  bold: (s: string) => wrap("1", s),
  dim: (s: string) => wrap("2", s),
  red: (s: string) => wrap("31", s),
  green: (s: string) => wrap("32", s),
  yellow: (s: string) => wrap("33", s),
  blue: (s: string) => wrap("34", s),
  magenta: (s: string) => wrap("35", s),
  cyan: (s: string) => wrap("36", s),
  /** decision → color+label mapping used across views */
  decision: (d: string): { label: string; colorize: (s: string) => string } => {
    if (d === "deny") return { label: "DENY", colorize: c.red };
    if (d === "ask") return { label: "ASK ", colorize: c.yellow };
    return { label: "ALLOW", colorize: c.green };
  },
};

/** Box-drawing panel with a title, for stats / verdict cards. */
export function panel(title: string, rows: string[]): string {
  const width = Math.max(title.length + 4, ...rows.map((r) => stripAnsi(r).length + 4));
  const top = `┌─ ${c.bold(title)} ─${"─".repeat(Math.max(0, width - title.length - 4))}┐`;
  const bottom = `└─${"─".repeat(width - 2)}┘`;
  const body = rows.map((r) => `│ ${r.padEnd(stripAnsi(r).length + (r.length - stripAnsi(r).length), " ")} │`);
  return [top, ...body, bottom].join("\n");
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}
