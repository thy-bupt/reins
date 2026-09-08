# reins（中文说明）

**握住你 AI 编码 agent 的缰绳。**

reins 是一个本地、确定性的 **可验证执行证据层**：在工具调用执行*之前*做确定性策略判决，在调用之后留下防篡改的事件链，支持策略重演与 Git 关联的事故取证。它位于沙箱（Claude Sandbox、OpenShell、bubblewrap）*之上*——沙箱约束 agent 能碰什么；reins 证明它请求过什么、依据哪套策略、记录本身是否可信。与 agent 无关、本地优先、一条 npm 安装。

英文文档见 [README.md](README.md)。

```bash
npm i -g @tanghuiyi/reins
reins init claude
```

完成。你的 Claude Code 会话从此运行在策略门后——重启 agent 会话（或执行 `/hooks`）以加载新 hook。

## 为什么需要它

AI 编码 agent 以你的权限执行 shell 命令、改写文件。当前生态有三个空洞：

1. **Hook 会"失效放行"（fail-open）**。[anthropics/claude-code#32990](https://github.com/anthropics/claude-code/issues/32990) 记录了一个 agent **删掉了正在拦截它的 hook 脚本**，此后系统全部放行。能被 agent 关掉的安全机制不叫安全机制。
2. **沙箱太重**。microVM / 云沙箱（E2B、microsandbox、gVisor…）解决"代码在哪里跑"，但不给你可读的策略、也没有审计账本——而且没人为了更安全地跑 `npm test` 去装虚拟机。
3. **没人留底账**。agent 干了意外的事之后，你需要一份防篡改的完整操作记录，还需要能回答"更严的策略能不能拦住它？"

reins 就是补在中间的轻量层：**策略 + 审计 + 回放**，进程内完成，无守护进程、无虚拟机。

## 核心能力

- **策略门**：YAML 声明 `allow / ask / deny`。支持 程序名+旗标 结构化匹配（组合短旗标与包装感知：`rm -fr`、`sudo rm -rf`、`find -exec rm` 都归一到 `rm`）、原始正则（抓 `curl … | sh`）、文件路径 glob（`.env`、`.ssh/`、`.git/`、`*.tfstate*`）。
- **防篡改追踪**：每个决策追加进 JSONL 会话文件，SHA-256 哈希链（每条记录承诺前一条）。`reins trace verify` 校验链条；**链条损坏时 hook 拒绝继续记录**。
- **默认 fail-closed**：hook 载荷畸形、策略加载失败、追踪被篡改 → 一律拦截。与 #32990 的失效模式正好相反。
- **回放**：`reins replay <session> --policy 更严的.yaml` 用候选策略重放历史会话，报告"哪些会被拦"，不执行任何东西。
- **操作快照**：`reins snapshot` 输出取证 Markdown 卷宗：完整性判定、策略指纹、完整时间线、被改文件的 git 状态与恢复指引（`git restore`、`git reflog`）。篡改的账本也能出报告——证据保留、篡改被标注。
- **策略指纹绑定**：每个账本事件记录判决所用策略的 sha256；会话内策略变化被标记为漂移并由 `doctor` 检出。（这是策略*指纹*——签名，即防止 agent 削弱自身策略，是下一个里程碑。）
- **体检**：`reins doctor` 检查策略、hook 安装、账本完整性，并检查**当前目录**的项目级保护；处于失效放行时会明确告诉你。
- **MCP server（只读）**：`reins mcp` 向 agent 暴露 `check_command`、`recent_decisions`、`policy_summary`、`stats` 与 `suggest_alternative`：agent 撞墙前可自查、可回顾自己的被拦记录。合作式设计——工具全部只读，hook 在执行时重新判决。
- **Skills**：`reins init skills` 安装两个工作流技能：`reins-selfcheck`（被拦后的正确反应）与 `reins-incident`（用 trace + snapshot 调查 agent 行为）。仅建议性；`reins uninstall skills` 干净卸载。

## 支持的 agent

| agent | 安装 | 集成方式 | ask 规则 |
| --- | --- | --- | --- |
| Claude Code | `reins init claude` | `~/.claude/settings.json` 的 PreToolUse hook | ✅ 经权限流程交还给人 |
| Gemini CLI | `reins init gemini` | `~/.gemini/settings.json` 的 BeforeTool hook | fail closed（带理由拒绝） |
| Codex | `reins init codex` | `~/.codex/hooks.json` + config.toml 的 `[features] hooks = true` | fail closed |
| Grok Build | `reins init grok` | `~/.grok/hooks/` 下的 hook 文件 | fail closed |
| opencode | `reins init opencode` | `~/.config/opencode/plugins/` 插件（抛错阻断） | fail closed |
| pi | `reins init pi` | `~/.pi/agent/extensions/` 扩展（`{block:true}` 阻断） | fail closed |
| 其他一切 | `reins exec -- <cmd>` | 通用包装器（脚本/CI/任何 agent） | fail closed |

两点如实说明：Grok Build 自身在 hook 崩溃/超时时 fail-open（其[官方文档](https://docs.x.ai/build/features/hooks)如此声明）——我们的 hook 干净退出，但 `reins` 二进制缺失时 Grok 会放行，请跑 `reins doctor`。Grok 也原生读取 Claude Code 的 `.claude/settings.json`，claude 适配器通常顺带覆盖它。每个适配器写入同一本防篡改账本（按 agent 分文件：`claude-<session>.jsonl`、`grok-<session>.jsonl`…）。

## 示例

```console
$ echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /tmp/important"}}' \
    | reins hook claude
[reins] blocked by rule "rm-recursive": Recursive deletion is destructive and hard to undo   (exit 2)

$ reins trace verify
ok: 47 events, hash chain intact — ~/.reins/sessions/claude-3f2a….jsonl

$ reins doctor
 ✓ policy       18 rules, default=allow (~/.reins/policy.yaml)
 ✓ claude-hook  installed in ~/.claude/settings.json
 ✓ traces       1 trace(s) verified, hash chains intact
reins looks healthy.
```

## 实机效果

来自真实 reins 安装的截图（macOS 终端，深色主题）。第一张是 hook 拦截递归删除；
第二张是健康的 `reins doctor`——每个 agent 都已接上、策略加载、账本校验通过，
全绿输出 `reins looks healthy.`。

![reins hook 拦截 `rm -rf`](docs/demo-hook-block.png)

![`reins doctor` 体检](docs/demo-doctor.png)

## 编写策略

`~/.reins/policy.yaml`（由 `reins init` 安装，可编辑，每次判决热加载）：

```yaml
version: 1
name: my-policy
default: allow          # 无规则命中时的决策
rules:
  # 结构化命令规则：程序 + 旗标（任一命中），包装感知
  - id: rm-recursive
    kind: command
    action: deny
    program: rm
    flags: ["-r", "-R", "--recursive", "-d", "--dir"]
    reason: "递归删除具有破坏性且难以恢复"

  # 子命令 + 旗标
  - id: git-force-push
    kind: command
    action: deny
    program: git
    subcommand: push
    flags: ["--force", "-f"]
    reason: "强推改写共享历史"

  # 对命令字符串的原始正则
  - id: pipe-to-shell
    kind: command
    action: deny
    pattern: '\|\s*(ba|z|da)?sh(\s|$)'
    reason: "管道进 shell 执行未审查代码"

  # 文件路径 glob（点感知），作用于文件写入/编辑
  - id: protect-dotenv
    kind: path
    action: deny
    path: "**/.env*"
    reason: "密钥文件 —— 永不让 agent 改写"

  # ask = 把决定交还给人
  - id: ask-before-clean
    kind: command
    action: ask
    program: git
    subcommand: clean
    reason: "git clean 删除未跟踪文件"

  # 来自真实 terraform 仓库的经验：state 文件含密钥
  - id: protect-terraform-state
    kind: path
    action: deny
    path: "**/*.tfstate*"
    reason: "Terraform state 含敏感数据 —— 用 terraform 管理，永不直接编辑"
```

规则按顺序求值，**先命中先赢**。`ask` 在 hook 中走 agent 的真人许可流程（Claude Code 权限流），无 ask 通道的 agent 与 headless `exec` 模式一律按 deny 处理。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `reins init <agent>` | 安装策略 + hook —— `claude` / `gemini` / `codex` / `grok` / `opencode` / `pi`，或组件 `skills` / `mcp`（自动备份原配置） |
| `reins hook <agent>` | hook 入口（agent 调用；一般不用手动） |
| `reins exec -- <cmd>` | 在策略下运行任意命令 —— 适用于脚本/CI/其他 agent |
| `reins trace list` / `trace verify [file]` | 列出会话 / 校验哈希链 |
| `reins trace show [file]` | 终端人读时间线 |
| `reins trace export [file]` | schema-v1 证据导出（ndjson / json），默认密钥脱敏 |
| `reins policy eval "cmd"` / `--file <p>` | 干跑判决 —— 绝不执行 |
| `reins doctor` / `--all` / `--agent <name>` | 全面体检：策略、hook、全部 agent、账本、项目级保护 |
| `reins replay [file] --policy <p>` | 用另一份策略重放会话，输出拦截预判 |
| `reins snapshot [file] --with-diffs` | 取证卷宗：时间线 + git 状态 + 恢复指引 |
| `reins suggest` | 可选 LLM：从账本模式提议策略规则（docs/LLM.md） |
| `reins ui` | 交互式会话浏览器 —— 彩色时间线、事件钻取（真实终端里裸 `reins` 也会打开，首次运行选择语言） |
| `reins explain [file]` | 可选 LLM：由会话快照生成事故叙事 |
| `reins uninstall <agent>` | 干净卸载（不动别人的 hook） |

配置：`REINS_HOME` 覆盖 `~/.reins`（会话与策略所在地）。`--policy <path>` 按调用覆盖策略。

## 架构

无守护进程、无虚拟机、无 watcher。每次判决一个短命进程：

```text
┌─────────────────────────────────────────────────────────────┐
│  agent（Claude Code；任何带 hook 或 shell 的程序）          │
└──────────────┬──────────────────────────────────────────────┘
               │ PreToolUse hook: JSON on stdin
               ▼
        reins hook claude
               │
               ├── 加载策略 (~/.reins/policy.yaml)
               ├── 解析与匹配 ──► allow │ ask │ deny
               │     （shell-quote 分段、旗标展开、
               │      wrapper/exec 上下文识别、路径 glob）
               │
               ├── 追加判决到 sessions/<session>.jsonl
               │     （SHA-256 哈希链 —— 每条记录承诺前一条；
               │      断链则拒绝追加：fail closed）
               │
               └── 响应
                        allow → exit 0
                        ask   → exit 0 + permissionDecision JSON
                        deny  → exit 2 + 理由（回传给 agent）
```

`reins exec` 从脚本与 CI 使用同一引擎；`reins replay` 读回账本只重演*判决*（绝不执行命令）。

## 性能

一次判决 = 一个冷 Node 进程：Apple Silicon 上约 **40ms/次工具调用**（含 Node 启动、策略加载、匹配与记账，以默认 18 条规则策略实测）。被审查的 shell 命令通常比这慢一个数量级。

## 设计依据

reins 的核心选择与 agent 安全文献一致：以**系统设计而非模型行为**实现安全（[CaMeL, arXiv:2503.18813](https://arxiv.org/abs/2503.18813)——确定性闸门，LLM 永不在执法层）、在**agent 与工具之间**设护栏（[GuardAgent, arXiv:2406.09187](https://arxiv.org/abs/2406.09187)）、以及对 agent 每次尝试的防篡改证据——正是 [AgentDojo](https://arxiv.org/abs/2406.13352) 类基准留下的空白。已在真实仓库端到端验证（[证据](docs/evidence-v0.2.md)），并在**真实 agent 会话**上验证：Claude Code 以 `--dangerously-skip-permissions` 在 clone 的 express 仓库中运行——agent 的 `rm -rf` 被 hook 拒绝、命令从未执行；当 agent 之后*谎称*遭遇一次从未发生的拦截时，账本揭穿了伪造（[agent 证据](docs/evidence-agent.md)）。

## 诚实的边界

把机器托付给任何工具之前，请先读这一节：

- **reins 不是 OS 沙箱**。它是策略与审计层。解析器覆盖包装旗标（`sudo -u`、`env --`、`xargs -0`）、控制流关键字、`${IFS}` 混淆、命令替换（`$(…)`、反引号）与解释器递归（`bash -c "…"`），但足够有创造力的 agent 仍可能找到未分类的形态。要硬隔离请与 bubblewrap/Seatbelt、microVM（microsandbox）或 [Claude Code sandboxing](https://code.claude.com/docs/en/hooks#sandboxing) 叠加——互补而非替代。
- **命令解析是启发式的**。覆盖组合短旗标、包装二进制（`sudo`、`env`、`xargs`…）、绝对程序路径、子命令与 `-exec` 式内嵌执行；不做完整 shell 语义。绕过测试集（`test/decider.test.ts`）就是契约——提交新的绕过用例是最有价值的贡献。
- **追踪是防篡改可证（tamper-evident）而非防篡改（tamper-proof）**。对 `~/.reins/sessions` 有文件系统写权限者可以删除整个文件——哈希链证明的是*被修改*，不是*未被删除*。高风险场景请限制权限或将账本外送。
- **策略本身尚未签名**。能写 `~/.reins/policy.yaml` 的 agent 可以先放宽策略再做你要禁止的事。策略完整性校验是 roadmap 首位；在此之前保持 `~/.reins` 仅本人可写，并把 `reins doctor` 纳入日常。
- **Windows 已支持**（真实 Windows 硬件 + `windows-latest` CI 验证）。进程层用 `cmd.exe` 承载命令。**解释器刻意不可选择**——环境或调用方覆盖会让被检查的字符串与被执行的内容分裂（安全审计发现 H1）。hook 载荷来自各 agent 的 Windows 构建（Codex 另支持按 OS 的 `commandWindows` 覆盖）。

## 横向对比

"让 agent 更安全"的赛道在 2025–2026 很拥挤，这是好事。以下是与你会实际比较的项目（2026-09 数据）：

| | **reins** | [cc-safety-net](https://github.com/kenryu42/cc-safety-net)（1.5k★） | [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)（官方） | [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell)（8.5k★） | [agent-replay](https://github.com/clay-good/agent-replay)（13★） |
| --- | --- | --- | --- | --- | --- |
| 定位 | 策略门 + 防篡改账本 + 回放 | 执行前命令守卫 | OS 级文件/网络沙箱（Seatbelt/bubblewrap） | 带 YAML 策略的容器运行时 | agent 运行的时光回溯调试 |
| 策略文件 | YAML，热加载 | 预设 + JSON rulebook + Web GUI | sandbox 设置 | YAML，动态段热加载 | — |
| 决策账本 | 每次决策，JSONL | 拦截日志 | — | — | 完整 trace（SQLite） |
| 防篡改证据 | 哈希链，断链拒写 | — | — | — | — |
| 新策略回放 | ✅ 策略差异报告 | — | — | — | 调试向 replay/fork |
| fail-closed 内核 | ✅ 设计使然（错误/篡改阻断；未命中按策略默认） | Standard 模式偏放行；Strict/Paranoid 保守 | 不适用 | 沙箱 | — |
| agent 覆盖 | **6 适配器 + 通用 exec** | **13 个 CLI** | 仅 Claude Code | 其托管的 agent | 追踪库，agent 无关 |
| OS 级强制 | ❌（启发式解析） | ❌（同类做法） | ✅ | ✅（Landlock） | — |
| 重量 | npm，无守护进程，~40ms/次 | npm，无守护进程 | 内置 | Rust + 容器 | npm |

**别人的长处**：cc-safety-net 覆盖面更广、有 GUI、跨读取工具的秘密阻断、社区真实——纯"多 agent 拦危险命令"是它主场。OpenShell 与官方沙箱在内核层强制，用户态解析器无法匹敌。agent-replay 的调试体验更好。

**reins 的差异**：它是其中唯一账本*可验证*（哈希链、拒绝续写被篡改文件）的，唯一把策略门与*候选策略回放*组合并把每个判决绑定到策略指纹（含会话内漂移检测）的。cc-safety-net 的 Strict/Paranoid 已缩小 fail-closed 差距——reins 的差异化是**可验证账本 + 回放 + 证据导出**，而不是宣称唯一的 fail-closed hook。这三性质合成的是别人没有的端到端能力：**你能信任的、关于 agent 尝试过什么的证据**——这正是事故复盘、合规、决定是否收紧策略所需要的东西。它与上述所有工具叠加运行而非互斥：沙箱管隔离，guard 管阻断，账本照记。

## Roadmap

- [x] Codex / Gemini CLI / Grok Build / opencode / pi 适配器
- [ ] **策略完整性** —— 签名 `policy.yaml`（指纹锚定在账本中），使 rogue agent 无法削弱自己的护栏
- [ ] 更多 agent：Cursor、Aider、Windsurf…
- [ ] 秘密泄露检测规则
- [x] 双语交互式会话浏览器（`reins ui`，含首次语言选择）
- [x] MCP server 暴露账本查询给 agent（`reins mcp`）
- [ ] 策略注册表：按技术栈可分享的预设策略

## FAQ

**已经有 hook 工具（cc-safety-net）了，为什么还要这个？**
可以同时用——它们可组合。cc-safety-net 在 agent 覆盖上更广、开箱更友好。reins 存在的理由是其他 hook 工具没有的部分：完整性*可验证*的账本、出错时的 fail-closed 语义、以及采用更严策略之前先在真实会话上回放。

**为什么不直接用 Claude Code 内置沙箱？**
应该用——它们解决不同问题，叠加即可。沙箱约束*代码在哪里跑*（OS 级文件/网络）。reins 增加可移植、人可读的策略与理由、能扛篡改的决策账本、以及回放——沙箱不给这些，换 agent 时它们也不会跟着你走。

**会让 agent 变慢吗？**
约 40ms/次工具调用（实测，见性能）。被审查的命令通常比这贵得多。

**追踪是键盘记录器吗？**
不是。它记录工具名、工具输入、判决与理由——无命令输出、无文件内容、无 prompt。它留在你机器的 `~/.reins/sessions/`。

**什么阻止 agent 改 policy.yaml 或自己的追踪？**
篡改追踪会被检出（哈希链）并阻断后续记录——这是 fail-closed 保证。削弱 `policy.yaml` *尚未*被阻止；这是 roadmap 首位。在此之前把 `~/.reins` 权限当作配置的一部分，定期跑 `reins doctor`。

**Windows？**
支持——真实 Windows 硬件与 `windows-latest` CI 验证。`reins exec` 用 `cmd.exe` 承载命令（解释器刻意不可由环境选择——见安全审计的 H1）。

**有 GUI 吗？**
有交互式终端浏览器：在真实终端里跑裸 `reins` 或 `reins ui`，得到双语（English/中文）会话浏览器——彩色判决时间线、事件钻取、就地校验。首次运行选择语言。非 TTY 与 `NO_COLOR` 自动降级为纯文本。

## 贡献

欢迎 PR —— 见 [CONTRIBUTING.md](CONTRIBUTING.md)。绕过测试集是本项目的心脏：发现一条能溜过本该拦住的策略的命令时，开 issue 附上该命令，我们会把它做成测试用例。

## License

[Apache-2.0](LICENSE)
