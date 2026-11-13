import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { homedir } from 'node:os';
import packageJson from '../package.json' with { type: 'json' };
import { resolveConfig } from './lib/config.js';
import { SpaceCliError } from './lib/errors.js';
import { SpaceClient } from './lib/http.js';
import { listComments } from './lib/comments.js';
import { replyToComment, setCommentResolved } from './lib/mutations.js';
import { DEFAULT_LIST_LIMIT, getReview, listReviews } from './lib/reviews.js';
import { submitReviewDecision, type ReviewDecision } from './lib/review-decisions.js';
import { agentSkillDir, installSkill } from './lib/skill.js';

export interface RunIo {
  /** Environment variables (usually `process.env`). */
  env: Record<string, string | undefined>;
  /** Home directory override (tests). Defaults to `os.homedir()`. */
  home?: string;
  /** Write a string to stdout. */
  stdout: (s: string) => void;
  /** Write a string to stderr. */
  stderr: (s: string) => void;
  /** Read all of stdin until EOF (used by `comments reply --stdin`). */
  stdin?: () => Promise<string>;
}

const PROJECT_HELP = 'project key (e.g. IJ); prefix with id: to use a raw project id';

/**
 * Run the CLI with explicit argv (no leading node/script args).
 * Returns the process exit code. Never touches the real stdout/stderr/env.
 */
export async function run(argv: string[], io: RunIo): Promise<number> {
  const program = new Command();
  program
    .name('space-cli')
    .description('Read, answer, and resolve JetBrains Space code review comments')
    .version(packageJson.version)
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
    .requiredOption('--project <key>', PROJECT_HELP)
    .action(async (reviewId: string, options: { project: string }) => {
      const config = resolveConfig({ env: io.env, home: io.home });
      const client = new SpaceClient(config.url, config.token);
      const review = await getReview(client, options.project, reviewId);
      emitJson(io, program, review);
    });
  reviews
    .command('list')
    .description('List code reviews in a project, newest activity first (server default sort)')
    .requiredOption('--project <key>', PROJECT_HELP)
    .option('--repo <name>', 'only reviews in this repository')
    .addOption(
      new Option('--state <state>', 'only reviews in this state')
        .choices(['Opened', 'Closed', 'RequiresAuthorAttention', 'NeedsReview', 'Merged']),
    )
    .option('--author <profileId>', 'only reviews authored by this profile id')
    .option('--reviewer <profileId>', 'only reviews with this reviewer profile id')
    .option('--text <query>', 'only reviews whose title matches this text query')
    .option('--limit <n>', `max reviews to return (default ${DEFAULT_LIST_LIMIT})`, parsePositiveInt, DEFAULT_LIST_LIMIT)
    .action(async (options: ReviewsListOptions) => {
      const config = resolveConfig({ env: io.env, home: io.home });
      const client = new SpaceClient(config.url, config.token);
      const result = await listReviews(client, options.project, {
        state: options.state,
        text: options.text,
        author: options.author,
        reviewer: options.reviewer,
        repository: options.repo,
      }, options.limit);
      emitJson(io, program, result);
    });

  for (const [decision, description] of [
    ['accept', 'Accept changes; new changes may reset the approval'],
    ['accept-and-finalize', 'Accept and finalize approval; new changes do not reset it'],
    ['request-changes', 'Request changes and wait for the author'],
  ] as const satisfies ReadonlyArray<readonly [ReviewDecision, string]>) {
    reviews
      .command(decision)
      .description(`${description}. Acts immediately as the token owner.`)
      .argument('<reviewId>', 'review record id')
      .requiredOption('--project <key>', PROJECT_HELP)
      .action(async (reviewId: string, options: { project: string }) => {
        const config = resolveConfig({ env: io.env, home: io.home });
        const client = new SpaceClient(config.url, config.token);
        emitJson(io, program, await submitReviewDecision(client, options.project, reviewId, decision));
      });
  }

  const comments = program.command('comments');
  comments
    .command('list')
    .description(
      'List comment threads of a review (anchored file/line comments and review-level comments), ' +
        'oldest first. Each item carries its anchor, snippet, and replies. ' +
        'Line numbers are 1-based. "outdated": false guarantees the commented file is unchanged ' +
        'at the review head, so anchor lines are exact; true means it changed since the comment ' +
        '(locate the code by snippet text); null for review-level comments.',
    )
    .requiredOption('--review <reviewId>', 'review record id')
    .requiredOption('--project <key>', PROJECT_HELP)
    .option('--file <path>', 'only anchored comments on this exact file path')
    .option('--author <user>', 'only threads whose root comment author (username) matches exactly')
    .option('--unresolved', 'only unresolved threads')
    .option(
      '--diff-context <lines>',
      'add anchor.diffContext: the file as of the comment\'s revision, this many lines around the anchor',
      parseNonNegativeInt,
    )
    .action(async (options: CommentsListOptions) => {
      const config = resolveConfig({ env: io.env, home: io.home });
      const client = new SpaceClient(config.url, config.token);
      const result = await listComments(
        client,
        options.project,
        options.review,
        { file: options.file, author: options.author, unresolved: options.unresolved },
        { diffContext: options.diffContext },
      );
      emitJson(io, program, { reviewId: options.review, comments: result });
    });

  comments
    .command('reply')
    .description(
      'Post a reply into a comment thread. Replies are flat: Space threads are chat ' +
        'channels, so there is no parent-message id — the text is appended to the thread. ' +
        'For review-level comments the thread channel is the whole review channel. ' +
        'The message is posted as the token owner. NO GUARDRAILS: no confirmation, no dry-run, no undo.',
    )
    .requiredOption('--comment <commentId>', 'comment (discussion) id from `comments list` output')
    .requiredOption('--review <reviewId>', 'review record id the comment belongs to')
    .requiredOption('--project <key>', PROJECT_HELP)
    .option('--text <text>', 'reply text')
    .option('--stdin', 'read the reply text from stdin instead of --text (a single trailing newline is stripped)')
    .action(async (options: ReplyOptions) => {
      const text = await readReplyText(options, io);
      const config = resolveConfig({ env: io.env, home: io.home });
      const client = new SpaceClient(config.url, config.token);
      const result = await replyToComment(client, options.project, options.review, options.comment, text);
      emitJson(io, program, result);
    });

  comments
    .command('resolve')
    .description(
      'Mark a review-level comment thread as resolved (Space resolves whole threads, not single messages; ' +
        'state is verified by reading the thread back). PLATFORM LIMITATION: anchored (file/line) threads ' +
        'cannot be resolved through the Space public REST API — for them this fails with error code ' +
        '"platform-limitation"; reply to the thread instead, or resolve it in the Space web UI. ' +
        'NO GUARDRAILS: no confirmation, no dry-run, no undo.',
    )
    .requiredOption('--comment <commentId>', 'comment (discussion) id from `comments list` output')
    .requiredOption('--review <reviewId>', 'review record id the comment belongs to')
    .requiredOption('--project <key>', PROJECT_HELP)
    .action(async (options: MutationOptions) => {
      const config = resolveConfig({ env: io.env, home: io.home });
      const client = new SpaceClient(config.url, config.token);
      const result = await setCommentResolved(client, options.project, options.review, options.comment, true);
      emitJson(io, program, result);
    });

  comments
    .command('unresolve')
    .description(
      'Reopen a previously resolved review-level comment thread (the inverse of `resolve`, same ' +
        'platform limitation for anchored threads and same no-guardrails policy).',
    )
    .requiredOption('--comment <commentId>', 'comment (discussion) id from `comments list` output')
    .requiredOption('--review <reviewId>', 'review record id the comment belongs to')
    .requiredOption('--project <key>', PROJECT_HELP)
    .action(async (options: MutationOptions) => {
      const config = resolveConfig({ env: io.env, home: io.home });
      const client = new SpaceClient(config.url, config.token);
      const result = await setCommentResolved(client, options.project, options.review, options.comment, false);
      emitJson(io, program, result);
    });

  const skill = program.command('skill');
  skill
    .command('install')
    .description(
      'Install the bundled agent skill (space-cli workflows, pitfalls, output contract) into a ' +
        'coding agent\'s global skills directory, as <dir>/space-cli/SKILL.md. ' +
        'Re-running without --force fails with a usage-error if the skill is already there.',
    )
    .addOption(
      new Option('--agent <agent>', 'agent whose global skills directory to install into')
        .choices(['pi', 'claude'])
        .default('pi'),
    )
    .option('--dir <path>', 'install into this skills directory instead of the agent default')
    .option('--force', 'overwrite an already-installed skill')
    .action(async (options: SkillInstallOptions) => {
      const home = io.home ?? homedir();
      const dir = options.dir ?? agentSkillDir(options.agent, home);
      const result = installSkill({ dir, force: options.force });
      emitJson(io, program, result);
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

interface ReviewsListOptions {
  project: string;
  repo?: string;
  state?: string;
  author?: string;
  reviewer?: string;
  text?: string;
  limit: number;
}

interface CommentsListOptions {
  review: string;
  project: string;
  file?: string;
  author?: string;
  unresolved?: boolean;
  diffContext?: number;
}

interface ReplyOptions {
  comment: string;
  review: string;
  project: string;
  text?: string;
  stdin?: boolean;
}

interface MutationOptions {
  comment: string;
  review: string;
  project: string;
}

interface SkillInstallOptions {
  agent: string;
  dir?: string;
  force?: boolean;
}

/** Exactly one of --text / --stdin; the text must be non-empty. */
async function readReplyText(options: ReplyOptions, io: RunIo): Promise<string> {
  if (options.stdin === true && options.text !== undefined) {
    throw new SpaceCliError('usage-error', '--text and --stdin are mutually exclusive');
  }
  let text: string;
  if (options.stdin === true) {
    if (io.stdin === undefined) {
      throw new SpaceCliError('usage-error', '--stdin: no stdin source is available');
    }
    text = (await io.stdin()).replace(/\r?\n$/, '');
  } else if (options.text !== undefined) {
    text = options.text;
  } else {
    throw new SpaceCliError('usage-error', 'exactly one of --text or --stdin is required');
  }
  if (text.trim() === '') {
    throw new SpaceCliError('usage-error', 'reply text must not be empty');
  }
  return text;
}

function parsePositiveInt(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError('must be a positive integer');
  }
  return n;
}

function parseNonNegativeInt(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError('must be a non-negative integer');
  }
  return Number.parseInt(value, 10);
}

function emitJson(io: RunIo, program: Command, value: unknown): void {
  const pretty = program.opts<{ pretty?: boolean }>().pretty ?? false;
  io.stdout(`${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`);
}

function emitError(io: RunIo, error: SpaceCliError): void {
  io.stderr(`${JSON.stringify(error.toEnvelope())}\n`);
}

function toSpaceCliError(e: unknown): SpaceCliError {
  if (e instanceof SpaceCliError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new SpaceCliError('unexpected-error', message);
}
