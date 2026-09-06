import { basename } from "node:path";
import { parse as shellParse } from "shell-quote";
import picomatch from "picomatch";

/** tokens that wrap a real command without changing what runs (best effort). */
const WRAPPER_TOKENS: ReadonlySet<string> = new Set([
  "sudo",
  "nohup",
  "command",
  "time",
  "nice",
  "exec",
  "stdbuf",
  "env",
  "xargs",
]);

/** prefixes that introduce an embedded command argument (e.g. find -exec rm ...). */
const EXEC_CONTEXTS: ReadonlySet<string> = new Set(["-exec", "-execdir"]);

/** split a raw command string into argv arrays, one per shell "segment".
 *  Handles newlines, ; && || & (via pre-split) and | (via shell-quote ops).
 *  Quote-aware: shell-quote keeps quoted text as single tokens. */
export function parseSegments(raw: string): string[][] {
  const segments: string[][] = [];
  // pre-split on command separators; alternation order keeps && / || intact before single &
  const chunks = raw.split(/(?:\r?\n|&&|\|\||;|&)/);
  for (const chunk of chunks) {
    if (chunk.trim() === "") continue;
    let current: string[] = [];
    for (const token of shellParse(chunk)) {
      if (typeof token === "string") {
        current.push(token);
      } else if ("op" in token) {
        if (current.length > 0) segments.push(current);
        current = [];
      } else if ("pattern" in token) {
        current.push(token.pattern);
      }
    }
    if (current.length > 0) segments.push(current);
  }
  return segments;
}

/** expand combined short flags: "-rf" -> ["-r", "-f"]; long flags unchanged.
 *  Only 1-3 letters are expanded so multi-letter single-dash options
 *  like find's -exec or -name survive intact. */
export function expandFlags(token: string): string[] {
  if (/^-[a-zA-Z]{1,3}$/.test(token)) {
    return [...token.slice(1)].map((c) => `-${c}`);
  }
  return [token];
}

export interface ProgramMatch {
  program: string;
  /** argv index of the program token */
  index: number;
  /** tokens after the program (short-combined flags already expanded) */
  rest: string[];
}

/** candidate program positions in a segment: argv[0] (skipping wrappers and
 *  env assignments) plus tokens introduced by an exec context (find -exec rm). */
export function findProgramCandidates(argv: string[]): ProgramMatch[] {
  const expanded = argv.flatMap(expandFlags);
  const matches: ProgramMatch[] = [];

  let firstReal = 0;
  while (firstReal < expanded.length) {
    const t = expanded[firstReal]!;
    if (WRAPPER_TOKENS.has(t) || /^[\w-]+=/.test(t)) {
      firstReal += 1;
    } else {
      break;
    }
  }
  if (firstReal < expanded.length) {
    matches.push({
      program: basename(expanded[firstReal]!).toLowerCase(),
      index: firstReal,
      rest: expanded.slice(firstReal + 1),
    });
  }

  for (let i = 1; i < expanded.length; i++) {
    if (EXEC_CONTEXTS.has(expanded[i - 1]!)) {
      const t = expanded[i]!;
      if (!t.startsWith("-")) {
        matches.push({ program: basename(t).toLowerCase(), index: i, rest: expanded.slice(i + 1) });
      }
    }
  }
  return matches;
}

const regexCache = new Map<string, RegExp>();

export function compilePattern(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern);
    regexCache.set(pattern, re);
  }
  return re;
}

const matchCache = new Map<string, (p: string) => boolean>();

/** path glob match: full absolute path match, or basename match for slash-free globs. */
export function matchesPathGlob(glob: string, filePath: string): boolean {
  let matcher = matchCache.get(glob);
  if (!matcher) {
    const pm = picomatch(glob, { dot: true });
    const bare = picomatch(glob, { dot: true, basename: true });
    matcher = (p: string) => pm(p) || bare(p);
    matchCache.set(glob, matcher);
  }
  return matcher(filePath);
}
