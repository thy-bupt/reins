---
name: reins-incident
description: Use when the user asks what an AI agent did, wants an audit of agent activity, or reports something suspicious after an agent session — produce a trace timeline and a forensic snapshot with recovery guidance.
---

# Investigating agent activity with reins

When the user asks "what did the agent do?", "audit the last session", or
reports something odd after an agent run, use these read-only steps.

## 1. Find the session

```bash
reins trace list          # newest first; filenames are <agent>-<session>.jsonl
```

## 2. Show the timeline

```bash
reins trace show                       # newest session
reins trace show ~/.reins/sessions/<file>.jsonl
```

The first line states whether the hash chain is **OK** or **TAMPERED**. A
TAMPERED verdict is a serious finding — report it to the user immediately and
do not trust events after the broken point.

## 3. Produce the forensic snapshot

```bash
reins snapshot ~/.reins/sessions/<file>.jsonl --with-diffs
```

This writes a self-contained markdown report: integrity verdict, policy
fingerprint (sha256), the full decision timeline, the git state of every
touched file (diffs included), and **recovery hints** — `git restore -- <path>`
for modified files, `git reflog` for history rewrites.

## 4. Summarize for the user, in this order

1. Verdict: chain intact or tampered.
2. What was **blocked** (with the rules that fired) — these are the wins.
3. What was **allowed and executed** — anything destructive or touching
   secrets deserves a sentence each.
4. Recovery actions available right now (from the snapshot hints), clearly
   labeled as "verify before running".

## Rules

- Everything here is read-only — never "fix" state unless the user asks.
- If the snapshot reports TAMPERED, say so first; an agent editing its own
  ledger is itself the incident.
- Sessions live in `~/.reins/sessions/` and stay on this machine.
