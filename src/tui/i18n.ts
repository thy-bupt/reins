/** Bilingual string table for the TUI. Language persisted in ~/.reins/config.yaml. */

export type Lang = "en" | "zh";

export interface UiStrings {
  // browser
  appTitle: string;
  selectSession: string;
  exit: string;
  noSessions: string;
  eventsLabel: string;
  tamperedLabel: string;
  driftLabel: string;
  backLabel: string;
  // session actions
  actionTimeline: string;
  actionTimelineHint: string;
  actionEvents: string;
  actionEventsHint: string;
  actionVerify: string;
  actionVerifyHint: string;
  actionBack: string;
  // timeline
  chainIntact: string;
  chainTampered: (reason: string) => string;
  driftBanner: (n: number) => string;
  driftStable: string;
  driftRow: string;
  emptySession: string;
  // event detail
  timestampLabel: string;
  toolLabel: string;
  decisionLabel: string;
  ruleLabel: string;
  ruleDefault: string;
  reasonLabel: string;
  resultLabel: string;
  exitCodeLabel: string;
  policyLabel: string;
  policyNotAnchored: string;
  commandLabel: string;
  fileLabel: string;
  eventHashLabel: string;
  driftYesLabel: string;
  eventDetailTitle: (seq: number) => string;
  decisionDeny: string;
  decisionAllow: string;
  decisionAsk: string;
  // verify
  verifyOk: (n: number) => string;
  verifyFail: (reason: string, at: number | undefined) => string;
  // wizard
  wizardWelcome: string;
  wizardSub: string;
  wizardLangTitle: string;
  wizardProviderTitle: string;
  wizardProviderSkip: string;
  wizardProviderSkipHint: string;
  wizardProviderCommand: string;
  wizardProviderCommandHint: string;
  wizardProviderOpenai: string;
  wizardProviderOpenaiHint: string;
  wizardApiKeyTitle: string;
  wizardApiKeyEnv: string;
  wizardModelTitle: string;
  wizardModelPlaceholder: string;
  wizardDone: string;
  wizardSkipped: string;
}

const EN: UiStrings = {
  appTitle: "reins — session browser",
  selectSession: "Select session",
  exit: "Exit",
  noSessions: "no sessions yet — agent decisions will appear here once a reins-protected agent runs",
  eventsLabel: "events",
  tamperedLabel: " · TAMPERED",
  driftLabel: " · drift",
  backLabel: "Back",
  actionTimeline: "Timeline",
  actionTimelineHint: "colored decision timeline",
  actionEvents: "Events",
  actionEventsHint: "drill into a single decision",
  actionVerify: "Verify",
  actionVerifyHint: "re-verify the hash chain now",
  actionBack: "Back",
  chainIntact: "✔ hash chain intact",
  chainTampered: (reason) => `✗ TAMPERED — ${reason}`,
  driftBanner: (n) => `⚠ policy drift: ${n} distinct digest(s) in this session`,
  driftStable: "policy digest stable",
  driftRow: "⚠drift",
  emptySession: "(empty session)",
  timestampLabel: "timestamp",
  toolLabel: "tool",
  decisionLabel: "decision",
  ruleLabel: "matched rule",
  ruleDefault: "(policy default)",
  reasonLabel: "reason",
  resultLabel: "result",
  exitCodeLabel: "exit code",
  policyLabel: "policy",
  policyNotAnchored: "(not anchored)",
  commandLabel: "command",
  fileLabel: "file",
  eventHashLabel: "event hash",
  driftYesLabel: "yes — policy changed mid-session",
  eventDetailTitle: (seq) => `event #${seq}`,
  decisionDeny: "DENY",
  decisionAllow: "ALLOW",
  decisionAsk: "ASK",
  verifyOk: (n) => `✔ ${n} events, chain intact`,
  verifyFail: (reason, at) => `✗ TAMPERED: ${reason} at event ${at ?? "?"}`,
  wizardWelcome: "reins setup wizard",
  wizardSub: "choose your language and configure the optional LLM provider",
  wizardLangTitle: "Language / 语言",
  wizardProviderTitle: "LLM configuration (optional, off by default)",
  wizardProviderSkip: "Skip — don't configure LLM",
  wizardProviderSkipHint: "all core features work without an LLM",
  wizardProviderCommand: "Local command (ollama / any CLI)",
  wizardProviderCommandHint: "fully offline",
  wizardProviderOpenai: "Remote endpoint (OpenAI-compatible)",
  wizardProviderOpenaiHint: "API key stored in env var only",
  wizardApiKeyTitle: "API key environment variable name",
  wizardApiKeyEnv: "REINS_LLM_API_KEY",
  wizardModelTitle: "Model name",
  wizardModelPlaceholder: "gpt-4o-mini",
  wizardDone: "Setup complete!",
  wizardSkipped: "LLM skipped — configure later via `reins init wizard`",
} as const;

const ZH: UiStrings = {
  appTitle: "reins — 会话浏览器",
  selectSession: "选择会话",
  exit: "退出",
  noSessions: "暂无会话 — 受 reins 保护的 agent 运行后，判决记录会出现在这里",
  eventsLabel: "个事件",
  tamperedLabel: " · 已篡改",
  driftLabel: " · 漂移",
  backLabel: "返回",
  actionTimeline: "时间线",
  actionTimelineHint: "彩色判决时间线",
  actionEvents: "事件详情",
  actionEventsHint: "钻取单个判决详情",
  actionVerify: "校验完整性",
  actionVerifyHint: "立即重验哈希链",
  actionBack: "返回",
  chainIntact: "✔ 哈希链完整",
  chainTampered: (reason) => `✗ 已篡改 — ${reason}`,
  driftBanner: (n) => `⚠ 检测到策略漂移（${n} 个不同指纹）`,
  driftStable: "策略指纹稳定",
  driftRow: "⚠漂移",
  emptySession: "（空会话）",
  timestampLabel: "时间戳",
  toolLabel: "工具",
  decisionLabel: "判决",
  ruleLabel: "命中规则",
  ruleDefault: "（策略默认）",
  reasonLabel: "理由",
  resultLabel: "结果",
  exitCodeLabel: "退出码",
  policyLabel: "策略指纹",
  policyNotAnchored: "（未锚定）",
  commandLabel: "命令",
  fileLabel: "文件",
  eventHashLabel: "事件哈希",
  driftYesLabel: "是 — 会话中途策略变化",
  eventDetailTitle: (seq) => `事件 #${seq}`,
  decisionDeny: "拒绝",
  decisionAllow: "放行",
  decisionAsk: "询问",
  verifyOk: (n) => `✔ ${n} 个事件，哈希链完整`,
  verifyFail: (reason, at) => `✗ 已篡改：${reason}（事件 ${at ?? "?"}）`,
  wizardWelcome: "reins 设置向导",
  wizardSub: "选择语言并配置可选的 LLM",
  wizardLangTitle: "选择界面语言 Language",
  wizardProviderTitle: "LLM 配置（可选，默认关闭）",
  wizardProviderSkip: "跳过 — 暂不配置 LLM",
  wizardProviderSkipHint: "全部核心功能无需 LLM",
  wizardProviderCommand: "本地命令（ollama / 任意 CLI）",
  wizardProviderCommandHint: "完全离线，推荐本地模型",
  wizardProviderOpenai: "远程端点（OpenAI 兼容）",
  wizardProviderOpenaiHint: "API key 仅存环境变量",
  wizardApiKeyTitle: "API key 环境变量名",
  wizardApiKeyEnv: "REINS_LLM_API_KEY",
  wizardModelTitle: "模型名称",
  wizardModelPlaceholder: "gpt-4o-mini",
  wizardDone: "配置完成！",
  wizardSkipped: "跳过 LLM 配置 — 随时可通过 reins init wizard 重新配置",
} as const;

const TABLE: Record<Lang, UiStrings> = { en: EN, zh: ZH };

export function strings(lang: Lang): UiStrings {
  return TABLE[lang] ?? TABLE["en"]!;
}

export { EN as enStrings, ZH as zhStrings };
