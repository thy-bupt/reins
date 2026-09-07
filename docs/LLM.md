# reins × LLM（可选功能）

reins 的 LLM 能力是**可选外挂，默认完全关闭**。不配置时，reins 的全部核心功能
（策略拦截、账本、replay、snapshot、MCP 查询）照常工作。

## 铁律

1. **LLM 永不执法**：hook 判决是确定性的，LLM 不参与；LLM 的所有产出都是建议
2. **建议必须过验证管线**：schema 校验 → 误报语料 → 历史会话 replay → 人工审批
3. **零硬依赖**：不内置 SDK；本地模型走 `command` provider，远程端点走 `openai` provider
4. **密钥只从环境变量读**，config.yaml 不存凭据

## 配置（`~/.reins/config.yaml`）

```yaml
llm:
  provider: command          # none（默认）| command | openai
  command: "ollama run qwen2.5-coder:7b"   # provider=command 时使用
  # 或者：
  # provider: openai
  # openai:
  #   baseUrl: https://api.openai.com/v1   # 兼容端点亦可（vLLM 等）
  #   model: gpt-4o-mini
  #   apiKeyEnv: REINS_LLM_API_KEY         # 密钥环境变量名
  timeoutSeconds: 60
  maxOutputChars: 8000
```

- `command`：reins 把 prompt 写入该命令的 stdin，读取 stdout 作为回复——
  任何能读 stdin 输出文本的程序都可以（本地模型推荐方式，完全离线）
- `openai`：调用 `<baseUrl>/chat/completions`。**仅允许公网地址**——
  loopback/私有/内网地址、IPv4-mapped 与 ULA IPv6、重定向均被拒绝；
  本地模型请用 `command` provider（已知限制：不做 DNS 解析后复查，见下）
- 不存在配置文件或 `provider: none` → 建议类命令打印指引后以退出码 1 结束

## 命令

### `reins suggest`（策略规则提议）

```bash
reins suggest [--last 3] [--out report.txt] [--apply]
```

读取会话账本（`--session <file>` 指定单个文件，或默认最近 3 个），
请 LLM 提议**至多 3 条**新规则。
每条提议自动经过：

1. schema 校验（复用策略加载器）
2. **误报语料防御**：`echo "rm -rf /tmp/x"`、`npm test` 等必放行命令若被新规则
   命中，提议自动作废
3. **replay 影响分析**：该规则对历史会话的影响（会新拦几条）

`--apply` 才会写入 `~/.reins/policy.yaml`：结构化合并（规则对象 → YAML 序列化 →
loadPolicy 回读验证 → 原子写入；任何失败原文件字节不变），并自动备份。
被采纳规则的 `reason` 标注 `[llm-suggested <日期>]` 溯源。

### `reins explain`（事故叙事）

```bash
reins explain [--audience dev|audit]
```

把最新会话的 snapshot 摘要交给 LLM，生成面向开发者或审计者的中文/英文事故报告。
只读、无副作用；报告准确性由你核对，账本才是事实。

### MCP `suggest_alternative`（agent 侧）

配置了 reins MCP server 的 agent 可以对"被拒命令"调用该工具：

- 第一层：确定性替代表（`git push --force` → `--force-with-lease` 等），无 LLM 也工作
- 第二层：LLM 兜底，**每个候选命令都会被决策器预检，只返回 allow 的**

## 威胁模型（必读）

| 威胁 | 缓解 |
| --- | --- |
| LLM 输出被当成命令执行 | LLM 无工具权限；输出只能是规则提议或替代命令文本；全部经过 decide()/replay/误报语料过滤 |
| 账本数据里的提示注入 | 账本命令文本按不可信输入处理：固定系统提示、只接受 JSON、注入指令最多污染"建议文本"，无法变成执行 |
| LLM 提议削弱策略 | allow 类提议若新拦事件数 > 0 直接拒绝；所有提议需人工 `--apply` |
| 密钥泄露 | key 仅存环境变量；导出/建议中的命令默认脱敏（Bearer/AKIA/sk-/token= 等） |
| 隐私 | `suggest`/`explain` 会把**已脱敏的命令文本和路径**发给所选 provider——本地 `command` provider 可完全离线；使用云端 provider 即表示你接受该数据出境 |

## 状态

`reins doctor` 的 `llm` 行显示当前 provider（未配置为正常状态，不是错误）。

## 已知限制（如实声明）

- `openai` provider 的地址检查在**发起请求前**执行（协议/主机名/IPv6 规范化/
  端口 0/重定向拒绝）；**不做 DNS 解析后复查**——公网域名若在请求时解析到
  内网 IP，本版本无法检出。完全离线的方案是 `command` provider + 本地模型
- `explain` 发送的是 LLM 安全渲染的时间线（脱敏命令 + `~` 化路径），
  不含绝对文件系统路径和 diff；`suggest` 发送脱敏后的命令与 `~` 化路径。
  使用云端 provider 即表示接受这些文本出境
- 建议类命令的报告文件（`--out`）以 0600 权限写入
