/**
 * `skill install` — copy the bundled agent skill (skills/space-cli/SKILL.md)
 * into a coding agent's skills directory so the agent discovers space-cli
 * workflows automatically. Pure filesystem work; no Space API involved.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpaceCliError } from './errors.js';

/**
 * The skill as shipped in the npm package (and in the repo). Resolved from
 * this module's location so it works identically from dist/ (installed CLI)
 * and from source (vitest).
 */
export const SKILL_SOURCE: string = fileURLToPath(
  new URL('../../skills/space-cli/SKILL.md', import.meta.url),
);

/** Global skills directory per supported agent, given a home directory. */
const AGENT_SKILL_DIRS: Record<string, (home: string) => string> = {
  pi: (home) => path.join(home, '.pi', 'agent', 'skills'),
  claude: (home) => path.join(home, '.claude', 'skills'),
};

export interface InstallSkillResult {
  /** Absolute path of the installed SKILL.md. */
  installed: string;
  /** True when an existing skill file was overwritten (--force). */
  overwritten: boolean;
}

/**
 * Copy the bundled skill to `<dir>/space-cli/SKILL.md`, creating the
 * directory as needed. Refuses to clobber an existing install unless
 * `force` is set (the CLI is the source of truth, but a human may have
 * customized the installed copy).
 */
export function installSkill(opts: { dir: string; force?: boolean; source?: string }): InstallSkillResult {
  const source = opts.source ?? SKILL_SOURCE;
  if (!fs.existsSync(source)) {
    throw new SpaceCliError('unexpected-error', `bundled skill not found at ${source}`);
  }
  const targetDir = path.join(opts.dir, 'space-cli');
  const target = path.join(targetDir, 'SKILL.md');
  const exists = fs.existsSync(target);
  if (exists && !opts.force) {
    throw new SpaceCliError(
      'usage-error',
      `skill already installed at ${target}; pass --force to overwrite it`,
    );
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(source, target);
  return { installed: target, overwritten: exists };
}

/** Skills directory for a named agent. Throws a usage-error for unknown names. */
export function agentSkillDir(agent: string, home: string): string {
  const toDir = AGENT_SKILL_DIRS[agent];
  if (toDir === undefined) {
    throw new SpaceCliError('usage-error', `unknown agent "${agent}"; supported: ${Object.keys(AGENT_SKILL_DIRS).join(', ')}`);
  }
  return toDir(home);
}
