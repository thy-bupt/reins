# reins

**Hold the reins of your AI coding agent.**

reins is a local, deterministic **verifiable execution evidence layer** for AI
coding agents: deterministic policy decisions *before* a tool call runs, a
tamper-evident event chain *after*, policy replay, and git-linked incident
forensics. It sits *above* sandboxes (Claude Sandbox, OpenShell, bubblewrap) —
they constrain what the agent can touch; reins proves what it asked for, under
which policy, and whether the record itself can be trusted. Agent-agnostic,
local-first, one npm install.

```bash
npm i -g reins
reins init claude
```

That's it. Your Claude Code sessions now run behind a policy gate — restart
the agent session (or run `/hooks`) so it loads the new hook.

## The problem

AI coding agents execute shell commands and write files with your permissions. Three things are missing from the ecosystem:

1. **Hooks fail open.** [anthropics/claude-code#32990](https://github.com/anthropics/claude-code/issues/32990) documented an agent *deleting the very hook script that was blocking it* — and the system then allowed everything. A safety mechanism an agent can switch off is not a safety mechanism.
2. **Sandboxes are heavy.** microVM and cloud sandboxes (E2B, microsandbox, gVisor…) are great for isolating *where* code runs, but they don't give you a readable policy or an audit trail, and nobody installs a virtual machine to run `npm test` more safely.
3. **Nobody keeps the receipts.** When (not if) an agent does something you didn't expect, you want a tamper-evident record of every action it attempted — and a way to answer "would a stricter policy have caught this?"

reins is the lightweight layer between them: policy + audit + replay, in process, no daemon, no VM.

## What it does

- **Policy gate** — a YAML file of `allow / ask / deny` rules. Match on program + flags (with combined-short-flag and wrapper-awareness: `rm -fr`, `sudo rm -rf`, `find -exec rm` all resolve to `rm`), on raw regex (catches `curl … | sh`), or on file-path globs (`.env`, `.ssh/`, `.git/`).
- **Tamper-evident trace** — every decision is appended to a JSONL session file as a SHA-256 hash chain (each record commits to the previous). `reins trace verify` checks the chain; a hook **refuses to append** to a trace whose chain is broken.
- **Fail-closed by default** — a malformed hook payload, an unloadable policy, or a tampered trace blocks instead of allowing. The exact opposite of the failure mode in #32990.
- **Replay** — `reins replay <session> --policy stricter.yaml` re-evaluates a recorded session against a candidate policy and reports what *would* have been blocked. Nothing is executed.
- **Doctor** — `reins doctor` checks policy validity, hook installation, and trace integrity, and tells you when you're running fail-open.
- **MCP server (read-only)** — `reins mcp` exposes `check_command`,
  `recent_decisions`, `policy_summary`, `stats` and `suggest_alternative` to
  the agent itself: it can self-check proposals before hitting the wall,
  review its own denials, and ask for safer alternatives when denied.
  Cooperative by design — the tools are read-only and the hook re-decides at
  execution time.
- **Skills** — `reins init skills` installs two workflow skills:
  `reins-selfcheck` (how to respond to a denial productively) and
  `reins-incident` (how to investigate agent activity with trace + snapshot).
  Advisory only; uninstall cleanly with `reins uninstall skills`.
- **Policy digest binding** — every ledger event records the sha256 of the
  policy it was decided under; in-session policy changes are flagged as drift
  and surfaced by `doctor`. (This is policy *fingerprinting* — signing, so
  that an agent cannot weaken its own policy, is the next milestone.)
- **Operation snapshots** — `reins snapshot` emits a forensic markdown report when you need to look back: hash-chain verdict, policy fingerprint, full decision timeline, the git state of every touched file, and recovery hints (`git restore`, `git reflog`). Works even on tampered traces — evidence preserved, tampering flagged.

## Supported agents

| agent | install | integration | ask rules |
| --- | --- | --- | --- |
| **Claude Code** | `reins init claude` | `PreToolUse` hook in `~/.claude/settings.json` | ✅ shown to the human via the permission flow |
| **Gemini CLI** | `reins init gemini` | `BeforeTool` hook in `~/.gemini/settings.json` | fail closed (deny with reason) |
| **Codex** | `reins init codex` | `~/.codex/hooks.json` + `[features] hooks = true` in `config.toml` | fail closed |
| **Grok Build** | `reins init grok` | hook file in `~/.grok/hooks/` | fail closed |
| **opencode** | `reins init opencode` | plugin in `~/.config/opencode/plugins/` — blocks by throwing | fail closed |
| **pi** | `reins init pi` | extension in `~/.pi/agent/extensions/` — blocks via `{ block: true }` | fail closed |
| **anything else** | `reins exec -- <cmd>` | generic wrapper for scripts, CI, other agents | fail closed |

Two honest notes: Grok Build itself fails open when a hook crashes or times
out ([their docs say so](https://docs.x.ai/build/features/hooks)) — our hook
exits cleanly, but a missing `reins` binary would let Grok proceed, so run
`reins doctor`. And Grok also reads Claude Code's `.claude/settings.json`
natively, so the claude adapter often covers it for free. Every adapter
records to the same tamper-evident ledger, tagged per agent
(`claude-<session>.jsonl`, `grok-<session>.jsonl`, …).

## Example

```console
$ echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /tmp/important"}}' \
    | reins hook claude
[reins] blocked by rule "rm-recursive": Recursive deletion is destructive and hard to undo   (exit 2)

$ reins trace verify
ok: 47 events, hash chain intact — ~/.reins/sessions/claude-3f2a….jsonl

$ reins doctor
 ✓ policy       18 rules, default=allow (~/.reins/policy.yaml)
 ✓ claude-hook  installed in ~/.claude/settings.json
 ✓ traces       1 trace(s) verified, hash chains intact
reins looks healthy.
```

## Writing a policy

`~/.reins/policy.yaml` (installed by `reins init`, editable, hot-reloads on every decision):

```yaml
version: 1
name: my-policy
default: allow          # decision when no rule matches
rules:
  # structured command rule: program + flags (any of), wrapper-aware
  - id: rm-recursive
    kind: command
    action: deny
    program: rm
    flags: ["-r", "-R", "--recursive", "-d", "--dir"]
    reason: "Recursive deletion is destructive and hard to undo"

  # subcommand + flags: git push --force / -f
  - id: git-force-push
    kind: command
    action: deny
    program: git
    subcommand: push
    flags: ["--force", "-f"]
    reason: "Force push rewrites shared history"

  # raw regex against the command string
  - id: pipe-to-shell
    kind: command
    action: deny
    pattern: '\|\s*(ba|z|da)?sh(\s|$)'
    reason: "Piping into a shell executes unreviewed code"

  # file-path glob (dot-aware), matched on file writes/edits
  - id: protect-dotenv
    kind: path
    action: deny
    path: "**/.env*"
    reason: "Secrets file — never let an agent rewrite it"

  # scoped to specific tool names (optional)
  - id: ask-before-clean
    kind: command
    action: ask          # ask = hand the decision back to the human
    program: git
    subcommand: clean
    reason: "git clean deletes untracked files"

  # learned from a real terraform repository: state files carry secrets
  - id: protect-terraform-state
    kind: path
    action: deny
    path: "**/*.tfstate*"
    reason: "Terraform state contains secrets — manage it with terraform, never edit it directly"
```

Rules are evaluated in order; **first match wins**. `ask` shows the agent's request to the human (Claude Code permission flow) in hooks, and is treated as deny in headless `exec` mode.

## CLI reference

| command | what it does |
| --- | --- |
| `reins init <agent>` | installs the policy + hook for an agent — `claude`, `gemini`, `codex`, `grok`, `opencode`, `pi`, or component — `skills`, `mcp` (backs up originals) |
| `reins hook <agent>` | hook entrypoint (agents call this; you normally don't) |
| `reins exec -- <cmd>` | run any command under the policy — works from scripts, CI, other agents |
| `reins trace list` / `trace verify [file]` | list sessions / verify a session's hash chain |
| `reins trace show [file]` | human-readable ledger timeline in your terminal |
| `reins trace export [file]` | schema-v1 evidence export (ndjson / json), secret-redacted by default |
| `reins policy eval "cmd"` / `--file <p>` | dry-run a decision against the policy — never executes |
| `reins doctor` / `--all` / `--agent <name>` | full health check: policy, hook, all agents, traces |
| `reins replay [file] --policy <p>` | re-evaluate a session under another policy, block report |
| `reins snapshot [file] --with-diffs` | forensic report: timeline + git state + recovery hints |
| `reins suggest` | optional LLM: propose policy rules from ledger patterns (docs/LLM.md) |
| `reins ui` | interactive session browser — colored timelines, event drill-in (bare `reins` in a TTY opens it too) |
| `reins explain [file]` | optional LLM: incident narrative from a session snapshot |
| `reins uninstall <agent>` | remove the reins hook cleanly (foreign hooks preserved) |

Configuration: `REINS_HOME` overrides `~/.reins` (sessions + policy live there). `--policy <path>` overrides the policy per invocation.

## Architecture

No daemon, no VM, no watcher. One short-lived process per decision:

```text
┌─────────────────────────────────────────────────────────────┐
│  agent (Claude Code today; anything with hooks or a shell)  │
└──────────────┬──────────────────────────────────────────────┘
               │ PreToolUse hook: JSON on stdin
               ▼
        reins hook claude
               │
               ├── load policy (~/.reins/policy.yaml)
               ├── parse & match ──► allow │ ask │ deny
               │        (shell-quote segmentation, flag expansion,
               │         wrapper/exec-context detection, path globs)
               │
               ├── append decision to sessions/<session>.jsonl
               │        (SHA-256 hash chain — every record commits
               │         to the previous one; a broken chain makes
               │         the hook refuse to append: fail closed)
               │
               └── respond
                        allow → exit 0
                        ask   → exit 0 + permissionDecision JSON
                        deny  → exit 2 + reason on stderr
                                 (fed back to the agent)
```

`reins exec` uses the same engine from scripts and CI; `reins replay` reads the ledger back and re-runs *decisions only* (never commands) under a candidate policy.

## Performance

One decision = one cold Node process: **~40 ms per tool call** on Apple Silicon (measured with the default 18-rule policy, including Node startup, policy load, matching, and trace append). For comparison, the shell command being vetted usually takes an order of magnitude longer.

## Design grounding

reins' core choices line up with the emerging agent-security literature:
security by **system design rather than model behavior** ([CaMeL,
arXiv:2503.18813](https://arxiv.org/abs/2503.18813) — the deterministic gate;
the LLM is never the enforcement layer), a guardrail **between the agent and
its tools** ([GuardAgent, arXiv:2406.09187](https://arxiv.org/abs/2406.09187)),
and tamper-evidence for everything the agent attempted — the gap that
[AgentDojo](https://arxiv.org/abs/2406.13352)-style benchmarks leave open.
Validated end-to-end on a real repository
([evidence](docs/evidence-v0.2.md)) **and on a real agent session**: Claude Code
running with `--dangerously-skip-permissions` in a cloned express repo — the
agent's `rm -rf` was denied by the hook, the command never executed, and when
the agent later *claimed* a denial that never happened, the ledger exposed the
fabrication ([agent evidence](docs/evidence-agent.md)).

## Honest limitations

Read this before trusting your machine to any tool, including this one:

- **reins is not an OS sandbox.** It's a policy and audit layer. The parser covers wrapper flags (`sudo -u`, `env --`, `xargs -0`), control-flow keywords, `${IFS}` obfuscation, command substitution (`$(…)`, backticks) and interpreter recursion (`bash -c "…"`), but a sufficiently creative agent may still find shapes it doesn't classify. For hard isolation, pair it with bubblewrap/Seatbelt, a microVM (microsandbox), or [Claude Code sandboxing](https://code.claude.com/docs/en/hooks#sandboxing) — they're complements, not substitutes.
- **Command parsing is heuristic.** It handles combined short flags, wrapper binaries (`sudo`, `env`, `xargs`…), absolute program paths, subcommands, and embedded `-exec`-style execution. It does not attempt full shell semantics. The bypass test suite in `test/decider.test.ts` is the contract — PRs that add bypass cases are the most valuable contributions.
- **The trace is tamper-*evident*, not tamper-*proof*.** An agent (or anything) with filesystem write access to `~/.reins/sessions` can delete the whole file — the hash chain proves *modification*, not *deletion*. Restrict permissions or ship traces off-box for high-stakes use.
- **The policy itself is not signed yet.** An agent that can write to `~/.reins/policy.yaml` can weaken it before doing the thing you wanted to forbid. Policy integrity verification is the top roadmap item; until then, keep `~/.reins` writable only by you and let `reins doctor` be part of your routine.
- **Windows is supported** (validated on real Windows hardware and a `windows-latest` CI job). The process layer hosts commands in `cmd.exe` by default. The interpreter is deliberately not selectable — environment or caller overrides would let the checked string and the executed content diverge (finding H1 in the security audit). Hook payloads come from each agent's Windows build (Codex additionally supports per-OS `commandWindows` overrides).

## How it compares

The "make agents safer" niche got crowded in 2025–2026, and that's good. Here is where reins stands, honestly, against the projects you'll actually cross-shop (data as of 2026-09):

| | **reins** | [cc-safety-net](https://github.com/kenryu42/cc-safety-net) (1.5k★) | [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing) (official) | [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) (8.5k★) | [agent-replay](https://github.com/clay-good/agent-replay) (13★) |
| --- | --- | --- | --- | --- | --- |
| What it is | policy gate + tamper-evident ledger + replay | pre-execution command guard | OS-level fs/network sandbox (Seatbelt/bubblewrap) | container runtime with YAML policy (fs/network/process/credentials) | time-travel debugging of agent runs |
| Policy file | YAML, hot-reloads | presets + JSON rulebooks + web GUI | sandbox settings | YAML, dynamic parts hot-reload | — |
| Decision ledger | every decision, JSONL | denial log | — | — | full traces (SQLite) |
| Tamper evidence | hash chain, refuses to append to a broken one | — | — | — | — |
| Replay under a new policy | ✅ policy-diff report | — | — | — | debug-focused replay/fork |
| Fail-closed core | ✅ by design (errors/tamper block; unmatched follows policy default) | Standard mode is allow-leaning; Strict/Paranoid are conservative | n/a | sandboxed | — |
| Agent coverage | **6 adapters + generic `exec`** | **13 CLIs** | Claude Code only | agents it hosts | tracing lib, agent-agnostic |
| OS-level enforcement | ❌ (heuristic parser) | ❌ (same approach) | ✅ | ✅ (Landlock) | — |
| Weight | npm, no daemon, ~40 ms/call | npm, no daemon | built-in | Rust + containers | npm |

**Where the others lead:** cc-safety-net has far broader agent coverage, a GUI, secret-access blocking that spans read tools, and a real community — for pure "stop the dangerous command" on many agents, it's the established choice. OpenShell and native sandboxing enforce at the kernel level, which no userspace parser can match. agent-replay is the better debugging UX today.

**Where reins is different:** it's the only one of these whose ledger is *verifiable* (hash-chained, refuses to continue a tampered file), the one that pairs a policy gate with *replay under a candidate policy* and
binds every verdict to a policy digest (with in-session drift detection).
cc-safety-net's Strict/Paranoid presets close much of the fail-closed gap —
reins' differentiation is the **verifiable ledger + replay + evidence export**,
not a claim of being the only fail-closed hook. Those three properties compose into something none of the others offer end-to-end: **evidence you can trust about what an agent tried to do** — which is what you need for incident review, compliance, and deciding whether to tighten a policy. It also runs alongside all of the above rather than instead of them: sandbox where you can, guard where you must, ledger either way.

## Roadmap

- [x] Codex, Gemini CLI, Grok Build, opencode and pi adapters (v0.1)
- [ ] **Policy integrity** — sign `policy.yaml` (hash anchored in the ledger) so a rogue agent can't weaken its own guard
- [ ] More agents: Cursor, Aider, Windsurf …
- [ ] Secret-leak detection rules (deny reads/writes that move credential material into commands)
- [x] TUI-flavored interactive session browser (v0.4)
- [x] MCP server exposing trace queries to agents (`reins mcp`, v0.2)
- [ ] Policy registry: shareable preset policies per stack

## FAQ

**Another hook tool already exists (cc-safety-net). Why this one?**
Use both if you like — they compose. cc-safety-net is broader in agent coverage and friendlier out of the box. reins's reason to exist is the part none of the hook packs offer: a ledger whose integrity you can *verify*, fail-closed semantics when things break, and replaying a real session against a stricter policy before you adopt it.

**Why not just use Claude Code's built-in sandboxing?**
You should — they solve different problems and stack cleanly. The sandbox constrains *where code runs* (filesystem/network at the OS level). reins adds a portable policy with human-readable reasons, a decision ledger that survives tampering, and replay — none of which the sandbox provides, and none of which follow you when you switch agents.

**Does it slow my agent down?**
~40 ms per tool call (measured, see Performance). The commands being vetted usually cost more than that.

**Is the trace a keylogger?**
No. It records tool name, tool input, the decision, and the reason — no command output, no file contents, no prompts. It stays in `~/.reins/sessions/` on your machine.

**What stops the agent from editing `policy.yaml` or its own trace?**
Tampering with the trace is detected (hash chain) and blocks further logging — that's the fail-closed guarantee. Weakening `policy.yaml` is *not* yet prevented; that's the top roadmap item. Until then, treat `~/.reins` permissions as part of your setup and run `reins doctor` occasionally.

**Windows?**
Yes — tested on real Windows hardware and a `windows-latest` CI job. `reins exec` hosts commands in `cmd.exe` on Windows (interpreter is deliberately not env-selectable — see H1 note in the security audit).

**Does it have a GUI?**
It has an interactive terminal browser: run bare `reins` or `reins ui` in a real terminal for a bilingual (English/中文) session browser — colored decision timelines, event drill-in, and in-place chain verification. First run asks for your language. Non-TTY stdout and `NO_COLOR` degrade to plain output automatically.

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The bypass test suite is the heart of this project: if you find a command that slips past a policy that should have caught it, open an issue with the command and we'll make it a test case.

## License

[Apache-2.0](LICENSE)
