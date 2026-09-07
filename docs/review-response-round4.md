# reins 第四轮评审响应说明（给 Codex 复核用）

回应对象：第四轮复评（基于 v0.3.0 工作树）。本轮修复提交：`<本文件所在提交>`，
版本 **0.3.1**。所有修复带回归测试，当前 **264/264 通过**。

## 逐条响应

| 第四轮发现 | 严重度 | 状态 | 回归测试 / 验证 |
| --- | --- | --- | --- |
| `suggest --apply` 破坏 `rules: []` 策略（追加非法 YAML） | P0 | ✅ 已修复 | security-fixes + llm.test："structured merge … round-trip"，apply 后 hook 正常加载 |
| LLM 提议可注入 YAML（reason 换行/引号） | P0 | ✅ 已修复 | llm.test "rejects YAML injection attempts inside reason"（控制字符直接拒绝；合法提议经 yaml 库序列化 + loadPolicy 回读，注入在结构上不可能） |
| 提案验证缺 schema round-trip | P0 | ✅ 已修复 | 同上——validateProposal 内部走 yamlStringify → loadPolicy → 规则数比对 |
| MCP server 未读取 llm 配置 | P0 | ✅ 已修复 | mcp.e2e "MCP LLM fallback wiring"：command provider（假 LLM 输出固定 JSON）→ source=llm、llmUsed=true、候选经 decide 过滤 |
| MCP server 版本硬编码 0.2.0 | 中 | ✅ 已修复 | mcp.e2e "reports the current server version"（= 0.3.1） |
| `--session` 声明但被忽略 | 中 | ✅ 已修复 | suggest 现按 `--session` 解析分析集，文件缺失 exit 2 |
| suggest/explain 发送未脱敏命令与绝对路径 | 高 | ✅ 已修复 | 隐私白名单（core/redact.ts）被 LLM 管线复用：命令 redactCommand、路径 tildePath、账本仅按 basename 引用；explain 改用专用 LLM 安全渲染器（无绝对路径/diff）；--out 0600 |
| 锁 60s 抢占活进程 | 中 | ✅ 已修复 | shouldStealLock 提取为纯函数：活 pid 永不抢；死 pid 超 stale 才抢；unparseable 30s 宽限 |
| 路径误报语料缺失 / `path: "**"` 被接受 | 高 | ✅ 已修复 | llm.test：overly broad 拒绝 + **/README.md 命中语料拒绝 |
| 提案数量未限制 | 中 | ✅ 已修复 | parseProposals 截断至 3（llm.test） |
| reason 缺 llm-suggested 溯源 | 中 | ✅ 已修复 | validateProposal 注入 `[llm-suggested <date>]`（llm.test 断言） |
| `main`/`types` 指向不存在入口 | 中 | ✅ 已修复 | package.json 移除两字段；prepack 改 `npm run build` |
| MCP 硬编码版本 0.2.0 | 中 | ✅ 已修复 | 从 package.json 读取（mcp.e2e 断言 0.3.1） |
| `--out` 报告文件权限 | 中 | ✅ 已修复 | export/suggest/explain 的 `--out` 以 0600 写入 |
| IPv6 / 0.0.0.0 / redirect 端点绕过 | 中 | ✅ 已修复 | llm.test "rejects unspecified, IPv4-mapped, ULA and link-local"；fetch `redirect: "error"` |
| 文档版本/依赖数量不一致（zod） | 中 | ✅ 已修复 | PROJECT-BRIEF 更新（6 个依赖、0.3.1） |
| policy 签名生命周期 | 战略 | ⏳ 路线图 | 本轮按建议把措辞统一为 policy fingerprint/binding；签名流程保持阶段 C 首位 |

## 文档一致性修正

- `docs/LLM.md`：openai provider 的地址检查如实声明（含 IPv6 规范化、重定向拒绝），
  **明确"不做 DNS 解析后复查"** 为已知限制；本地模型一律 `command` provider（完全离线）
- `docs/llm-plan.md`：explain 用法改为位置参数 `[file]`，移除"本地 vLLM 走 openai
  provider"的表述（本地=command provider）
- 建议类报告文件（`--out`）0600 权限写入已写入 LLM.md

## 请复核验证

```bash
pnpm check                            # 264 tests, lint, build 全绿
git ls-files | grep -c mimosa         # 0

# 1) --apply 空策略回归
export REINS_HOME=$(mktemp -d)
printf 'version: 1\ndefault: allow\nrules: []\n' > $REINS_HOME/policy.yaml
reins suggest --apply                 # provider=none 会退出 1 —— 见下条先配 provider
# 配置 command provider（假 LLM 输出固定 JSON）后重跑 --apply，
# 再执行 reins hook claude（应正常加载策略，exit 不再是 2）

# 2) 注入不可行
# test/llm.test.ts "rejects YAML injection attempts inside reason"

# 3) MCP LLM fallback 真实接线
# test/mcp.e2e.test.ts "MCP LLM fallback wiring"（真实 dist server + 假 provider）

# 4) 隐私
# test/evidence-export.test.ts 脱敏组 + llm 管线复用 core/redact.ts

# 5) 锁
# test/trace-hardening.test.ts + shouldStealLock 纯函数（trace.ts 导出）

# 6) tarball 全流程
npm pack && npm install -g reins-*.tgz && reins init claude && \
  echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /x"}}' | reins hook claude && \
  reins trace export && reins uninstall claude
```

## 版本与定位

按建议：**0.3.1** 定位为 Evidence MVP 的加固版（experimental），不宣称
production-grade。对外承诺保持：

- 确定性执法 + policy fingerprint binding（非 trusted enforcement）
- 账本 tamper-evident（非 tamper-proof）
- LLM 建议层默认关闭、永不执法、人工 apply
- 与沙箱/guard/观测工具叠加而非替代

policy 签名（阶段 C）、SARIF/OTel 导出、绝对 hook 路径为 0.4.0 候选。
