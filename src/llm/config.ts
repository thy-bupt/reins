import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

export type LlmProvider = "none" | "command" | "openai";

export interface LlmConfig {
  provider: LlmProvider;
  command?: string;
  openai?: { baseUrl: string; model: string; apiKeyEnv: string };
  timeoutSeconds: number;
  maxOutputChars: number;
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  provider: "none",
  timeoutSeconds: 60,
  maxOutputChars: 8000,
};

export type Lang = "en" | "zh";

export function llmConfigPath(): string {
  return process.env["REINS_HOME"]
    ? join(process.env["REINS_HOME"], "config.yaml")
    : join(homedir(), ".reins", "config.yaml");
}

export class InvalidLlmConfigError extends Error {}

/** Load the optional `llm:` section of ~/.reins/config.yaml. Missing file or
 *  section = provider "none" (the feature is off). A misconfigured provider
 *  (e.g. command provider without a command) degrades to "none" too — this
 *  module never blocks the deterministic core. */
export function loadLlmConfig(configPath = llmConfigPath()): LlmConfig {
  if (!existsSync(configPath)) return { ...DEFAULT_LLM_CONFIG };
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(configPath, "utf8"));
  } catch (err) {
    throw new InvalidLlmConfigError(
      `reins config ${configPath} is not valid yaml: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const llm = (doc as Record<string, unknown> | null)?.["llm"];
  if (typeof llm !== "object" || llm === null) return { ...DEFAULT_LLM_CONFIG };

  const section = llm as Record<string, unknown>;
  const cfg: LlmConfig = {
    provider: "none",
    command: typeof section["command"] === "string" ? section["command"] : undefined,
    openai:
      typeof section["openai"] === "object" && section["openai"] !== null
        ? {
            baseUrl: String((section["openai"] as Record<string, unknown>)["baseUrl"] ?? ""),
            model: String((section["openai"] as Record<string, unknown>)["model"] ?? ""),
            apiKeyEnv: String((section["openai"] as Record<string, unknown>)["apiKeyEnv"] ?? "REINS_LLM_API_KEY"),
          }
        : undefined,
    timeoutSeconds: typeof section["timeoutSeconds"] === "number" ? section["timeoutSeconds"] : 60,
    maxOutputChars: typeof section["maxOutputChars"] === "number" ? section["maxOutputChars"] : 8000,
  };

  if (section["provider"] === "command" && cfg.command && cfg.command.trim() !== "") cfg.provider = "command";
  else if (
    section["provider"] === "openai" &&
    cfg.openai &&
    cfg.openai.baseUrl !== "" &&
    cfg.openai.model !== ""
  )
    cfg.provider = "openai";

  return cfg;
}

/** Read the TUI language from config.yaml (`lang: en` or `lang: zh`).
 *  Returns undefined if not set (first run). */
export function readLang(configPath = llmConfigPath()): Lang | undefined {
  if (!existsSync(configPath)) return undefined;
  try {
    const doc = parseYaml(readFileSync(configPath, "utf8")) as Record<string, unknown> | null;
    if (doc?.["lang"] === "zh") return "zh";
    if (doc?.["lang"] === "en") return "en";
  } catch { /* ignore */ }
  return undefined;
}

/** Persist `lang` into config.yaml without destroying llm section. */
export function writeLang(lang: Lang, configPath = llmConfigPath()): void {
  let doc: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      doc = (parseYaml(readFileSync(configPath, "utf8")) as Record<string, unknown>) ?? {};
    } catch { doc = {}; }
  }
  doc["lang"] = lang;
  // dirname() not the string trick: Windows paths use backslashes
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify(doc, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}
