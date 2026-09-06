import { spawn } from "node:child_process";
import type { LlmConfig } from "./config.js";

export class LlmNotConfiguredError extends Error {}

/** Reject loopback / private / link-local targets for HTTP providers.
 *  Remote LLM endpoints only; local models go through the `command` provider. */
export function assertPublicHttpUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid LLM endpoint URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`LLM endpoint must be http/https: ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  const privateHost =
    host === "localhost" ||
    host.endsWith(".local") ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (privateHost) {
    throw new Error(
      `LLM endpoint points at a loopback/private address (${host}) — use the command provider for local models`,
    );
  }
}

/** Complete a prompt with the configured provider. This is the ONLY entry
 *  point for LLM calls in reins — always advisory, never enforcement. */
export async function completePrompt(prompt: string, cfg: LlmConfig): Promise<string> {
  if (cfg.provider === "none") {
    throw new LlmNotConfiguredError(
      "LLM is not configured — add an `llm:` section to ~/.reins/config.yaml (see docs/LLM.md)",
    );
  }
  if (cfg.provider === "command") {
    return completeViaCommand(prompt, cfg);
  }
  return completeViaOpenAi(prompt, cfg);
}

async function completeViaCommand(prompt: string, cfg: LlmConfig): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", cfg.command!], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`LLM command timed out after ${cfg.timeoutSeconds}s`));
    }, cfg.timeoutSeconds * 1000);
    child.stdout?.on("data", (d) => (out += String(d)));
    child.stderr?.on("data", (d) => (err += String(d)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`LLM command failed: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`LLM command exited ${code}: ${err.slice(0, 400)}`));
      } else {
        resolve(out.slice(0, cfg.maxOutputChars).trim());
      }
    });
    child.stdin!.write(prompt);
    child.stdin!.end();
  });
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

async function completeViaOpenAi(prompt: string, cfg: LlmConfig): Promise<string> {
  const endpoint = cfg.openai!;
  assertPublicHttpUrl(endpoint.baseUrl);
  const apiKey = process.env[endpoint.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`missing API key: set the ${endpoint.apiKeyEnv} environment variable`);
  }
  const res = await fetch(`${endpoint.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: endpoint.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    }),
    signal: AbortSignal.timeout(cfg.timeoutSeconds * 1000),
  });
  if (!res.ok) {
    throw new Error(`LLM endpoint returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as ChatCompletionResponse;
  const text = data.choices?.[0]?.message?.content ?? "";
  return String(text).slice(0, cfg.maxOutputChars).trim();
}
