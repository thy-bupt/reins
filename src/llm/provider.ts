import { spawn } from "node:child_process";
import { resolveShellCommand } from "../core/matchers.js";
import type { LlmConfig } from "./config.js";

export class LlmNotConfiguredError extends Error {}

/** Reject loopback / private / link-local / unspecified targets for HTTP
 *  providers. Remote LLM endpoints only; local models go through the
 *  `command` provider. Note: DNS-resolution pinning is a known limitation
 *  (documented in docs/LLM.md) — a public hostname resolving to a private
 *  IP at request time is not caught here. */
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
  if (url.port === "0") {
    throw new Error(`LLM endpoint port 0 is not allowed`);
  }
  // strip IPv6 brackets: [::1] -> ::1
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const v4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`LLM endpoint points at a loopback/local hostname (${host})`);
  }
  if (v4) {
    const parts = host.split(".").map((s) => Number(s));
    const [a, b] = parts as [number, number, ...number[]];
    const privateV4 =
      a === 0 || // "this network" / unspecified (0.0.0.0)
      a === 10 ||
      (a === 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
    if (privateV4) {
      throw new Error(`LLM endpoint points at a private/loopback address (${host})`);
    }
  }
  if (host.includes(":")) {
    // IPv6 literal: reject unspecified, loopback, link-local (fe80), ULA
    // (fc/fd), and ALL IPv4-mapped forms — WHATWG URL normalizes
    // [::ffff:127.0.0.1] to hex (e.g. ::ffff:7f00:1), so prefix matching on
    // the dotted form is not enough
    const bad =
      host === "::" ||
      host === "::1" ||
      host.startsWith("fe80") ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("::ffff:");
    if (bad) {
      throw new Error(`LLM endpoint points at a loopback/private IPv6 address (${host})`);
    }
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
    // same deliberate platform shell as the exec engine (H1: checked string
    // and executed content must never diverge) — /bin/sh does not exist on
    // win32, where the default interpreter is cmd.exe
    const { file, args } = resolveShellCommand(
      process.platform === "win32" ? "win32" : "posix",
      cfg.command!,
    );
    const child = spawn(file, args, {
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
    // the provider may exit before reading the whole prompt — swallow EPIPE
    // on our side and judge by the exit code / output instead
    child.stdin?.on("error", () => {});
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
    // a public endpoint 302-ing to an internal address must not be followed
    redirect: "error",
    signal: AbortSignal.timeout(cfg.timeoutSeconds * 1000),
  });
  if (!res.ok) {
    throw new Error(`LLM endpoint returned HTTP ${res.status}`);
  }
  const data = (await res.json()) as ChatCompletionResponse;
  const text = data.choices?.[0]?.message?.content ?? "";
  return String(text).slice(0, cfg.maxOutputChars).trim();
}
