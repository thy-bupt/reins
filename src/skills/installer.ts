import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/skills/installer.js → ../.. = package root (same depth from src/)
const BUNDLED_SKILLS_DIR = join(HERE, "..", "..", "skills");

export const SKILL_NAMES = ["reins-selfcheck", "reins-incident"] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

/** Skills install as <targetBase>/<skill>/SKILL.md (Claude Code convention:
 *  targetBase defaults to ~/.claude/skills). Idempotent, marker-verified:
 *  an existing file that is not one of ours (user-created or user-modified)
 *  is never overwritten — the CLI fails closed and points the user at it. */
export async function installSkill(
  skill: SkillName,
  targetBase: string,
): Promise<{ changed: boolean; path: string; refused?: boolean }> {
  const source = join(BUNDLED_SKILLS_DIR, skill, "SKILL.md");
  if (!existsSync(source)) {
    throw new Error(`bundled skill not found: ${source}`);
  }
  const dest = join(targetBase, skill, "SKILL.md");
  await mkdir(dirname(dest), { recursive: true });
  const existing = existsSync(dest) ? await readFile(dest, "utf8") : null;
  const content = await readFile(source, "utf8");
  if (existing === content) {
    return { changed: false, path: dest };
  }
  // an existing file that is not byte-identical to ours is either a foreign
  // file or a user-modified copy — never clobber it
  if (existing !== null) {
    return { changed: false, path: dest, refused: true };
  }
  await copyFile(source, dest);
  return { changed: true, path: dest };
}

export async function skillInstalled(
  skill: SkillName,
  targetBase: string,
): Promise<boolean> {
  const dest = join(targetBase, skill, "SKILL.md");
  if (!existsSync(dest)) return false;
  const content = await readFile(dest, "utf8");
  return content.startsWith("---") && content.includes(`name: ${skill}`);
}

/** Remove an installed skill, but only when its content is still ours
 *  (starts with frontmatter naming the skill). */
export async function uninstallSkill(
  skill: SkillName,
  targetBase: string,
): Promise<{ removed: boolean; reason?: string }> {
  const dest = join(targetBase, skill, "SKILL.md");
  if (!existsSync(dest)) {
    return { removed: false, reason: "not installed" };
  }
  const content = await readFile(dest, "utf8");
  if (!(content.startsWith("---") && content.includes(`name: ${skill}`))) {
    return { removed: false, reason: "not a reins-generated skill — leaving it alone" };
  }
  await rm(join(targetBase, skill), { recursive: true });
  return { removed: true };
}

export { BUNDLED_SKILLS_DIR };
