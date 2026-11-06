#!/usr/bin/env node
import { run } from '../cli.js';
import { SpaceCliError } from '../lib/errors.js';

const code = await run(process.argv.slice(2), {
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  stdin: async () => {
    if (process.stdin.isTTY) {
      // Reading a terminal would block forever waiting for EOF — force piping.
      throw new SpaceCliError(
        'usage-error',
        '--stdin: stdin is a terminal; pipe the reply text instead, e.g. `printf "%s" "text" | space-cli comments reply ... --stdin`',
      );
    }
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  },
});
process.exit(code);
