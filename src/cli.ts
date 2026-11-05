import { Command, CommanderError } from 'commander';
import { resolveConfig } from './lib/config.js';
import { SpaceCliError } from './lib/errors.js';
import { SpaceClient } from './lib/http.js';
import { getReview } from './lib/reviews.js';

export interface RunIo {
  /** Environment variables (usually `process.env`). */
  env: Record<string, string | undefined>;
  /** Home directory override (tests). Defaults to `os.homedir()`. */
  home?: string;
  /** Write a string to stdout. */
  stdout: (s: string) => void;
  /** Write a string to stderr. */
  stderr: (s: string) => void;
}

/**
 * Run the CLI with explicit argv (no leading node/script args).
 * Returns the process exit code. Never touches the real stdout/stderr/env.
 */
export async function run(argv: string[], io: RunIo): Promise<number> {
  const program = new Command();
  program
    .name('space-cli')
    .description('Read, answer, and resolve JetBrains Space code review comments')
    .version('0.1.0')
    .option('--pretty', 'pretty-print JSON output (default: one compact line)');

  // Errors are data: suppress commander's human-readable stderr output and
  // emit a JSON envelope instead. Help/version go to stdout unaffected.
  program.configureOutput({
    writeOut: io.stdout,
    writeErr: () => {},
  });
  program.exitOverride();

  const reviews = program.command('reviews');
  reviews
    .command('show')
    .description('Get a single code review by record id')
    .argument('<reviewId>', 'review record id (e.g. 2AomjG0QgoiG)')
    .requiredOption('--project <key>', 'project key (e.g. IJ) or project id')
    .action(async (reviewId: string, options: { project: string }) => {
      const config = resolveConfig({ env: io.env, home: io.home });
      const client = new SpaceClient(config.url, config.token);
      const review = await getReview(client, options.project, reviewId);
      const pretty = program.opts<{ pretty?: boolean }>().pretty ?? false;
      io.stdout(`${JSON.stringify(review, null, pretty ? 2 : undefined)}\n`);
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) {
      // --help/--version exit 0; a bare invocation with subcommands shows
      // help too, but with exit code 1 — honor commander's decision.
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version') {
        return e.exitCode;
      }
      emitError(io, new SpaceCliError('usage-error', e.message));
      return 1;
    }
    emitError(io, toSpaceCliError(e));
    return 1;
  }
}

function emitError(io: RunIo, error: SpaceCliError): void {
  io.stderr(`${JSON.stringify(error.toEnvelope())}\n`);
}

function toSpaceCliError(e: unknown): SpaceCliError {
  if (e instanceof SpaceCliError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new SpaceCliError('unexpected-error', message);
}
