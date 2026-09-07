# Changelog

All notable changes to reins are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning is SemVer.

## [0.4.0] - 2026-09-07

### Added
- **Interactive session browser** — bare `reins` (in a TTY) and `reins ui`
  open a colored session browser: session picker with event counts and
  integrity flags, color-coded decision timelines (green/yellow/red),
  event drill-in detail cards (policy digest, drift flags, event hash),
  in-place chain re-verification. Non-TTY stdout and `NO_COLOR` degrade to
  plain output automatically.

## [0.3.3] - 2026-09-08

Independent security test round (mimosa deep scan + manual dynamic testing on
real ~/.codex) plus real-scenario round-2 (see docs/security-test-2026-09-07.md).

### Fixed
- **REINS_SHELL policy bypass closed (H1, PoC-confirmed)** — `reins exec` now
  always executes under the platform default interpreter (/bin/bash posix,
  literal `cmd.exe` win32 — ComSpec is no longer honored). The checked string
  and the executed content can no longer diverge. `REINS_SHELL` env var and
  the `shell` option are removed; regression tests cover fake-binary,
  nonexistent-interpreter and ledger-digest recording.
- **`reins replay` / `snapshot` / `trace show` / `trace export` accept session
  names** (not just full paths) and report a friendly, non-stack error when
  the session is not found (`resolveTraceArg`)
- **`node dist/mcp/server.js` works directly** — self-entry detection added
  (previously exited silently with no hint); `reins mcp` remains the primary
  entry
- **doctor flags unreadable codex hooks.json** — init would rebuild it from
  scratch losing third-party hooks; the backup is now pointed at

### Security
- `REINS_SHELL`/`ComSpec` removal also closes the Windows-side interpreter
  divergence (round-2 audit companion finding)
- plaintext `ANTHROPIC_AUTH_TOKEN` and codex bearer token rotation advised
  (host config hygiene, not a reins defect)

## [0.3.2] - 2026-09-07

Round-5 independent review fixes. All carry regression tests (285 total).

### Fixed
- **Ledger directory boundary (P0)** — `sessions/` or REINS_HOME being
  symlinks is now rejected at open/append; ledger directories self-heal to
  mode 0700
- **Leaf append TOCTOU closed** — appends open the ledger with `O_NOFOLLOW`
  and verify dev/ino identity between check and write
- **`init` now creates `.reins` and `sessions/` with mode 0700** (was 0755)
  and self-heals pre-existing world-readable dirs
- **`suggest --session` no longer leaks sibling sessions** — the summary is
  built from the exact caller-selected file list
- **LLM outbound paths anonymized** — home paths fold to `~/...`; other
  absolute paths collapse to `<ABS_PATH>/basename` (suggest + explain)
- **MCP `suggest_alternative` redacts the denied command** before building
  the LLM prompt
- **npm packaging** — `scripts.prepack` is now `npm run build`

## [0.3.1] - 2026-09-07

Round-4 independent review fixes. The deterministic core from 0.3.0 is
unchanged; all fixes carry regression tests (255 tests total).

### Fixed
- **doctor detects unprotected projects** — a working directory with its own
  `.claude/settings.json` (or `.claude/` dir) but no reins hook is flagged
  ("agent sessions here are unrecorded"); found during a real terraform-repo
  session where a missing project hook let an agent write terraform.tfstate
  unnoticed
- **`reins suggest --apply` corrupted empty policies** — appends are now a
  structured merge: accepted Rule objects are appended to the policy AST,
  re-serialized with the yaml library, and round-tripped through
  `loadPolicy` before an atomic write; any failure leaves the original
  bytes untouched (regression: `rules: []` + --apply produced invalid YAML)
- **YAML injection via LLM proposals** — proposals no longer hand-build
  YAML; field sanitization (length/control chars), over-broad path rejection
  (`**` and friends), path false-positive corpus, 3-proposal cap and
  `[llm-suggested <date>]` provenance added
- **MCP server now reads the llm config** — `suggest_alternative`'s LLM
  fallback actually engages when a provider is configured (was hardcoded
  to none); MCP server version now tracks the package version
- **`--session` is honored** by `reins suggest` (was declared but ignored)
- **Privacy: LLM prompts are redacted** — `suggest`/`explain` send
  secret-redacted commands and `~`-folded paths; explain uses a dedicated
  LLM-safe renderer (no absolute paths, no diffs); report files written 0600

### Security
- **Lock stealing never snatches a live writer** — dead-pid check on every
  steal; unparseable locks get a 30s grace window
- **`openai` endpoint hardening** — unspecified/IPv4-mapped/ULA/link-local
  IPv6 and `0.0.0.0` rejected; redirects refused (`redirect: "error"`);
  DNS-resolution pinning documented as a known limitation

## [0.3.0] - 2026-09-07

### Added
- **LLM integration (optional, off by default)** — `reins suggest` (LLM proposes
  policy rules from ledger deny patterns; every proposal passes schema
  validation, replay impact analysis and false-positive corpus checks before a
  human applies it), `reins explain` (incident narrative from a snapshot) and
  the `suggest_alternative` MCP tool (deterministic alternatives table first,
  optional LLM fallback, every candidate re-checked by the decider).
  Providers: `none` (default) / `command` (ollama, any CLI) / `openai`-compatible.
  Zero new runtime dependencies. See `docs/LLM.md`.
- **Append-time chain re-verification** — appends now verify the full hash
  chain inside the lock; a ledger tampered after `open()` is refused instead
  of being appended to. Lock files carry `{pid, createdAt, token}` and are
  only stolen when the owning pid is dead (crash-safe, no live-writer snatch).
- **Symlink defense** — session ledgers that are symlinks are rejected on
  open and re-checked before every append; appends go through an opened file
  descriptor. Planted-symlink e2e test included.
- **Evidence export hardening** — invalid `--format` fails closed (exit 2);
  per-event `integrity_status` splits `verified_before_break` from
  `untrusted_after_break` with machine-readable `integrity_reason` and
  `integrity_broken_at`; commands are secret-redacted by default with
  `command_digest` preserving evidentiary value (`--no-redact` for raw).
- **`doctor --all`** — check every adapter without failing on absence.
- **New tests** — bypass corpus, tamper-then-append regression, planted
  symlink e2e, 24-concurrent hook e2e, session traversal, privacy redaction,
  permission preservation, export semantics (240 tests total).

### Fixed
- grok adapter session naming regression (camelCase session ids fell back to
  adhoc sessions after the sanitize wiring)
- session id randomness bumped 24 → 64 bits (Mimosa finding)

## [0.2.0] - 2026-09-07

Evidence MVP / experimental release.

### Added
- **Policy digest anchoring** — every ledger event records the sha256 of the
  policy it was decided under; in-session policy changes are flagged as drift
  on the event and surfaced by `doctor`
- **`trace export`** — schema `reins.evidence/v1` (ndjson/json)
- **Multi-agent adapters** — Claude Code, Gemini CLI, Codex, Grok Build,
  opencode, pi with end-to-end matrix tests; `init/hook/uninstall` for all
- **CLI ergonomics** — `trace show`, `policy eval` (dry-run),
  `uninstall <agent>`, `doctor --agent/--all`
- **Operation snapshots** — `reins snapshot --with-diffs`: forensic markdown
  report with git correlation and recovery hints
- **Security hardening from independent review** — wrapper flag/value
  handling, control-flow keywords, `${IFS}` normalization, command
  substitution and interpreter recursion evaluated; cross-process ledger
  lock; session_id whitelist + hash fallback; ledger input whitelist (content
  stored as sha256, never plaintext); sessions/trace/policy created
  0700/0600; atomic writes preserve file modes; installers refuse to
  overwrite non-reins files; MCP entry ownership checks
- **Acceptance evidence** — real-repo validation
  ([docs/evidence-v0.2.md](docs/evidence-v0.2.md)) and real Claude Code
  session validation ([docs/evidence-agent.md](docs/evidence-agent.md))
- CI: ubuntu (node 20/22/24) + windows-latest + macos-latest + package smoke

## [0.1.0] - 2026-09-06

Initial release.

### Added
- Policy engine: declarative YAML (`allow`/`ask`/`deny`) with combined-short-
  flag expansion, wrapper detection, subcommands, exec-context matching, raw
  regex, dot-aware path globs, first-match-wins ordering
- Tamper-evident JSONL trace (SHA-256 hash chain, refuse-to-append)
- Claude Code adapter + generic `exec` wrapper
- doctor, replay, default policy (13 rules) + bypass-resistance test suite

[0.3.0]: https://github.com/YOUR_USERNAME/reins/releases/tag/v0.3.0
[0.2.0]: https://github.com/YOUR_USERNAME/reins/releases/tag/v0.2.0
[0.1.0]: https://github.com/YOUR_USERNAME/reins/releases/tag/v0.1.0
