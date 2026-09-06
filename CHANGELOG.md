# Changelog

All notable changes to reins are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/); versioning is SemVer.

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
