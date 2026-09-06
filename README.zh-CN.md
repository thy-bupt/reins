# reins（中文说明）

**握住你 AI 编码 agent 的缰绳。** reins 是本地、确定性的**可验证执行证据层**：
事前确定性策略判决、事后防篡改事件链、策略重演、Git 关联取证——叠加在沙箱之上，
证明 agent 请求了什么、依据哪套策略、账本是否可信。 声明式策略引擎 + 防篡改操作追踪 + 会话回放。与 agent 无关、本地优先、一条命令安装。

英文文档见 [README.md](README.md)。

## 为什么需要它

AI 编码 agent 以你的权限执行 shell 命令、改写文件。当前生态有三个空洞：

1. **Hook 会被"失效放行"（fail-open）**。[anthropics/claude-code#32990](https://github.com/anthropics/claude-code/issues/32990) 记录了一个 agent **删掉了正在拦截它的 hook 脚本**，此后系统全部放行。能被 agent 关掉的安全机制不叫安全机制。
2. **沙箱太重**。microVM / 云沙箱（E2B、microsandbox、gVisor…）解决"代码在哪里跑"，但不给你可读的策略、也没有审计账本——而且没人为了更安全地跑 `npm test` 去装虚拟机。
3. **没人留底账**。agent 干了意外的事之后，你需要一份防篡改的完整操作记录，还需要能回答"更严的策略能不能拦住它？"

reins 就是补在中间的轻量层：**策略 + 审计 + 回放**，进程内完成，无守护进程、无虚拟机。

## 核心能力

- **策略门**：YAML 声明 `allow / ask / deny`。支持 程序名+旗标 结构化匹配（能识别组合短旗标和包装命令：`rm -fr`、`sudo rm -rf`、`find -exec rm` 都会归一到 `rm`）、原始正则（抓 `curl … | sh`）、文件路径 glob（`.env`、`.ssh/`、`.git/`）。
- **防篡改追踪**：每个决策追加进 JSONL 会话文件，SHA-256 哈希链（每条记录承诺前一条）。`reins trace verify` 校验链条；**链条损坏时 hook 拒绝继续记录**。
- **默认 fail-closed**：hook 载荷畸形、策略加载失败、追踪被篡改 → 一律拦截。与 #32990 的失效模式正好相反。
- **回放**：`reins replay <session> --policy 更严的.yaml` 用候选策略重放历史会话，报告"哪些会被拦"，不执行任何东西。
- **体检**：`reins doctor` 检查策略、hook 安装、追踪完整性，发现失效放行会明确告诉你。

## 支持的 agent

| agent | 安装 | 集成方式 | ask 规则 |
| --- | --- | --- | --- |
| Claude Code | `reins init claude` | settings.json 的 PreToolUse hook | ✅ 交还给人 |
| Gemini CLI | `reins init gemini` | settings.json 的 BeforeTool hook | fail closed |
| Codex | `reins init codex` | hooks.json + config.toml feature 开关 | fail closed |
| Grok Build | `reins init grok` | ~/.grok/hooks/ 下的 hook 文件 | fail closed |
| opencode | `reins init opencode` | 自动加载的插件（抛错阻断） | fail closed |
| pi | `reins init pi` | 自动加载的扩展（{block:true} 阻断） | fail closed |
| 其他一切 | `reins exec -- <cmd>` | 通用包装器 | fail closed |

每个适配器都写入同一本防篡改账本（按 agent 分文件）。

## 快速开始

```bash
npm i -g reins
reins init claude     # 安装策略 + PreToolUse hook（自动备份原 settings.json）
```
重启 agent 会话（或执行 /hooks）以加载新 hook。

```console
$ # agent 想执行 rm -rf：
[reins] blocked by rule "rm-recursive": Recursive deletion is destructive and hard to undo   (exit 2)

$ reins trace verify
ok: 47 events, hash chain intact — ~/.reins/sessions/claude-….jsonl
```

## 策略示例

```yaml
version: 1
default: allow          # 无规则命中时的决策
rules:
  - id: rm-recursive
    kind: command
    action: deny
    program: rm
    flags: ["-r", "-R", "--recursive"]
    reason: "递归删除不可逆"

  - id: pipe-to-shell
    kind: command
    action: deny
    pattern: '\|\s*(ba|z|da)?sh(\s|$)'
    reason: "下载内容直接进 shell 执行未审查代码"

  - id: protect-dotenv
    kind: path
    action: deny
    path: "**/.env*"
    reason: "密钥文件不允许 agent 改写"
```

规则按顺序求值，**先命中先赢**。`ask` 会把决定交还给人。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `reins init claude` | 安装策略 + hook |
| `reins exec -- <cmd>` | 任意脚本/agent/CI 通用包装器 |
| `reins trace list` / `trace verify` | 列出 / 校验会话追踪 |
| `reins doctor` | 全面体检 |
| `reins replay [file] --policy <p>` | 用另一份策略重放会话 |

## 诚实的边界

- **不是 OS 级沙箱**：是策略与审计层。要硬隔离请与 bubblewrap / microsandbox / Claude Code sandboxing 叠加使用，它们是互补关系。
- **命令解析是启发式的**：覆盖组合旗标、包装命令、绝对路径、子命令、`-exec` 内嵌执行，但不做完整 shell 语义。绕过测试集（`test/decider.test.ts`）就是契约——提交新的绕过用例是最有价值的贡献。
- **追踪是防篡改可证（tamper-evident）而非防篡改（tamper-proof）**：有文件系统写权限的人可以整文件删除；哈希链证明的是"被改过"，不是"没被删"。
- **Windows 已支持**（真机验证 + windows-latest CI）。进程层默认用 `cmd.exe` 承载命令，设 `REINS_SHELL` 指向 `pwsh.exe` 可换 PowerShell 语义。

## License

[Apache-2.0](LICENSE)
