#!/usr/bin/env node
import { run } from '../cli.js';

const code = await run(process.argv.slice(2), {
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
});
process.exit(code);
