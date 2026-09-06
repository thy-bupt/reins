# reins × LLM 集成方案（v0.3 提案，默认关闭的可选功能）

## 0. 设计原则（不可协商）

1. **默认关闭**：无配置时所有 LLM 命令优雅退出，核心 225 测试零影响
2. **零硬依赖**：不内置任何 LLM SDK；provider 由用户配置（本地 ollama / 任意命令行 / OpenAI 兼容端点），API key 只从环境变量读
3. **LLM 永不执法**：hook 热路径保持 ~40ms 纯确定性；LLM 输出是"提议"，必须过确定性验证管线 + 人工审批
4. **注入防御**：喂给 LLM 的账本数据按不可信输入处理——固定系统提示、无工具权限、只接受结构化 JSON 输出、最坏后果是一条会被 replay 评估的规则提议
5. **可审计**：被采纳的规则在 reason 中标注 `llm-suggested <日期>` 溯源

## 1. 配置（`~/.reins/config.yaml`，可选文件，不存在 = 功能关闭）

```yaml
llm:
  provider: none | command | openai     # 默认 none
  command: "ollama run qwen2.5-coder:7b"  # provider=command：stdin 喂 prompt，stdout 收响应
  openai:
    baseUrl: https://api.openai.com/v1   # 兼容端点亦可（含本地 vLLM）
    model: gpt-4o-mini
    apiKeyEnv: REINS_LLM_API_KEY          # 密钥只从环境变量
  timeoutSeconds: 60
  maxOutputChars: 8000
```

- `none`（默认）：所有 LLM 命令打印配置指引后退出 1
- `command`：执行用户配置的命令行（ollama / llamafile / 任意脚本，最大灵活性）
- `openai`：全局 fetch 调 `/chat/completions`（Node 20 内置 fetch，零依赖）
- baseUrl 强制 http/https 且拒绝 localhost/私有地址（对齐 Mimosa 约束）

## 2. 模块结构

```text
src/llm/
├── config.ts      读取并校验 llm 配置段（yaml 依赖已有）
├── provider.ts    completePrompt(prompt, cfg) → string；分发 command/openai；
│                  未配置抛 LlmNotConfiguredError
├── suggest.ts     规则提议管线（核心，见 §3）
└── explain.ts     叙事生成（§5）
```

## 3. `reins suggest` —— 规则提议管线（核心功能，五步）

```bash
reins suggest [--session <file>] [--last N] [--out rules.yaml] [--apply]
```

```text
① 数据收集（确定性）  读账本：deny 规则分布、被拦命令聚类、重复被拦序列
② LLM 提议           固定模板 prompt → 严格 JSON：
                     { proposals: [{ kind, action, program?, flags?, pattern?,
                                     path?, reason, rationale }] }
                     解析失败/超 schema → 丢弃该提案（重试至多 1 次）
③ 确定性验证         a. 复用 loadPolicy 的规则校验器做 schema 校验
                     b. 提案与现有策略合并 → 对历史会话 replay → 影响报告
                        （拦几条 / 误报几条）
                     c. 误报防御：提案对 MUST_ALLOW 语料（echo "rm -rf"、
                        npm test、git commit -m "$(date)" …）跑 eval，
                        命中即自动拒绝该提案
④ 人审批             默认只打印带注释的 YAML 片段 + 影响报告；
                     --apply 时备份 policy.yaml 后合并，reason 标注
                     [llm-suggested <日期>]
⑤ 审计               被采纳规则的 sha256 自然被后续事件锚定（policyDigest）
```

## 4. MCP 工具 `suggest_alternative`（两层，无 LLM 也有用）

```text
第一层：确定性替代表（内置 ~15 条常见映射，零风险零延迟）
  git push --force        → git push --force-with-lease
  rm -rf node_modules     → npm ci
  chmod 777 <path>        → 按需最小授权建议
  …
第二层（provider ≠ none 时）：LLM 兜底长尾
  → 每个候选命令自动过 decide() 预检，只返回 allow 的候选
     （LLM 提议 → 决策器过滤 —— 最坏情况是浪费一轮对话）
```

工具描述明确标注 advisory only。**这一层是"无 LLM 也有价值"的关键。**

## 5. `reins explain` —— 事故叙事生成

```bash
reins explain [--session <file>] [--audience dev|audit]
```

输入：snapshot 的结构化摘要（已脱敏）；输出：markdown 事故叙事。
数据进、叙事出、无副作用；模板固定；provider=none 优雅退出。

## 6. 测试策略（TDD）

- provider=command：用假命令脚本（echo 固定 JSON）测全管线
- provider=openai：vitest 内起本地 http server 测协议、超时与 key 处理
- suggest 管线：注入 mock LLM 输出 → 验证 schema 拒绝、replay 影响计算、
  误报语料拒绝、--apply 写盘与备份、reason 溯源标注
- suggest_alternative：字典命中 / 无 LLM 仅字典 / LLM 候选过 decide 过滤
- explain：渲染 + none-provider 优雅退出
- **验收核心：provider=none 下全部新命令优雅退出，核心测试零回归**

## 7. 交付边界

**做（v0.3）**：config、两 provider、suggest（验证管线 + --apply）、explain、
MCP `suggest_alternative`、doctor 增加 llm 状态行、`docs/LLM.md`（配置指南 +
威胁模型）、PROJECT-BRIEF/README 更新

**不做（后续）**：SARIF 导出、policy 签名、TUI、自动应用规则、云端同步、
实时 LLM 判决

## 8. 工作量估算

provider/config 0.5 天 · suggest 管线 1 天 · MCP 工具 0.5 天 · explain 0.5 天 ·
文档 0.5 天 ≈ **3 天**（业余节奏 1–2 周）
