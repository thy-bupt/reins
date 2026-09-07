# reins 安全性测试报告（2026-09-07）

- 目标：reins v0.3.2 @ commit `50a7500`（工作区无未提交代码变更）
- 方法：mimosa 深度静态扫描（scanId `scan-2026-09-07T15-30-20.497Z-5ecb0b6be976`）+ 针对 Codex 集成攻击面的手工动态测试（隔离 `REINS_HOME`）
- 基线：`pnpm test` 292 项全部通过

## 结论

Codex 相关核心防御全部有效；发现 **1 个已 PoC 确认的策略旁路**（`REINS_SHELL` 环境变量），建议修复。

## 已验证有效的防御（动态测试通过）

| 测试 | 结果 |
| --- | --- |
| session_id 路径遍历/注入（10 例：`../..`、绝对路径、`.hidden`、`sub/dir`、200 字符、tab、UUID 合法值等）经 `reins hook codex` | ✅ 全部净化：非法 id 哈希替换，账本只落在 `sessions/` 内，目录 0700、文件 0600 |
| 恶意命令经 codex 通道（`rm -rf …`） | ✅ 被 `rm-recursive` 规则拦截，exit 2，账本留痕 |
| 畸形 hook 载荷（非 JSON） | ✅ fail-closed，exit 2 |
| 账本被篡改后再次 hook | ✅ 拒绝追加（hash mismatch at event 2），exit 2 |
| `sessions/` 被替换为指向外部的符号链接 | ✅ 拒绝执行，外部目录无文件落盘 |
| `reins init codex` 对真实 `config.toml` 副本的行手术 | ✅ 非插入行字节级不变、权限 0600 保持、生成 `.reins-backup`、幂等；`hooks = false` 正确翻转为 `true` |
| 已有合法 `hooks.json` 含第三方 hook 条目 | ✅ merge 保留外来 PreToolUse/PostToolUse 条目 |

## 发现

### H1（高危，已 PoC）：`REINS_SHELL` 环境变量旁路策略门

`src/core/runner.ts:47`（`opts.shell ?? process.env.REINS_SHELL`）→ `src/core/matchers.ts:202-208`：`reins exec` 先对命令**字符串**做策略判定，再把字符串交给 `REINS_SHELL` 指定的可执行文件 spawn。调用方（`reins exec` 的定位就是"给脚本/CI/其他 agent 用"，即不可信方可以发起）同时控制命令文本与环境变量时，策略形同虚设。

PoC 复现：`REINS_SHELL=/tmp/fake-shell.sh reins exec -- "echo totally-harmless"` → 账本记录 `echo totally-harmless → allow ok`，实际执行的是攻击者二进制（argv 完全被忽略）。

建议修复（任选其一或组合）：
1. 移除 `REINS_SHELL`，或仅允许白名单内的绝对路径解释器（`/bin/sh`、`/bin/bash`…）；
2. 不可信上下文（hook/exec 入口）忽略该环境变量；
3. `doctor` 增加检查项：当前环境存在 `REINS_SHELL` 时告警。

Windows 路径的 `ComSpec`（`matchers.ts:211`）同属一类，建议一并处理。

### H2（误报，设计使然）：`runner.ts:53` spawn 参数数组来自外部输入（CWE-88）

`reins exec -- <cmd>` 的文档定位就是执行调用方提供的命令，策略在执行前判定并留痕——这不构成注入。但注意其安全前提依赖 H1 修复（被检查的字符串与最终解释执行的内容必须一致）。

### L1（低）：损坏的 `~/.codex/hooks.json` 在 init 时被整体重建

`codexHooksFileContent` 对不可解析的既有内容从 `{}` 起步，第三方条目会丢失；有 `.reins-backup` 兜底，可恢复，但建议 doctor 在此场景下提示用户检查备份。

## 环境侧记录（非代码缺陷）

- `~/.codex/config.toml` 含明文 `experimental_bearer_token`（权限 0600 正确）；测试期间该值曾进入本会话日志，如日志外传建议轮换。
- 本机 `~/.codex/hooks.json` 不存在，Codex 集成未启用。
- mimosa 扫描 coverage 为 `partial/inconclusive`（调用图动态派发覆盖不全），findings 已人工逐条核实。

## 测试痕迹清理

所有临时 `REINS_HOME`、含 token 的 config 副本、PoC 文件均已删除。

---

# 第二轮：真实应用场景测试（2026-09-08）

- 方法：真实 agent 端到端（真装 hook → 真跑 agent → 真账本取证），全部操作在真实 `~/.reins`、`~/.claude`、`~/.codex` 上进行，测后已精确还原（settings md5 一致；codex config 仅余 Codex 自己写入的 trust 记录）。

## 通过项（真实场景）

| 场景 | 结果 |
| --- | --- |
| 真实 Claude Code headless（`claude -p`）良性命令：`echo` | ✅ hook 触发 → allow 落账 → 命令执行、输出正确 |
| 真实 Claude Code 恶意命令：`rm -rf`（agent 权限层已预批准 Bash） | ✅ reins 仍然拦截，agent 收到 `rm-recursive` 拒绝原因，canary 文件幸存 |
| 真实 Claude Code ask 规则：`git reset --hard` | ✅ 账本记 `ask`，headless 权限提示无法应答即不执行——allow/deny/ask 三态全在真实 agent 上验证 |
| 并发 hook 竞态：8 进程同写同一账本 | ✅ 无分叉、链完整；实现依据：`withFileLock` 下重读全链再追加（`trace.ts:222`） |
| 真实账本取证链路 | ✅ `trace verify`（6/6 链完好）、`snapshot`（真实 deny 事件出完整取证报告）、`replay --policy`（strict 策略正确预判 `allow → deny`）、`trace export`（evidence/v1）、`mcp`（5 个只读工具、deny/allow 预览、stats 0 篡改） |
| 隐私契约（真实账本 5 个文件全扫） | ✅ input 键仅白名单（command/cwd/file_path/哈希/长度），无密钥模式命中 |

## 环境受阻项

- **真实 Codex 端到端未完成**：Codex 上游中继持续过载（`Reconnecting 1-5/5`，20 分钟内 3 次重试）。hook 已配置并被 `reins doctor` 识别（`agent:codex installed`），链路本身依赖 Codex 实际执行工具调用才能端到端验证。待上游恢复后重跑 `reins init codex` + 一次 `codex exec` 即可补测。

## 第二轮新发现（低危/UX）

1. `reins replay <name>` 只接受**路径**不接受会话名（README 写作 `replay <session>`），且文件不存在时报裸堆栈（fail-closed 但不友好）。`snapshot` 同理需确认参数语义。
2. `node dist/mcp/server.js` 直接运行会静默 exit 0（它是库模块，无自调用入口）——真实入口是 `reins mcp`。建议加"请通过 reins mcp 启动"的显式提示。
3. 残余风险提示（非 reins 缺陷）：host 对 hook 超时的语义由 agent 决定——Claude Code 对 hook 超时/崩溃的 fail-open 行为意味着账本完整性依赖 `reins doctor` 的定期检查。

## 环境侧记录（非代码缺陷）

- `~/.claude/settings.json` 含明文 `ANTHROPIC_AUTH_TOKEN`（与本报告上轮提到的 `~/.codex/config.toml` bearer token 同类）；两者均曾进入本会话日志，如日志外传建议一并轮换。
- 测试期间新增的 3 个真实 claude 账本会话保留在 `~/.reins/sessions/`（审计记录，不应删除）。
- 测试后状态：`~/.claude/settings.json`、`~/.codex/config.toml`、`~/.codex/hooks.json` 均已还原至测试前；`reins doctor` 回到基线（无 agent 挂钩，与测试前一致）。
