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

## Honest limitations

Read this before trusting your machine to any tool, including this one:

- **railguard is not an OS sandbox.** It's a policy and audit layer. A sufficiently creative agent may find command shapes the parser doesn't classify. For hard isolation, pair it with bubblewrap/Seatbelt, a microVM (microsandbox), or [Claude Code sandboxing](https://code.claude.com/docs/en/hooks#sandboxing) — they're complements, not substitutes.
- **Command parsing is heuristic.** It handles combined short flags, wrapper binaries (`sudo`, `env`, `xargs`…), absolute program paths, subcommands, and embedded `-exec`-style execution. It does not attempt full shell semantics. The bypass test suite in `test/decider.test.ts` is the contract — PRs that add bypass cases are the most valuable contributions.
- **The trace is tamper-*evident*, not tamper-*proof*.** An agent (or anything) with filesystem write access to `~/.railguard/sessions` can delete the whole file — the hash chain proves *modification*, not *deletion*. Restrict permissions or ship traces off-box for high-stakes use.
- macOS and Linux only for now.

## Roadmap

- [ ] Codex CLI / Gemini CLI / opencode adapters (good first issues!)
- [ ] TUI session viewer
- [ ] MCP server exposing trace queries to agents
- [ ] Policy registry: shareable preset policies per stack

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The bypass test suite is the heart of this project: if you find a command that slips past a policy that should have caught it, open an issue with the command and we'll make it a test case.

## License

[Apache-2.0](LICENSE)
