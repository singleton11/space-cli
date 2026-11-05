import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SpaceCliError } from './errors.js';

export interface ResolvedConfig {
  /** Space instance base URL, e.g. https://jetbrains.team */
  url: string;
  /** Bearer token. */
  token: string;
}

export interface ResolveConfigOptions {
  /** Environment variables (usually `process.env`). */
  env: Record<string, string | undefined>;
  /** Home directory override (tests). Defaults to `os.homedir()`. */
  home?: string;
  /** File-existence check override (tests). Defaults to `fs.existsSync`. */
  exists?: (p: string) => boolean;
  /** File-read override (tests). Defaults to `fs.readFileSync` as utf8. */
  readFile?: (p: string) => string;
}

/** Config precedence: `SPACE_URL` / `SPACE_TOKEN` env vars override the config file. */
export function resolveConfig(opts: ResolveConfigOptions): ResolvedConfig {
  const home = opts.home ?? os.homedir();
  const exists = opts.exists ?? fs.existsSync;
  const readFile =
    opts.readFile ??
    ((p: string) => fs.readFileSync(p, { encoding: 'utf8' }) as unknown as string);

  let url = opts.env.SPACE_URL?.trim();
  let token = opts.env.SPACE_TOKEN?.trim();

  const file = configFilePath(home);
  if ((!url || !token) && exists(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFile(file));
    } catch (e) {
      throw new SpaceCliError(
        'config-error',
        `failed to parse config file ${file}: ${errorDetail(e)}`,
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SpaceCliError(
        'config-error',
        `config file ${file} must be a JSON object like { "url": ..., "token": ... }`,
      );
    }
    const record = parsed as Record<string, unknown>;
    if (!url && typeof record.url === 'string') url = record.url.trim();
    if (!token && typeof record.token === 'string') token = record.token.trim();
  }

  if (!url || !token) {
    const missing: string[] = [];
    if (!url) missing.push('Space URL (set SPACE_URL env var or "url" in the config file)');
    if (!token) missing.push('Space token (set SPACE_TOKEN env var or "token" in the config file)');
    throw new SpaceCliError('config-error', `missing configuration: ${missing.join('; ')}`);
  }

  // url and token are both defined here (missing would have thrown above).
  const finalUrl: string = url;
  const finalToken: string = token;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(finalUrl);
  } catch {
    throw new SpaceCliError('config-error', `Space URL is not a valid URL: ${finalUrl}`);
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new SpaceCliError(
      'config-error',
      `Space URL must use https (tokens must not travel in plaintext): ${finalUrl}`,
    );
  }

  return { url: finalUrl, token: finalToken };
}

export function configFilePath(home: string): string {
  return path.join(home, '.config', 'space-cli', 'config.json');
}

function errorDetail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
