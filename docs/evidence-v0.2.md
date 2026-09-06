# reins v0.2 验收实验证据

实验目的：在真实 GitHub 项目（expressjs/express 5.2.1）上验证 reins 的完整安全闭环——
**事前拦截、防篡改账本、取证快照、按指引复原、MCP 只读查询、干净卸载**。

- 实验时间：2026-09-06 · 平台：macOS (darwin 25.6.0, arm64)
- 测试床：github.com/expressjs/express @ 023767f（`git clone --depth 1`）
- 验收命令全部为真实编译产物（`dist/cli/main.js`）+ MCP SDK 客户端

## 1. 初始化

```
$ reins init claude --settings $REINS_HOME/s.json
policy installed: $REINS_HOME/policy.yaml
hook installed in $REINS_HOME/s.json (backup written alongside)
$ reins init skills --settings $REINS_HOME/skills
skill installed: .../skills/reins-selfcheck/SKILL.md
skill installed: .../skills/reins-incident/SKILL.md
```

## 2. agent 正常工作 → 放行

| 操作 | 结果 |
| --- | --- |
| `Bash: npm test` | exit 0，放行 |
| `Write: lib/application.js` | exit 0，放行 |

随后模拟 agent 真实改写文件：`echo "## agent was here" > lib/application.js`

## 3. agent 危险操作 → 全部拦截（exit 2，命令未执行）

```text
rm -rf /tmp/x       → exit 2  blocked by rule "rm-recursive": Recursive deletion is destructive
写 .env             → exit 2  blocked by rule "protect-dotenv": Secrets file
git push --force    → exit 2  blocked by rule "git-force-push": Force push rewrites shared history
ls -la （对照组）    → exit 0  放行
```

## 4. 账本完整性 + 人读时间线

```
$ reins trace verify
ok: 5 events, hash chain intact

$ reins trace show
#0  ALLOW Bash  npm test
#1  ALLOW Write Write: .../lib/application.js
#2  DENY  Bash  rm -rf /tmp/x [rm-recursive] — Recursive deletion is destructive
#3  DENY  Write Write: .../express/.env [protect-dotenv] — Secrets file
#4  DENY  Bash  git push --force [git-force-push] — Force push rewrites shared history
```

## 5. 取证快照（git 关联）

```
$ reins snapshot --with-diffs --out snapshot-report.md
snapshot written; events: 5, chain: OK, git: /private/tmp/reins-acceptance/express
```

报告内含：HEAD 指纹（`6dbcc63…` 前身提交）、脏文件清单（`M lib/application.js`）、
真实 diff（`-original / +agent was here`）、恢复指引（`git restore -- lib/application.js`）、
被拦动作汇总（3 条，含规则与理由）。

## 6. 复原验证（按快照指引执行）

```
$ git restore -- lib/application.js
$ git show HEAD:lib/application.js | md5
3f346740ed9d9ddbfab6499c766dfe6e   ← 与改动前完全一致，复原成功
```

## 7. MCP 只读通道（@modelcontextprotocol/sdk 客户端，完整 JSON-RPC 握手）

```text
mcp check_command("rm -rf /tmp/x") → deny / rm-recursive
mcp recent_decisions(verdict=deny) → 3 条被拦记录
mcp stats → { sessions: 1, events: 5, allow: 2, deny: 3, ask: 0, tamperedSessions: 0 }
```

## 8. 干净卸载

```
$ reins uninstall claude
hook removed from .../s.json        ← 仅移除 reins 条目，其他设置原样保留
```

## 结论

8 项验收全部通过：放行/拦截行为符合策略、账本哈希链完整、快照给出可执行的复原指引、
复原后内容与 HEAD 一致（md5 相等）、MCP 全工具只读可用、卸载不留残余。
