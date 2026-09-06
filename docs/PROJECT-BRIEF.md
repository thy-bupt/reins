# reins 项目总体信息（供评估者 / Codex 阅读）

> 评估入口建议：先读本文件 → `README.md`（功能与设计）→ `docs/evidence-v0.2.md` 与
> `docs/evidence-agent.md`（实验证据）→ 复现命令见文末"评估者快速上手"。

## 1. 项目是什么

**reins**（npm 名，已核验可用）是一个给 AI 编码 agent 用的 **fail-closed 安全层**：

```text
拦截（hooks，事前）  →  账本（防篡改，事后）  →  复盘（replay，策略模拟）  →  快照（snapshot，取证+复原）
```

- 执法层在 agent 平台的 hook 机制里（agent 绕不开）；MCP 与 Skills 是只读/建议层
- 核心设计原则：**执法路径零 LLM、零网络、零守护进程**（对齐 CaMeL "security by
  system design" 的结论，见 README "Design grounding"）

## 2. 核心能力

| 能力 | 命令 | 说明 |
| --- | --- | --- |
| 策略引擎 | `policies/*.yaml` | allow/ask/deny；程序+旗标（含组合旗标展开、wrapper 识别、`-exec` 上下文）、正则、路径 glob；先命中先赢 |
| 六 agent 适配 | `init/hook/uninstall <agent>` | claude / gemini / codex / grok / opencode / pi（各按其官方协议实现，见 `src/adapters/`） |
| 通用包装 | `exec -- <cmd>` | 任何脚本/CI 可用 |
| 防篡改账本 | `trace list/verify/show` | JSONL + SHA-256 哈希链；断链拒写（fail-closed） |
| 政策复盘 | `replay --policy <p>` | 用候选策略重演历史判决（绝不执行） |
| 取证快照 | `snapshot --with-diffs` | Markdown 卷宗：完整性 + 时间线 + git 关联 + 恢复指引 |
| 体检 | `doctor` | 策略 / 六 agent 安装状态 / 账本完整性 / PATH |
| MCP（只读） | `mcp` | `check_command` / `recent_decisions` / `policy_summary` / `stats` |
| Skills | `init skills` | `reins-selfcheck`（被拦后自救）/ `reins-incident`（取证工作流） |

## 3. 架构与代码布局

```text
src/core/      平台无关心脏：policy / matchers / decider / trace / runner / home
src/adapters/  六 agent 薄适配（共享引擎 common.ts：normalize→decide→trace→encode）
src/mcp/       只读 MCP 服务（永不 import runner，零执法权）
src/skills/    技能安装器（源文件在 skills/ 随包分发）
src/cli/       人类管理面（main / doctor / replay / snapshot / show）
```

分层铁律：**执法只在 hooks；MCP/Skills 永远只读或纯文本**。

## 4. 质量状态

- **185 个测试全绿**（macOS 本机），含：绕过攻击测试集（`rm -fr`/`sudo`/`find -exec`/
  多行/管道等变体）、误报防御（`echo "rm -rf"` 必须放行）、六 agent 矩阵 e2e（真实
  dist 二进制走 stdin）、MCP 协议级 e2e（SDK 客户端全握手）
- CI：ubuntu (node 20/22/24) + windows-latest + macos-latest
- 平台实测：macOS ✅ 全量 · Windows ✅ 真机 154/154（v0.2 新增项待复验）· Linux 覆盖于 CI
- 真实 agent 实测：Claude Code 2.1.263 headless，真实 `rm -rf` 被拦、MCP 工具被 agent
  亲自调用、agent 幻觉被账本揭穿（`docs/evidence-agent.md`）
- 真实仓库验收：expressjs/express clone 上 8 项全过（`docs/evidence-v0.2.md`）

## 5. 依赖与体积

- 运行时依赖 5 个：commander / yaml / picomatch / shell-quote / @modelcontextprotocol/sdk
- hook 单次决策 ~40ms（冷 Node 进程，含启动/策略加载/匹配/记账）
- 安装：`npm i -g reins`（或 `npx reins@latest`）

## 6. 已知边界（诚实清单）

- 非 OS 级沙箱：解析是启发式的（绕过测试集是契约，欢迎提交新变体）；建议与
  bubblewrap/microsandbox/官方 sandboxing 叠加
- policy.yaml 尚未签名（roadmap 首位）
- 无秘密泄露检测规则；无 TUI；Windows v0.2 复验挂起
- 单维护者冷启动

## 7. 路线图

policy 签名 → 秘密泄露规则 → P1 体验（stats/tail/补全/Homebrew）→ TUI / 交互式 ask /
策略向导 → AgentDojo 场景对齐 → 可选 `reins suggest`（LLM 分析 deny 模式提议规则，
默认关闭）→ 插件打包（v0.3）

## 8. 评估者快速上手（复现命令）

```bash
git clone <repo> && cd reins
pnpm install && pnpm build && pnpm test     # 或 npm install；185 测试应全绿
npm link                                    # 把 reins 放上 PATH
export REINS_HOME=$(mktemp -d)              # 隔离实验环境（可选）
reins init claude                           # 一键安装（备份原配置）
echo '{"session_id":"t","tool_name":"Bash","tool_input":{"command":"rm -rf /x"}}' \
  | reins hook claude                       # 期望 exit 2 + 拦截理由
reins trace show && reins doctor            # 账本 + 体检
reins uninstall claude                      # 干净拔除
```

评估要点建议：① hook 拦截/放行的正确性与绕过面；② 账本篡改检测（手改 JSONL 后
`trace verify` / hook 拒写）；③ snapshot 的 git 关联与复原指引；④ MCP 只读边界；
⑤ uninstall 不破坏用户配置。
