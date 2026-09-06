---
name: reins-selfcheck
description: Use when a reins policy block denies one of your tool calls — how to read the denial, find an allowed alternative, and propose a safer approach instead of retrying the same command.
---

# Handling a reins policy denial

You are working under **reins**, a fail-closed safety layer. When a tool call
is denied, the command **did not run**. Retrying the identical command will
fail identically — treat every denial as a hard boundary, not an obstacle.

## When a call is denied

1. **Read the reason.** Denials arrive as
   `[reins] blocked by rule "<rule-id>": <reason>`. The rule id tells you which
   boundary you hit; the reason tells you why it exists.
2. **Dry-run alternatives before proposing them** (never executes anything):

   ```bash
   reins policy eval "<your alternative command>"
   ```

   Exit code 0 = the policy allows it. Exit code 2 = still denied, with the
   rule that fired.
3. **Prefer the least destructive allowed path.** Examples:
   - `rm -rf` denied → target a narrower path (`rm <file>`, `rm -r <subdir>`
     may still be denied — check with `policy eval`), or ask the human to
     remove it.
   - `.env` writes/reads denied → never move secrets into commands or other
     files; ask the human for the value out-of-band if truly needed.
   - `git push --force` denied → propose `git push --force-with-lease` (an
     `ask` rule — the human decides), or a new branch.
4. **Tell the user what was blocked and what you propose instead.** A denial
   is information the human wants to see, not noise to work around.

## Never do this

- Never try to disable, edit, or delete reins itself
  (`~/.reins/`, the hook entries, the `reins` binary). That is the one
  pattern the system is explicitly built to catch, and it is a serious trust
  violation.
- Never encode a denied operation into another form (base64, heredoc into a
  file, piping into a shell) to slip it past matching. The ledger records
  attempts and the hash chain is verifiable.

## Self-service queries (optional, read-only)

If a `reins` MCP server is connected you can also call `check_command` to
dry-run a command and `recent_decisions` to review your recent denials. These
are conveniences — the hook decides regardless of what the MCP server says.
