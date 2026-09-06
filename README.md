# railguard

**A fail-closed safety rail for AI coding agents.** Declarative policy engine, tamper-evident trace, session replay. Agent-agnostic, local-first, one npm install.

```bash
npm i -g railguard
railguard init claude
```

That's it. Your Claude Code sessions now run behind a policy gate.

## The problem

AI coding agents execute shell commands and write files with your permissions. Three things are missing from the ecosystem:

1. **Hooks fail open.** [anthropics/claude-code#32990](https://github.com/anthropics/claude-code/issues/32990) documented an agent *deleting the very hook script that was blocking it* — and the system then allowed everything. A safety mechanism an agent can switch off is not a safety mechanism.
2. **Sandboxes are heavy.** microVM and cloud sandboxes (E2B, microsandbox, gVisor…) are great for isolating *where* code runs, but they don't give you a readable policy or an audit trail, and nobody installs a virtual machine to run `npm test` more safely.
3. **Nobody keeps the receipts.** When (not if) an agent does something you didn't expect, you want a tamper-evident record of every action it attempted — and a way to answer "would a stricter policy have caught this?"

railguard is the lightweight layer between them: policy + audit + replay, in process, no daemon, no VM.

## What it does

- **Policy gate** — a YAML file of `allow / ask / deny` rules. Match on program + flags (with combined-short-flag and wrapper-awareness: `rm -fr`, `sudo rm -rf`, `find -exec rm` all resolve to `rm`), on raw regex (catches `curl … | sh`), or on file-path globs (`.env`, `.ssh/`, `.git/`).
- **Tamper-evident trace** — every decision is appended to a JSONL session file as a SHA-256 hash chain (each record commits to the previous). `railguard trace verify` checks the chain; a hook **refuses to append** to a trace whose chain is broken.
- **Fail-closed by default** — a malformed hook payload, an unloadable policy, or a tampered trace blocks instead of allowing. The exact opposite of the failure mode in #32990.
- **Replay** — `railguard replay <session> --policy stricter.yaml` re-evaluates a recorded session against a candidate policy and reports what *would* have been blocked. Nothing is executed.
- **Doctor** — `railguard doctor` checks policy validity, hook installation, and trace integrity, and tells you when you're running fail-open.

Works with any agent that has hooks or a shell: first-class [Claude Code](https://code.claude.com/docs/en/hooks) support today; the generic `railguard exec` wrapper works with everything else.

## Example

```console
$ echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /tmp/important"}}' \
    | railguard hook claude
[railguard] blocked by rule "rm-recursive": Recursive deletion is destructive and hard to undo   (exit 2)

$ railguard trace verify
ok: 47 events, hash chain intact — ~/.railguard/sessions/claude-3f2a….jsonl

$ railguard doctor
 ✓ policy       13 rules, default=allow (~/.railguard/policy.yaml)
 ✓ claude-hook  installed in ~/.claude/settings.json
 ✓ traces       1 trace(s) verified, hash chains intact
railguard looks healthy.
```

## Writing a policy

`~/.railguard/policy.yaml` (installed by `railguard init`, editable, hot-reloads on every decision):

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
```

Rules are evaluated in order; **first match wins**. `ask` shows the agent's request to the human (Claude Code permission flow) in hooks, and is treated as deny in headless `exec` mode.

## CLI reference

| command | what it does |
| --- | --- |
| `railguard init claude` | installs the policy + PreToolUse hook into `~/.claude/settings.json` (backs up the original) |
| `railguard hook claude` | hook entrypoint (Claude Code calls this; you normally don't) |
| `railguard exec -- <cmd>` | run any command under the policy — works from scripts, CI, other agents |
| `railguard trace list` / `trace verify [file]` | list sessions / verify a session's hash chain |
| `railguard doctor` | full health check: policy, hook, traces |
| `railguard replay [file] --policy <p>` | re-evaluate a session under another policy, block report |

Configuration: `RAILGUARD_HOME` overrides `~/.railguard` (sessions + policy live there). `--policy <path>` overrides the policy per invocation.

## Architecture

No daemon, no VM, no watcher. One short-lived process per decision:

```text
┌─────────────────────────────────────────────────────────────┐
│  agent (Claude Code today; anything with hooks or a shell)  │
└──────────────┬──────────────────────────────────────────────┘
               │ PreToolUse hook: JSON on stdin
               ▼
        railguard hook claude
               │
               ├── load policy (~/.railguard/policy.yaml)
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

`railguard exec` uses the same engine from scripts and CI; `railguard replay` reads the ledger back and re-runs *decisions only* (never commands) under a candidate policy.

## Performance

One decision = one cold Node process: **~40 ms per tool call** on Apple Silicon (measured with the default 13-rule policy, including Node startup, policy load, matching, and trace append). For comparison, the shell command being vetted usually takes an order of magnitude longer.

## Honest limitations

Read this before trusting your machine to any tool, including this one:

- **railguard is not an OS sandbox.** It's a policy and audit layer. A sufficiently creative agent may find command shapes the parser doesn't classify. For hard isolation, pair it with bubblewrap/Seatbelt, a microVM (microsandbox), or [Claude Code sandboxing](https://code.claude.com/docs/en/hooks#sandboxing) — they're complements, not substitutes.
- **Command parsing is heuristic.** It handles combined short flags, wrapper binaries (`sudo`, `env`, `xargs`…), absolute program paths, subcommands, and embedded `-exec`-style execution. It does not attempt full shell semantics. The bypass test suite in `test/decider.test.ts` is the contract — PRs that add bypass cases are the most valuable contributions.
- **The trace is tamper-*evident*, not tamper-*proof*.** An agent (or anything) with filesystem write access to `~/.railguard/sessions` can delete the whole file — the hash chain proves *modification*, not *deletion*. Restrict permissions or ship traces off-box for high-stakes use.
- **The policy itself is not signed yet.** An agent that can write to `~/.railguard/policy.yaml` can weaken it before doing the thing you wanted to forbid. Policy integrity verification is the top roadmap item; until then, keep `~/.railguard` writable only by you and let `railguard doctor` be part of your routine.
- macOS and Linux only for now.

## How it compares

The "make agents safer" niche got crowded in 2025–2026, and that's good. Here is where railguard stands, honestly, against the projects you'll actually cross-shop (data as of 2026-09):

| | **railguard** | [cc-safety-net](https://github.com/kenryu42/cc-safety-net) (1.5k★) | [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing) (official) | [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) (8.5k★) | [agent-replay](https://github.com/clay-good/agent-replay) (13★) |
| --- | --- | --- | --- | --- | --- |
| What it is | policy gate + tamper-evident ledger + replay | pre-execution command guard | OS-level fs/network sandbox (Seatbelt/bubblewrap) | container runtime with YAML policy (fs/network/process/credentials) | time-travel debugging of agent runs |
| Policy file | YAML, hot-reloads | presets + JSON rulebooks + web GUI | sandbox settings | YAML, dynamic parts hot-reload | — |
| Decision ledger | every decision, JSONL | denial log | — | — | full traces (SQLite) |
| Tamper evidence | hash chain, refuses to append to a broken one | — | — | — | — |
| Replay under a new policy | ✅ policy-diff report | — | — | — | debug-focused replay/fork |
| Fail-closed core | ✅ by design | ❌ fail-open in Standard mode (Strict/Paranoid flips it) | n/a | sandboxed | — |
| Agent coverage | Claude Code adapter + generic `exec` | **13 CLIs** | Claude Code only | agents it hosts | tracing lib, agent-agnostic |
| OS-level enforcement | ❌ (heuristic parser) | ❌ (same approach) | ✅ | ✅ (Landlock) | — |
| Weight | npm, no daemon, ~40 ms/call | npm, no daemon | built-in | Rust + containers | npm |

**Where the others lead:** cc-safety-net has far broader agent coverage, a GUI, secret-access blocking that spans read tools, and a real community — for pure "stop the dangerous command" on many agents, it's the established choice. OpenShell and native sandboxing enforce at the kernel level, which no userspace parser can match. agent-replay is the better debugging UX today.

**Where railguard is different:** it's the only one of these whose ledger is *verifiable* (hash-chained, refuses to continue a tampered file), the only one that pairs a policy gate with *replay under a candidate policy*, and the only one whose core answer to "what if the guard breaks" is *block*, not *allow*. Those three properties compose into something none of the others offer end-to-end: **evidence you can trust about what an agent tried to do** — which is what you need for incident review, compliance, and deciding whether to tighten a policy. It also runs alongside all of the above rather than instead of them: sandbox where you can, guard where you must, ledger either way.

## Roadmap

- [ ] **Policy integrity** — sign `policy.yaml` (hash anchored in the ledger) so a rogue agent can't weaken its own guard
- [ ] Codex CLI / Gemini CLI / opencode adapters (good first issues!)
- [ ] Secret-leak detection rules (deny reads/writes that move credential material into commands)
- [ ] TUI session viewer
- [ ] MCP server exposing trace queries to agents
- [ ] Policy registry: shareable preset policies per stack

## FAQ

**Another hook tool already exists (cc-safety-net). Why this one?**
Use both if you like — they compose. cc-safety-net is broader in agent coverage and friendlier out of the box. railguard's reason to exist is the part none of the hook packs offer: a ledger whose integrity you can *verify*, fail-closed semantics when things break, and replaying a real session against a stricter policy before you adopt it.

**Why not just use Claude Code's built-in sandboxing?**
You should — they solve different problems and stack cleanly. The sandbox constrains *where code runs* (filesystem/network at the OS level). railguard adds a portable policy with human-readable reasons, a decision ledger that survives tampering, and replay — none of which the sandbox provides, and none of which follow you when you switch agents.

**Does it slow my agent down?**
~40 ms per tool call (measured, see Performance). The commands being vetted usually cost more than that.

**Is the trace a keylogger?**
No. It records tool name, tool input, the decision, and the reason — no command output, no file contents, no prompts. It stays in `~/.railguard/sessions/` on your machine.

**What stops the agent from editing `policy.yaml` or its own trace?**
Tampering with the trace is detected (hash chain) and blocks further logging — that's the fail-closed guarantee. Weakening `policy.yaml` is *not* yet prevented; that's the top roadmap item. Until then, treat `~/.railguard` permissions as part of your setup and run `railguard doctor` occasionally.

**Windows?**
Not yet — the runner assumes a POSIX shell.

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The bypass test suite is the heart of this project: if you find a command that slips past a policy that should have caught it, open an issue with the command and we'll make it a test case.

## License

[Apache-2.0](LICENSE)
