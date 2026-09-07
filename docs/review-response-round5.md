# reins 第五轮评审响应说明（给 Codex 复核用）

回应对象：第五轮复评（基于 v0.3.1）。本轮修复提交：`<本文件所在提交>`，
版本 **0.3.2**。**285/285 测试通过**。

## 逐条响应

| 第五轮发现 | 严重度 | 状态 | 回归测试 / 验证 |
| --- | --- | --- | --- |
| P0：sessions/ 父目录 symlink 让账本写出 home | P0 | ✅ 已修复 | path-boundary.test："sessions/ as a symlink: hook refuses"——hook 非零退出、外部目录零文件；open/start 也拒绝 symlink 目录 |
| P0（伴随）：init 的 sessions 目录 0755 | P0 | ✅ 已修复 | path-boundary："init creates .reins and sessions with mode 0700" + "init heals pre-existing world-readable"（自愈 chmod 0700；home 同步自愈） |
| P0（TOCTOU：lstat→open 窗口） | P0 | ✅ 已修复 | append 改用 `O_WRONLY\|O_APPEND\|O_NOFOLLOW` 打开 + `fstat dev/ino` 与 lstat 核对；ELOOP → fail-closed。Windows：O_NOFOLLOW 不可用时回退双重 lstat（junction 以 symlink 形式被 lstat 捕获）；Windows CI 跑全量 |
| P0：REINS_HOME 本身是 symlink | P0 | ✅ 已修复（定义行为） | path-boundary："REINS_HOME as a symlink: hook refuses"——用户选择的 home 位置若是链接则直接拒绝 |
| P1-1 suggest --session 泄露兄弟会话 | P1 | ✅ 已修复 | collectLedgerSummaryFromFiles：摘要只从调用方显式文件集构建；e2e 断言兄弟账本名与内容均不出现在 provider prompt |
| P1-2 非 home 绝对路径进 LLM | P1 | ✅ 已修复 | 新增 `anonymizePath`（home 下 → `~/...`；其余绝对路径 → `<ABS_PATH>/basename`）；suggest 摘要与 explain 时间线统一使用；llm-privacy.test 断言 |
| P1-3 MCP suggest_alternative 原始命令进 prompt | P1 | ✅ 已修复 | prompt 使用 `redactCommand(args.command)`；e2e：Bearer secret 进不了 provider prompt，`[REDACTED]` 出现 |
| 锁 60s 抢占活进程 | P1 | ✅ 已修复 | `shouldStealLock` 纯函数：活 pid 永不抢（llm.test 三断言） |
| scripts.prepack 依赖 pnpm | P2 | ✅ 已修复 | scripts.prepack = `npm run build`；顶层 prepack 字段移除 |
| 文档数字（25/26 文件、264/268） | P2 | ✅ 已修正 | REVIEW-BRIEF / review-response-round4 更新（29 文件、285） |
| README roadmap MCP 标记 | P2 | ✅ 已修复 | README roadmap 勾选 MCP 已实现 |

## 修复后边界声明（对齐"不要过度承诺"）

- symlink 防护表述升级为：**leaf 与 sessions 目录级 symlink 均被拒绝**
  （O_NOFOLLOW 消除 lstat→open 竞态；REINS_HOME symlink 定义为 fail-closed 拒绝）
- LLM outbound contract：命令脱敏、路径匿名化（home 下 `~`、其余
  `<ABS_PATH>/basename`）、仅显式选择的会话出境、无 diff 无绝对路径
- DNS 解析后复查仍是已知限制（docs/LLM.md 已声明）

## 请复核验证

```bash
pnpm check                                  # 285 tests + lint + build
# 1) sessions 父目录 symlink
#    test/path-boundary.test.ts "sessions/ as a symlink"
# 2) REINS_HOME symlink（定义行为：拒绝）
#    test/path-boundary.test.ts "REINS_HOME as a symlink"
# 3) 竞态语义
#    test/path-boundary.test.ts "lock steal semantics"（活 pid 永不抢）
# 4) init mode 0700 + 自愈
#    test/path-boundary.test.ts "init creates .reins and sessions with mode 0700"
# 5) --session 不泄露兄弟会话
#    test/llm-privacy.test.ts（command provider 捕获 prompt）
# 6) MCP prompt 脱敏
#    test/mcp.e2e.test.ts "MCP LLM prompt redaction"
# 7) npm-only 打包（无 pnpm PATH）
npm pack --dry-run
# 8) O_NOFOLLOW 语义由内核保证（无直接竞态测试；lstat/fstat 身份核对双保险）
```

## 版本

**0.3.2**（experimental / Evidence MVP）。定位与承诺边界不变：
sandbox 管边界、guard 管阻断、reins 管可复核证据；LLM 默认关闭、永不执法。
