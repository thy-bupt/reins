# reins 审查说明（供 Codex 全量复议）

> 复核对象：reins —— AI coding agent 的可验证执行证据层。
> 本文档说明：项目做了什么、两轮独立评审的问题如何解决、真实项目验证结果、
> 已知边界，以及建议的复核步骤。上一轮专项响应见
> `docs/review-response-round3.md` 与 `docs/review-response-round4.md`。

## 1. 项目定位（经两轮评审迭代后确立）

reins 是 AI coding agent 的**本地、确定性、可验证执行证据层**：

```text
执行前：确定性策略判决（hook，agent 绕不开，~40ms，零 LLM/零网络/零守护进程）
执行后：防篡改事件账本（SHA-256 哈希链，断链拒写）
复盘：  策略重演（replay，绝不执行）+ git 关联取证（snapshot）+ 证据导出（schema v1）
增强：  只读 MCP 查询 + 可选 LLM 建议（默认关闭，永不执法）
```

边界声明：与沙箱（Claude Sandbox/OpenShell/bubblewrap）**叠加而非竞争**；
guard 工具阻断动作，reins 证明"请求了什么、依据什么策略、记录是否可信"。

## 2. 当前状态快照（commit `300b0f2`）

| 项 | 值 |
| --- | --- |
| 版本 | 0.3.2（npm 未发布，名称可用） |
| 测试 | **274/274**（29 个文件：绕过语料、并发账本、symlink、篡改追加、隐私、权限、六 agent 矩阵、MCP 协议级、apply 全链路、doctor 项目作用域检查） |
| CI | ubuntu (node 20/22/24) + windows-latest + macos-latest + 打包冒烟 + 隔离 HOME 全生命周期冒烟 |
| 运行时依赖 | 6 个（commander/yaml/picomatch/shell-quote/zod/@modelcontextprotocol/sdk） |
| 平台实测 | macOS 全量 ✅ · Windows 真机 154/154（v0.3.1 新增项待复验）· Linux 覆盖于 CI |

## 3. 时间线：做了什么

| 轮次 | 内容 | 交付 |
| --- | --- | --- |
| v0.1.0 | 核心三件套：策略引擎、哈希链账本、Claude Code hook、exec/replay/doctor；绕过语料测试集 | 初版 + 评审 |
| 评审一轮 | shell 绕过 ×17、账本并发、session_id 穿越、隐私、权限、打包 | 全修复（见 §4） |
| v0.2.x | 六 agent 适配（claude/gemini/codex/grok/opencode/pi）+ 矩阵 e2e + trace show/policy eval/uninstall + macos CI + Windows 跨平台 + 真机验证 | 多仓证据 |
| 评审二轮 | 追加二次验证缺失、symlink 逃逸、export 规范化、.mimosa 入库 | 全修复（见 §4） |
| v0.3.x | policyDigest 锚定 + 会话内漂移检测、`trace export` schema v1、`doctor --all/--agent`、**可选 LLM**（suggest/explain/MCP suggest_alternative，默认关闭） | 定位更新 |
| 真实项目轮 | express / openai-node / terraform-aws-vpc 三仓实测：真实 agent 拦截、幻觉揭穿、tfstate 盲区 → 策略迭代、漂移检测实战 | 见 §5 |

## 4. 解决了什么（两轮评审问题 → 修复映射）

### 第一轮（v0.3.0 前，7 项发布阻断全部关闭）

| 问题 | 修复 | 回归测试 |
| --- | --- | --- |
| shell 间接执行绕过（`bash -c`、控制流、`${IFS}`、`$(...)`/反引号、`env --`、`xargs -0`、`sudo -u`、wrapper 旗标取值） | 解释器 `-c` 递归解析、控制流关键字跳过、wrapper 旗标/取值处理、IFS 归一化、替换派生递归 | `bypass-corpus.test.ts` 17 绕过全 deny + 9 误报全 allow |
| 并发 hook 破坏哈希链 | 跨进程文件锁（`{pid,createdAt,token}`，死 pid 才窃取）+ 锁内重读重验 | 24 并发 e2e：链完整、seq 连续 |
| session_id 路径穿越 | 白名单 + sha256 哈希兜底（`sanitizeSessionId`） | evil id 落 sessions/ 内 e2e |
| trace 明文记录文件内容 | 输入白名单：文件类只存 `file_path` + contentSha256/contentLength | 隐私 e2e：TOP-SECRET 不出现在账本 |
| 配置覆盖（opencode/pi/mcp） | 非 reins 生成文件拒绝覆盖；MCP entry 所有权校验 | installer preservation 测试组 |
| 权限放宽 0600→0644 | atomicWrite 保留原 mode；sessions 0700/trace+policy 0600 | 权限回归测试 |
| 打包不可运行 | `prepack` + CI 打包冒烟 + 全生命周期冒烟（隔离 HOME） | CI package-smoke |
| `.mimosa/` 内部状态入库 | `git rm --cached` + `.gitignore`（`git ls-files \| grep -c mimosa` = 0） | — |

### 第二轮（v0.3.1，4 项）

| 问题 | 修复 | 回归测试 |
| --- | --- | --- |
| append 注释称"重验"实际只读 | 锁内 `readTrace → verifyEvents（全链）→ 断链抛错`；`verifyTrace` 重构拆出 `verifyEvents` 供锁内复用 | `trace-hardening.test.ts`：open→篡改→append 被拒、文件不变 |
| symlink 跳出 sessions/ | `open()`/`append()` 双重 `lstat` 拒绝 + **fd 追加**（缩小 TOCTOU） | 单元 + 预置 symlink hook e2e（外部文件字节不变） |
| export integrity 字段不稳定 | 拆分为 `integrity_status`（ok/verified_before_break/untrusted_after_break）+ `integrity_reason` slug + `integrity_broken_at`；json 增加 `overall_integrity` | evidence-export 语义测试 |
| 导出命令含秘密 | 默认脱敏（Bearer/AKIA/sk-/ghp_/token= 等）+ `command_digest` 保留取证价值；`--no-redact` 显式 | redaction 测试组 |

## 5. 真实项目验证（三轮，全部真实 clone + 真实 Claude Code headless）

### 5.1 expressjs/express —— 8 项全链路（v0.3.0 前）

拦截/放行/账本/快照/复原（`git restore` 后 md5 与 HEAD 一致）/MCP/卸载全过。
详见 `docs/evidence-v0.2.md`。

### 5.2 openai-node —— 真实拦截 + 幻觉对照

- hook 缺席轮：agent 谎报"rm -rf 被拦截"，账本无记录 → **当场揭穿虚构**
- hook 就位轮：真实 `rm -rf` DENY，agent 引用规则名与理由，受害目录完好
- 价值证明：**agent 的口头汇报不可信，账本是 ground truth**

### 5.3 terraform-aws-vpc —— 盲区发现 → 迭代 → 漂移检测实战 + 未保护项目事故

**事故**：tf-vpc 会话前遗漏 `reins init`——agent 真实写出 `terraform.tfstate`，
账本零记录。由此新增 doctor **project-hook 检查**（项目级 Claude 配置无 reins
hook 时告警"agent sessions here are unrecorded"），并在装 hook 后重放验证拦截。

1. 真实仓库暴露策略盲区：写 `terraform.tfstate`（含敏感数据）默认放行
2. 出厂策略迭代：新增 tfstate / `.terraform/` / `*.auto.tfvars`(ask) / `*.pem` / `*.key` 五类保护（出厂规则 13 → 18 条），各带误报对照测试
3. 同会话重放：DENY + **事件自动标记 `policyDrift: true`**（policyDigest 变化）
4. `doctor` 输出 `policy drift inside 1 session(s): 2 distinct policy digests`
详见 `docs/evidence-agent.md` 附录。

## 6. LLM 可选功能（默认关闭；方案 docs/llm-plan.md，指南 docs/LLM.md）

- provider 三种：`none`（默认）/ `command`（本地模型，完全离线）/ `openai`（仅公网端点）
- `reins suggest`：账本 deny 模式 → LLM 提议规则 → **四道确定性闸门**
  （字段净化/超宽路径拒绝 → yaml stringify + loadPolicy 回读 → 误报语料 → replay 影响）→ 人工 `--apply`
- MCP `suggest_alternative`：确定性替代表优先，LLM 兜底且候选经 `decide()` 预检
- `reins explain`：LLM 安全渲染时间线（脱敏命令、`~` 路径、无绝对路径无 diff）
- 审计：采纳规则的 reason 携带 `[llm-suggested <日期>]` 溯源

## 7. 已知边界（如实声明）

| 边界 | 现状 | 计划 |
| --- | --- | --- |
| 非 OS 级隔离 | 启发式 parser + 绕过语料契约；与沙箱叠加 | 不做 OS 隔离（定位） |
| policy 签名 | 未实现；本轮完成 fingerprint binding + 漂移检测；文档不再称 trusted anchor | 阶段 C 首位 |
| DNS 解析后复查 | openai provider 已拒私有字面量/重定向，**不做解析后复查**（LLM.md 已声明） | 评估中 |
| Windows v0.3.1 复验 | CI windows-latest 跑全量测试；真机复验待 Windows 侧重新开门 | 待办 |
| hook 二进制路径 | 依赖 PATH 中的 `reins`；doctor 有 PATH 检查 | 绝对路径方案 P1 |

## 8. 建议复核步骤

```bash
pnpm check                                   # 268 tests + lint + build
git ls-files | grep -c mimosa                # 0
# 1) 绕过语料（第三轮清单仍在）
pnpm vitest run test/bypass-corpus.test.ts
# 2) 账本并发 + 篡改追加 + symlink
pnpm vitest run test/trace-hardening.test.ts test/security-fixes.test.ts
# 3) 证据导出语义（逐事件完整性/脱敏/digest）
pnpm vitest run test/evidence-export.test.ts
# 4) LLM 可选功能：验证管线 + 注入拒绝 + provider=none 优雅退出
pnpm vitest run test/llm.test.ts
# 5) 真实 agent 证据核验
#    对照 docs/evidence-agent.md 中的账本行与文件系统断言

# 打包冒烟
npm pack && npm install -g reins-*.tgz && reins --version
```

评估维度建议：① 绕过面（攻击语料+自拟新变体）② 账本完整性（并发+篡改+symlink）
③ 安装/卸载无损 ④ 隐私模型与文档一致性 ⑤ 定位声明与实际能力的一致性
（本轮已按建议移除"唯一 fail-closed"类绝对表述，采纳"policy fingerprint/binding"
措辞，cc-safety-net Strict/Paranoid 区分已写入对比表）。

## 9. 路线图（按两轮评审建议排序）

policy 签名（阶段 C）→ SARIF/OTel 导出 + GitHub Action + PR 证据评论（阶段 B）→
hook 绝对路径 → 与 agent-replay/cc-safety-net 互操作（事件导入）→ stats/tail/
Homebrew（P1 体验）→ TUI（P2）。
