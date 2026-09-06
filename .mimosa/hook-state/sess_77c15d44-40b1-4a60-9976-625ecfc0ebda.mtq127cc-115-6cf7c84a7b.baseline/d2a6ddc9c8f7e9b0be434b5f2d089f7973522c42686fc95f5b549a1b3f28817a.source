import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// both dist/ and src/ sit two levels below the package root
const PACKAGE_ROOT = join(HERE, "..", "..");

export const BUNDLED_POLICY_PATH = join(PACKAGE_ROOT, "policies", "default.yaml");

export function reinsHome(): string {
  return process.env["REINS_HOME"] ?? join(homedir(), ".reins");
}

export function sessionsDir(): string {
  return join(reinsHome(), "sessions");
}

export function userPolicyPath(): string {
  return join(reinsHome(), "policy.yaml");
}

/** explicit --policy flag wins, then the user's ~/.reins/policy.yaml,
 *  then the bundled default. */
export function resolvePolicyPath(explicit?: string): string {
  if (explicit) return explicit;
  const user = userPolicyPath();
  if (existsSync(user)) return user;
  return BUNDLED_POLICY_PATH;
}
