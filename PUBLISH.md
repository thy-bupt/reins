# Publishing reins — step-by-step

Current release: **v0.10.1** (tag + npm artifact refer to the same commit).
This checklist took the project from clone to public launch; steps already
done are marked ✅. Steps marked 🔒 need your accounts.

## 1. Create the GitHub repository ✅ (live at github.com/thy-bupt/reins)

```bash
cd reins
gh auth status                      # 🔒 make sure you're logged in
gh repo create reins --public --source=. --push \
  --description "Fail-closed safety rail for AI coding agents: policy engine, tamper-evident trace, session replay."
```

Then on github.com → repo Settings:
- **Topics**: `ai-agents`, `ai-security`, `claude-code`, `developer-tools`, `llm`, `policy-engine`, `audit`, `sandbox`
- **About** description: same as above; website can point to the README anchor later

## 2. CI should go green on the first push

The workflow (`.github/workflows/ci.yml`) runs lint + build + tests on Node
20/22/24. No secrets needed.

## 3. Publish to npm

```bash
npm login                           # 🔒
npm publish --access public         # package name "reins" was verified available
git tag vX.Y.Z && git push origin vX.Y.Z   # tag the exact release commit first
```

## 4. Drop the placeholders

- `CHANGELOG.md` link at the bottom: `thy-bupt` → your GitHub username
- Optional badges for the top of `README.md` (paste after publishing):

```markdown
[![CI](https://github.com/thy-bupt/reins/actions/workflows/ci.yml/badge.svg)](https://github.com/thy-bupt/reins/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/reins)](https://www.npmjs.com/package/reins)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
```

## 5. Open the "good first issues"

Paste these as issues so first-time contributors have concrete targets:

1. **Adapters: Cursor / Aider / Windsurf** — same shape as the six shipped
   adapters (`src/adapters/`): payload normalizer + installer + protocol tests.
2. **Secret-leak detection rules** — deny rules that catch credential
   material being moved into command arguments; add cases to the bypass suite.
3. **Policy presets** — `policies/web-dev.yaml`, `policies/data-science.yaml`,
   `policies/infra.yaml` with tests proving normal workflows pass.
4. **Policy signing** — hash-anchor `policy.yaml` in the ledger so a rogue
   agent can't weaken its own guard (top roadmap item).

## 6. Launch posts

**Show HN:**
> Show HN: Reins – a fail-closed safety rail for AI coding agents
>
> An agent recently deleted the very hook that was blocking it, and the
> system then allowed everything (anthropics/claude-code#32990). Reins
> is a small npm tool that sits in the hook path of coding agents: a YAML
> policy gate (allow/ask/deny), a tamper-evident decision ledger (SHA-256
> hash chain — a broken chain blocks further logging), and replay, which
> re-scores a recorded session under a candidate policy without executing
> anything. ~40 ms per decision, no daemon. It's the audit/replay layer to
> pair with OS sandboxes, not a replacement for them. Repo + honest
> limitations in the README.

**r/ClaudeAI:** lead with the #32990 story + a 15-second `init` demo; mention
it composes with native sandboxing.

**中文社区（V2EX / 掘金）:** 用 `README.zh-CN.md` 的“为什么需要它”一节开头，
强调 fail-open vs fail-closed 的区别和防篡改账本；标题建议：
「给 AI 编码 Agent 上护栏：策略引擎 + 防篡改账本 + 会话回放（开源）」

## 7. After launch

- Watch the bypass test suite: every "here's a command that slipped past"
  issue becomes a test case (see CONTRIBUTING.md).
- Cut the next minor when the first new adapter lands.
