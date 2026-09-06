# Changelog

All notable changes to reins are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning is SemVer.

## [Unreleased]

### Added
- **MCP server** — `reins mcp` (stdio) exposes read-only tools over the core:
  `check_command`, `recent_decisions`, `policy_summary`, `stats`; registered
  into Claude Code with `reins init mcp`. New dependency:
  `@modelcontextprotocol/sdk`.
- **Skills** — `reins init skills` installs `reins-selfcheck` and
  `reins-incident` workflow skills (pure markdown, advisory, cleanly
  uninstallable); shipped in the npm package under `skills/`.
- **CLI ergonomics** — `trace show` (human-readable ledger timeline),
  `policy eval` (dry-run a command or file path against the policy, never
  executes; exit code mirrors hook semantics), and `uninstall <agent>` for
  all six adapters (removes only reins entries / marker-verified generated
  files; repurposed files are left alone)
- `macos-latest` CI job (the primary dev platform was missing from CI)
- **Acceptance evidence** — end-to-end validation on a real clone of
  expressjs/express (interception, ledger, snapshot, recovery via
  `git restore`, MCP query, uninstall): [docs/evidence-v0.2.md](docs/evidence-v0.2.md)
- **Operation snapshots** — `reins snapshot` builds a forensic markdown report per session:
  integrity verdict (tampered traces are flagged, not refused), policy sha256
  fingerprint, full decision timeline, git context of touched files (repo, HEAD,
  dirty state, optional `--with-diffs`) and recovery hints (`git restore`,
  `git reflog`).
- **Windows support** — cross-platform process layer (`cmd.exe /d /s /c` on
  win32, `REINS_SHELL` override), backslash-aware path glob matching,
  platform-aware tests, and a `windows-latest` CI job. Validated end-to-end on
  real Windows hardware (all 154 tests, including the six-agent matrix).
- **Multi-agent adapters** with end-to-end matrix tests (init → hook → ledger
  verify per agent):
  - Gemini CLI — `BeforeTool` hook in `~/.gemini/settings.json`
  - Codex — `~/.codex/hooks.json` plus comment-preserving
    `[features] hooks = true` injection into `config.toml`
  - Grok Build — hook file in `~/.grok/hooks/` (camelCase payload)
  - opencode — auto-loaded plugin that blocks by throwing
  - pi — auto-loaded extension using the `tool_call` block contract
- `reins init <agent>` and `reins hook <agent>` accept all adapters;
  ask rules fail closed on agents without an ask channel
- `reins doctor` reports per-agent install status (optional agents warn,
  never fail)

## [0.1.0] — 2026-09-06

Initial release.

### Added
- **Policy engine** — declarative YAML (`allow` / `ask` / `deny`), rules on:
  - program + flags with combined-short-flag expansion and wrapper detection
    (`sudo`, `env`, `xargs`, …), absolute program paths, and subcommands
    (`git push --force` ⇒ program `git`, subcommand `push`)
  - exec-context matching (`find -exec rm …`)
  - raw regex against the command string (`curl … | sh`)
  - dot-aware path globs for file tools (`.env*`, `.ssh/**`, `.git/**`)
  - first-match-wins ordering, tool-name scoping, policy-level default
- **Tamper-evident trace** — append-only JSONL per session, SHA-256 hash chain
  over every record; `trace verify` reports modification/deletion gaps; hooks
  refuse to append to a broken chain (fail closed)
- **Claude Code adapter** — PreToolUse hook: `deny` ⇒ exit 2 + reason on
  stderr, `ask` ⇒ `permissionDecision` JSON, malformed payloads fail closed;
  `reins init claude` installs policy + hook with settings backup
- **Generic exec wrapper** — `reins exec -- <cmd>` with the same policy
  and ledger (works from scripts, CI, any agent)
- **doctor** — policy validity, hook installation, session/trace integrity,
  PATH check
- **replay** — re-evaluate a recorded session under a candidate policy:
  would-block / already-blocked / decision-change report, `--strict` gate;
  refuses tampered traces
- **Default policy** — 13 rules (recursive deletion, force push, pipe-to-shell,
  fork bomb, mkfs/dd, secrets paths) + bypass-resistance test suite

[0.1.0]: https://github.com/YOUR_USERNAME/reins/releases/tag/v0.1.0
