import { describe, expect, it } from 'vitest';
import { configFilePath, resolveConfig } from '../../src/lib/config.js';
import { SpaceCliError } from '../../src/lib/errors.js';

const NO_HOME = '/nonexistent-home';
const ENV_URL = { SPACE_URL: 'https://env.example.com' };
const ENV_TOKEN = { SPACE_TOKEN: 'env-token' };

function makeFs(files: Record<string, string>) {
  return {
    exists: (p: string) => p in files,
    readFile: (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT: ${p}`);
      return files[p]!;
    },
  };
}

describe('resolveConfig precedence', () => {
  it('env vars win over the config file', () => {
    const fs = makeFs({
      [configFilePath(NO_HOME)]: JSON.stringify({
        url: 'https://file.example.com',
        token: 'file-token',
      }),
    });
    const config = resolveConfig({
      env: { ...ENV_URL, ...ENV_TOKEN },
      home: NO_HOME,
      ...fs,
    });
    expect(config).toEqual({ url: 'https://env.example.com', token: 'env-token' });
  });

  it('falls back to the config file when env vars are absent', () => {
    const fs = makeFs({
      [configFilePath(NO_HOME)]: JSON.stringify({
        url: 'https://file.example.com',
        token: 'file-token',
      }),
    });
    const config = resolveConfig({ env: {}, home: NO_HOME, ...fs });
    expect(config).toEqual({ url: 'https://file.example.com', token: 'file-token' });
  });

  it('merges per field: env url + file token', () => {
    const fs = makeFs({
      [configFilePath(NO_HOME)]: JSON.stringify({
        url: 'https://file.example.com',
        token: 'file-token',
      }),
    });
    const config = resolveConfig({ env: { ...ENV_URL }, home: NO_HOME, ...fs });
    expect(config).toEqual({ url: 'https://env.example.com', token: 'file-token' });
  });

  it('merges per field: file url + env token', () => {
    const fs = makeFs({
      [configFilePath(NO_HOME)]: JSON.stringify({ url: 'https://file.example.com' }),
    });
    const config = resolveConfig({ env: { ...ENV_TOKEN }, home: NO_HOME, ...fs });
    expect(config).toEqual({ url: 'https://file.example.com', token: 'env-token' });
  });

  it('uses env only when no config file exists', () => {
    const config = resolveConfig({
      env: { ...ENV_URL, ...ENV_TOKEN },
      home: NO_HOME,
      exists: () => false,
      readFile: () => {
        throw new Error('must not be called');
      },
    });
    expect(config).toEqual({ url: 'https://env.example.com', token: 'env-token' });
  });

  it('trims whitespace from env values', () => {
    const config = resolveConfig({
      env: { SPACE_URL: '  https://env.example.com  ', SPACE_TOKEN: ' tok \n' },
      home: NO_HOME,
    });
    expect(config).toEqual({ url: 'https://env.example.com', token: 'tok' });
  });
});

describe('resolveConfig errors', () => {
  it('missing url and token -> config-error mentioning both', () => {
    expect(() => resolveConfig({ env: {}, home: NO_HOME })).toThrowError(SpaceCliError);
    try {
      resolveConfig({ env: {}, home: NO_HOME });
      expect.unreachable();
    } catch (e) {
      const err = e as SpaceCliError;
      expect(err.code).toBe('config-error');
      expect(err.description).toContain('SPACE_URL');
      expect(err.description).toContain('SPACE_TOKEN');
    }
  });

  it('missing token only -> config-error mentioning the token', () => {
    try {
      resolveConfig({ env: { ...ENV_URL }, home: NO_HOME });
      expect.unreachable();
    } catch (e) {
      expect((e as SpaceCliError).description).toContain('SPACE_TOKEN');
      expect((e as SpaceCliError).description).not.toContain('SPACE_URL');
    }
  });

  it('invalid JSON in the config file -> config-error', () => {
    const fs = makeFs({ [configFilePath(NO_HOME)]: '{oops' });
    expect(() =>
      resolveConfig({ env: {}, home: NO_HOME, ...fs }),
    ).toThrowError(/failed to parse config file/);
  });

  it('non-object config file -> config-error', () => {
    const fs = makeFs({ [configFilePath(NO_HOME)]: '["url"]' });
    expect(() => resolveConfig({ env: {}, home: NO_HOME, ...fs })).toThrowError(
      /must be a JSON object/,
    );
  });

  it('non-https url -> config-error', () => {
    expect(() =>
      resolveConfig({
        env: { SPACE_URL: 'http://insecure.example.com', ...ENV_TOKEN },
        home: NO_HOME,
      }),
    ).toThrowError(/must use https/);
  });

  it('garbage url -> config-error', () => {
    expect(() =>
      resolveConfig({ env: { SPACE_URL: 'not a url', ...ENV_TOKEN }, home: NO_HOME }),
    ).toThrowError(/not a valid URL/);
  });
});
