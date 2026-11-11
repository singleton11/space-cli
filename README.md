# space-cli

A narrow-scope CLI that lets coding agents read, answer, and resolve JetBrains Space
code review comments — with precise line anchors and diff context so agents know
exactly *which* code is commented and can act on it.

Machine-first: **JSON on stdout, JSON error envelope on stderr, exit code 0 on
success and 1 on every failure.**

## Install

```sh
npm install -g jetbrains-space-cli
```

The npm package is `jetbrains-space-cli`; the command it installs is `space-cli`.
Or run it without installing:

```sh
npx jetbrains-space-cli --help
```

Requires Node 20+. From source: `npm install && npm run build`.

### Install the agent skill

The package bundles an agent skill (workflows, pitfalls, output contract) that teaches
coding agents how to use `space-cli`. Install it into your agent's global skills
directory:

```sh
space-cli skill install                # Pi agent: ~/.pi/agent/skills/space-cli/SKILL.md
space-cli skill install --agent claude # Claude Code: ~/.claude/skills/space-cli/SKILL.md
space-cli skill install --dir <path>   # any other skills directory
space-cli skill install --force       # overwrite after a CLI update
```

Output: `{"installed": "<path>", "overwritten": false}`. Re-running without
`--force` fails with a `usage-error` if the skill is already there.

## Configure

The CLI needs a Space URL and an API token. Either set environment variables:

```sh
export SPACE_URL="https://jetbrains.team"
export SPACE_TOKEN="…"
```

or put them in `~/.config/space-cli/config.json` (env vars win):

```json
{ "url": "https://jetbrains.team", "token": "…" }
```

The token needs Space read + write scopes (replies post as the token owner's
identity). The URL must be `https`. Missing or invalid credentials fail with
exit code 1 and a `config-error` envelope on stderr.

## Use

`--project` takes the project **key** (e.g. `IJ`). Pass `key:XX` or `id:<raw-id>`
to override that interpretation. Add `--pretty` to any command for indented output.

```
space-cli reviews list --project KEY [--repo NAME] [--state STATE]
                       [--author PROFILE_ID] [--reviewer PROFILE_ID]
                       [--text QUERY] [--limit N]                 # default 25
space-cli reviews show <reviewId> --project KEY
space-cli comments list --review <reviewId> --project KEY
                        [--file PATH] [--author USER] [--unresolved]
                        [--diff-context N]
space-cli comments reply --comment <commentId> --review <reviewId>
                        --project KEY (--text "…" | --stdin)
space-cli comments resolve --comment <commentId> --review <reviewId> --project KEY
space-cli comments unresolve --comment <commentId> --review <reviewId> --project KEY
```

### Output contract

Every success prints exactly one JSON value to stdout and exits `0`; every
failure prints nothing to stdout, one JSON error envelope to stderr, and exits `1`:

```json
{ "error": "<code>", "error_description": "<human-readable>", "status": 404 }
```

`status` (HTTP status) is present only for errors that originated from the Space
API. Codes: Space's own codes (`not-found`, `validation-error`, …) pass through
verbatim; CLI codes are `config-error`, `usage-error`, `network-error`,
`http-error`, `protocol-error` (API drift signal), `platform-limitation`, and
`unexpected-error` (a bug).

### Triage a review

```sh
space-cli reviews show 4UFkjw4bqG4W --project IJ --pretty
# discussionCounter.unresolved == 0 → nothing to do
```

### Read the comments

Each item in `comments list` is a **thread**: the root comment plus its replies,
oldest first.

```sh
space-cli comments list --review 4UFkjw4bqG4W --project IJ --unresolved --diff-context 5 --pretty
```

Key fields:

- `id` — discussion id; the `--comment` value for reply/resolve.
- `resolved` — live whole-thread state (Space resolves threads, not messages).
- `outdated` — **computed**: `false` guarantees the file is byte-identical at
  the review head, so the anchor's line numbers are exact today; `true` means
  the file changed — locate the code by `anchor.snippet`/`anchor.diffContext`
  text instead of line numbers.
- `anchor.file` / `anchor.line` / `anchor.oldLine` — where the comment points;
  line numbers are 1-based (`oldLine` is set for comments on deleted lines).
  `anchor` is null for review-level comments, which discuss the review as a whole.
- `anchor.diffContext` — only with `--diff-context N`: the file at the commented
  revision, N lines around the anchor — the ground truth even if the checkout
  has moved on. Costs ~350 ms per distinct file revision.

### Reply and resolve

```sh
space-cli comments reply --comment 44NiBZ2XKfeH --review 4UFkjw4bqG4W \
    --project IJ --text "Dropped the redundant declaration in aabc123."
# or: ... --stdin <<< "$reply_text"

space-cli comments resolve --comment 3a5B6B3BkX8s --review 4UFkjw4bqG4W --project IJ
# → {"commentId":"3a5B6B3BkX8s","reviewId":"4UFkjw4bqG4W","resolved":true}
```

Notes:

- **No guardrails.** Mutations run immediately: no confirmation, no dry-run,
  no undo. Replies post as the token owner and cannot be deleted through this CLI.
- Exactly one of `--text` / `--stdin` is required for reply.
- `resolved` in the output is read back from Space after the mutation, never assumed.
- **Platform limitation:** anchored (file/line) threads **cannot be resolved
  through Space's public REST API** — `resolve`/`unresolve` fail for them with
  error code `platform-limitation`. Reply to the thread instead, or resolve it
  in the Space web UI. The CLI will not fake success.

### Typical agent loop

1. `reviews show` → check `discussionCounter.unresolved`.
2. `comments list --unresolved --diff-context 5` → pull actionable threads.
3. Locate the code: `outdated: false` → jump to `anchor.file:anchor.line`;
   `outdated: true` → match by `snippet`/`diffContext` text.
4. Fix the code, then `comments reply` saying what you did.
5. `comments resolve` for review-level threads (anchored ones: reply and let
   the reviewer resolve in the web UI).
6. Re-run step 2 to verify the drop.

## Development

```sh
npm install && npm run build && npm test
```

- `src/lib/` — core logic, framework-free (a future MCP wrapper is trivial).
- `fixtures/` — real API responses; golden tests to catch API drift.
- `docs/api-notes.md` — pinned endpoints, field names, and quirks.
