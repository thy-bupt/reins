# Contributing to railguard

Thanks for helping make AI agents safer. A few things to know before you open a PR.

## Setup

```bash
git clone <your fork>
cd railguard
pnpm install
pnpm check   # lint + build + test — everything must pass
```

## How we work

- **Tests first.** Every behavior change lands with a test that failed before it. This repo is built strictly test-first and we'd like to keep it that way.
- **The bypass suite is the contract.** `test/decider.test.ts` contains the known bypass attempts (`rm -fr`, `sudo rm`, `find -exec`, multi-line, pipe-separated…) and the false positives we refuse to flag (`echo "rm -rf /"` must stay innocent). If you find a command that slips past a policy that should have caught it:
  1. Open an issue with the exact command string.
  2. We turn it into a failing test, then fix the matcher.
  Contributions that add bypass cases (even failing ones, marked `it.fails`) are gold.

## Good first issues

- **Agent adapters.** `src/adapters/` is deliberately small. Codex CLI, Gemini CLI, opencode, Aider… each adapter is a payload normalizer + an output encoder, with the core engine untouched. Copy the shape of `adapters/claude/`.
- **Default policy presets.** The shipped `policies/default.yaml` is intentionally conservative. Presets for specific stacks (web dev, data science, infra/terraform) are welcome — each as its own file in `policies/` with tests that its deny rules don't fire on the stack's normal workflow.
- **Docs.** Non-English READMEs and real-world policy examples.

## Ground rules

- No new runtime dependencies without discussion (the whole point is a small, auditable tool).
- No network calls in the core — everything stays local.
- Apache-2.0; your contribution is licensed under the same.

## Commit style

Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
