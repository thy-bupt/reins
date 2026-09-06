import { basename } from "node:path";
import { parse as shellParse } from "shell-quote";
import picomatch from "picomatch";

/** tokens that wrap a real command without changing what runs (best effort):
 *  classic wrappers plus POSIX control-flow keywords so `if true; then rm …`,
 *  `while …; do rm …; done` and `{ rm …; }` still resolve to the real program. */
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
  // control flow
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "while",
  "until",
  "for",
  "do",
  "done",
  "{",
  "}",
  "!",
]);

/** flags of wrapper tokens that take a value: `sudo -u root rm` must find
 *  past "root" — the flag-consumes-next-token heuristic. */
const WRAPPER_VALUE_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["sudo", new Set(["u", "g", "p", "C", "h", "k", "T"])],
  ["env", new Set(["u"])],
  ["nice", new Set(["n", "d", "s"])],
  ["xargs", new Set(["I", "J", "L", "P", "s"])],
  ["command", new Set(["p", "v"])],
  ["stdbuf", new Set(["o", "e", "i"])],
  ["exec", new Set(["a", "c"])],
]);

/** programs that execute their -c/-Command argument as a shell script. */
export const SHELL_INTERPRETERS: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "cmd",
  "powershell",
  "pwsh",
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
        current.push((token as { pattern: string }).pattern);
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

/** candidate program positions in a segment: argv[0] (skipping wrappers,
 *  their value-taking flags, bare flags and env assignments) plus tokens
 *  introduced by an exec context (find -exec rm). */
export function findProgramCandidates(argv: string[]): ProgramMatch[] {
  const expanded = argv.flatMap(expandFlags);
  const matches: ProgramMatch[] = [];

  let firstReal = 0;
  let lastWrapper: string | null = null;
  let skipNext = false;
  while (firstReal < expanded.length) {
    const t = expanded[firstReal]!;
    if (skipNext) {
      skipNext = false;
      firstReal += 1;
      continue;
    }
    if (WRAPPER_TOKENS.has(t)) {
      lastWrapper = t;
      firstReal += 1;
      continue;
    }
    if (/^[\w-]+=/.test(t) || t === "--" || t.startsWith("-")) {
      // a value-taking wrapper flag consumes the following token
      if (lastWrapper && t.startsWith("-") && !t.startsWith("--")) {
        const base = t.replace(/^-+/, "");
        if (WRAPPER_VALUE_FLAGS.get(lastWrapper)?.has(base)) skipNext = true;
      }
      firstReal += 1;
      continue;
    }
    break;
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

/** Extract commands that will run indirectly: `$(…)`, backticks, and the
 *  script text of `bash -c "…"`-style interpreter invocations. Returns the
 *  inner command strings for (recursive) policy evaluation. */
export function deriveInnerCommands(raw: string, depth: number): string[] {
  if (depth <= 0) return [];
  const out: string[] = [];

  const subst = /\$\(([^()]*)\)|`([^`]*)`/g;
  for (const m of raw.matchAll(subst)) {
    const inner = m[1] ?? m[2];
    if (inner && inner.trim() !== "") {
      out.push(inner);
      out.push(...deriveInnerCommands(inner, depth - 1));
    }
  }

  for (const seg of parseSegments(raw)) {
    for (const cand of findProgramCandidates(seg)) {
      if (!SHELL_INTERPRETERS.has(cand.program)) continue;
      const ci = cand.rest.findIndex((t) => t.toLowerCase() === "-c" || t.toLowerCase() === "-command");
      const script = ci !== -1 ? cand.rest[ci + 1] : undefined;
      if (script && script.trim() !== "") {
        out.push(script);
        out.push(...deriveInnerCommands(script, depth - 1));
      }
    }
  }
  return out;
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

/** Shell invocation per platform. posix = /bin/bash -c (or REINS_SHELL),
 *  win32 = cmd.exe /d /s /c (or an explicit override such as pwsh). */
export function resolveShellCommand(
  platform: "posix" | "win32",
  command: string,
  shellOverride?: string,
): { file: string; args: string[] } {
  if (shellOverride) {
    return { file: shellOverride, args: ["-c", command] };
  }
  if (platform === "win32") {
    const comspec = process.env["ComSpec"] ?? "cmd.exe";
    return { file: comspec, args: ["/d", "/s", "/c", command] };
  }
  return { file: "/bin/bash", args: ["-c", command] };
}

/** path glob match: full absolute path match, or basename match for slash-free globs.
 *  Windows backslashes are normalized to forward slashes first so forward-slash
 *  globs match native Windows paths (picomatch treats `\` as a literal). */
export function matchesPathGlob(glob: string, filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  let matcher = matchCache.get(glob);
  if (!matcher) {
    const pm = picomatch(glob, { dot: true });
    const bare = picomatch(glob, { dot: true, basename: true });
    matcher = (p: string) => pm(p) || bare(p);
    matchCache.set(glob, matcher);
  }
  return matcher(normalized);
}
