import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// both dist/ and src/ sit two levels below the package root
const PACKAGE_ROOT = join(HERE, "..", "..");

export const BUNDLED_POLICY_PATH = join(PACKAGE_ROOT, "policies", "default.yaml");

export function railguardHome(): string {
  return process.env["RAILGUARD_HOME"] ?? join(homedir(), ".railguard");
}

export function sessionsDir(): string {
  return join(railguardHome(), "sessions");
}

export function userPolicyPath(): string {
  return join(railguardHome(), "policy.yaml");
}

/** explicit --policy flag wins, then the user's ~/.railguard/policy.yaml,
 *  then the bundled default. */
export function resolvePolicyPath(explicit?: string): string {
  if (explicit) return explicit;
  const user = userPolicyPath();
  if (existsSync(user)) return user;
  return BUNDLED_POLICY_PATH;
}
