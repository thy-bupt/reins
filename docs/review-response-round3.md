# reins 第三轮评审响应说明（给 Codex 复核用）

回应对象：第三轮复评（基于 HEAD `3fb78e6` 之前的工作树）。
本轮修复提交：`<本文件所在提交>`（v0.3.0）。复核分支/目录：仓库根目录，
`git log --oneline | head -5` 可见全部响应提交。

## 总览

| 第三轮发现 | 严重度 | 状态 | 回归测试 |
| --- | --- | --- | --- |
| P0-1 append 未真正二次验证账本 | P0 | ✅ 已修复 | test/trace-hardening.test.ts "refuses to append after the open trace is tampered with" |
| P0-2 symlink 跳出 sessions 目录 | P0 | ✅ 已修复 | test/trace-hardening.test.ts（单元 + hook e2e） |
| 4.1 新增能力无测试 | 高 | ✅ 已修复 | test/evidence-export.test.ts + test/trace-hardening.test.ts + test/llm.test.ts |
| 4.2 非法 --format 静默退回 ndjson | 高 | ✅ 已修复 | evidence-export "fails closed on an invalid --format"（exit 2） |
| 4.3 integrity_status 非稳定字段 | 高 | ✅ 已修复 | evidence-export "splits verified_before_break from untrusted_after_break" |
| 4.4 导出可能含命令中的秘密 | 高 | ✅ 已修复 | evidence-export redaction 测试组（默认脱敏 + command_digest） |
| 5 .mimosa/ 入库 | 高 | ✅ 已修复 | git ls-files \| grep -c mimosa = 0；.gitignore 已加 `.mimosa/` |
| 6 CHANGELOG 重复段 / README CLI 表缺项 | 中 | ✅ 已修复 | 文档审阅 |
| 3 policy digest ≠ 可信锚点 | 战略 | ✅ 措辞已对齐 | README/BRIEF 现称 policy fingerprint/binding；签名在路线图 |
| 7 hook 依赖 PATH 中的 reins | 中 | ⏳ 部分采纳 | doctor --agent/--all 已做；绝对路径方案在路线图（理由见下） |
| 阶段 B/C（SARIF、OTel、policy 签名生命周期） | 增强 | ⏳ 路线图 | schema v1 已为 NDJSON/JSON 落地，SARIF 下一版 |

## P0-1 修复细节

`src/core/trace.ts` 的 `append()` 现在在锁内执行完整流程：

```text
lstat 拒绝 symlink → readTrace → verifyEvents（全链校验）→ 断链即抛
  → 计算 seq/prevHash/policyDrift → lstat 复查 → open(fd, "a") → fstat 校验常规文件
  → fd.writeFile 追加 → close
```

`verifyTrace` 重构为 `verifyEvents(events)` + 包装器，锁内复用同一套校验逻辑，
避免"注释说验证了、实际只读了"的偏差。回归测试复现了评审的攻击序列
（open → 篡改 → append），断言：追加被拒、文件行数不变、verify 仍报 tampered。

锁所有权同步改进：锁文件写入 `{pid, createdAt, token}`；仅当**持有进程已死**
且超过 stale 窗口（或超 60s 硬上限）才窃取——慢写盘不再被误抢。

## P0-2 修复细节

- `TraceWriter.open()` 与 `append()` 均先 `lstat` 目标，符号链接直接拒绝
- 追加改为**已打开文件描述符**上的 `fh.writeFile`，并 `fh.stat()` 复核常规文件
- e2e：预置 `sessions/claude-link.jsonl → <home>/outside.jsonl`，执行 hook——
  hook 非零退出且 stderr 含 "symlink"，外部文件字节级不变
- Windows junction/reparse：Node 在 Windows 上将 junction 报告为 symlink，
  `lstat` 检查同样覆盖；Windows CI 会执行本测试文件

## export 规范化（发现 4.2/4.3/4.4）

- `--format` 非法 → exit 2（fail-closed），不再静默回退
- `integrity_status` 收敛为三个稳定枚举：`ok` / `verified_before_break` /
  `untrusted_after_break`；伴随机器可读的 `integrity_reason`
  （hash_mismatch / chain_break / seq_gap / bad_genesis）与 `integrity_broken_at`
- json 文档增加 `overall_integrity`
- 命令默认脱敏（Bearer / sk- / AKIA / ghp_ / token=/password= 等模式），
  同时保留 `command_digest`（原始命令 sha256，取证价值不丢失）；
  `--no-redact` 显式导出原文
- 导出非零退出语义：篡改账本可导出（取证需要），但 exit 1 + 逐事件
  `untrusted_after_break` 标注

## 4.1 测试补齐清单

- `test/trace-hardening.test.ts`：P0-1/P0-2 共 4 项
- `test/evidence-export.test.ts`：脱敏、逐事件完整性、ndjson/json e2e、
  篡改导出、非法 format 共 11 项
- `test/llm.test.ts`：LLM 可选功能共 12 项
- policy digest 参与哈希/漂移 transition：`test/trace.test.ts` 既有断言 +
  doctor 漂移检测见 `test/doctor.test.ts` 既有覆盖

## 仓库卫生（发现 5）

- `.mimosa/`（56 个文件）已 `git rm -r --cached` 并加入 `.gitignore`
- 仓库尚未推送到任何远端，因此不存在已公开历史需要清洗的问题；
  首次 push 将不含这些文件

## 文档与措辞（发现 3/6）

- 全部文档改用 **policy fingerprint / policy binding** 表述，不再使用
  trusted policy anchor；签名流程写入路线图（阶段 C）
- CHANGELOG 重组为干净的 `[0.3.0] / [0.2.0] / [0.1.0]` 三段，重复的
  Added/Fixed 段合并，`[Unreleased]` 留空待下一轮
- README CLI reference 补齐 `trace export`、`doctor --all/--agent`、
  policy digest 说明
- `YOUR_USERNAME` 占位符保留：仓库尚未创建，创建后按 PUBLISH.md 替换

## 新增：LLM 可选功能（v0.3.0）

按用户决策实现的**默认关闭**功能，方案见 `docs/llm-plan.md`，使用指南见
`docs/LLM.md`。与执法边界的关系重申：

- hook 热路径（~40ms、确定性）**没有任何 LLM 调用**
- `reins suggest` / `reins explain` / MCP `suggest_alternative` 全部为
  建议层：LLM 提议必须过 schema 校验、误报语料、replay 影响分析，
  且默认不落盘（--apply 人工触发）
- `provider: none`（默认）时全部命令优雅退出（exit 1 + 配置指引）

## 请复核验证

```bash
pnpm check                        # 255 tests（含本轮全部新增回归）
git ls-files | grep -c mimosa     # 0
node dist/cli/main.js trace export --format nope   # exit 2
# symlink 复现：见 test/trace-hardening.test.ts
# 篡改后追加复现：同文件第一组用例
```
