# space-cli

A narrow-scope CLI that lets coding agents read, answer, and resolve JetBrains Space
code review comments — with precise line anchors and diff context so agents know
exactly *which* code is commented and can act on it.

Machine-first: **JSON on stdout, JSON error envelope on stderr, exit code 0 on
success and 1 on every failure.** This README is the complete agent reference:
every command's output schema, the error contract, and a full worked example.

## Setup

```sh
npm install       # dependencies
npm run build     # TypeScript -> dist/
npm test          # unit + golden tests (fixtures/ from the Step 0 API spike)
```

## Configuration

`SPACE_URL` / `SPACE_TOKEN` env vars override `~/.config/space-cli/config.json`:

```json
{ "url": "https://jetbrains.team", "token": "…" }
```

The token needs Space read + write scopes (replies post as the token owner's identity).
The URL must be `https`.

## Output contract

Every successful command prints **exactly one JSON value** to stdout (a single
compact line by default; indented with the global `--pretty` flag) and exits `0`.
Every failure prints **nothing to stdout**, prints one JSON error envelope to
stderr, and exits `1`. There is no third state — parse stdout only when the exit
code is 0.

### Exit codes

| Exit | Meaning |
|---|---|
| `0` | Success (also `--help` / `--version`) |
| `1` | Every failure: config, usage, network, Space API, protocol drift |

`--help` and `--version` print human-readable text to stdout and exit `0`; a bare
`space-cli` invocation prints help with exit `1` (commander's decision).

### Error envelope

```json
{ "error": "<code>", "error_description": "<human-readable>", "status": 404 }
```

`status` (HTTP status) is present only when the error originated from the Space
API. Codes:

| Code | Origin | Meaning |
|---|---|---|
| `not-found`, `request-error`, `validation-error`, `internal-server-error`, … | Space | Pass through Space's own error codes verbatim, with `status` attached |
| `config-error` | CLI | Missing/invalid `SPACE_URL`/`SPACE_TOKEN` or config file |
| `usage-error` | CLI | Bad arguments (missing required option, mutually exclusive options, empty reply text) |
| `network-error` | CLI | DNS/connection failure before any HTTP response |
| `http-error` | CLI | Non-2xx response whose body is not JSON (unparsed error page) |
| `protocol-error` | CLI | 2xx response with an unexpected shape — **API drift signal**, report it |
| `platform-limitation` | CLI | The Space public REST API cannot do this (anchored-thread resolve) |
| `unexpected-error` | CLI | Anything else (a bug) |

A Space 404 for a missing review arrives as `{"error":"not-found", …}` **without**
`status` — Space returns HTTP 200 with a `null` body there and the CLI maps it.
Trust `error`, not the presence of `status`.

## Command reference

`--project` takes the project **key** (e.g. `IJ`, the thing Space URLs expose);
the CLI prefixes it with `key:` automatically. Escape hatches: `--project key:XX`
passes through untouched, `--project id:<raw-project-id>` forces the id
interpretation.

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

Mutations need `--review`/`--project` alongside `--comment` because Space exposes
no get-discussion-by-id endpoint — the CLI locates the comment by walking the
review's discovery surfaces (the same ones `comments list` uses).

### `reviews show` → `Review`

```sh
space-cli reviews show 4UFkjw4bqG4W --project IJ
```

```json
{
  "id": "4UFkjw4bqG4W",
  "kind": "mergeRequest",
  "number": 164790,
  "title": "[vcs] IJPL-171659 Implement new option in the advanced settings",
  "state": "Closed",
  "createdAt": 1748963480286,
  "feedChannelId": "2rjtBN2yJyE8",
  "repository": "ultimate",
  "sourceBranch": "spa/show-branch-option",
  "targetBranch": "master",
  "authors": ["1kkPrV2CjbGH"],
  "reviewers": [],
  "discussionCounter": { "resolved": 1, "unresolved": 0, "unresolvedSuggestedEdits": 0, "acceptedSuggestedEdits": 0, "rejectedSuggestedEdits": 0 },
  "commits": [{ "repositoryId": "2gCefs2ORyRU", "commitId": "1d2a3f46…" }]
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | Stable record id — the `reviewId` other commands take |
| `kind` | `"mergeRequest"` \| `"commitSetReview"` | |
| `number` | number \| null | Human-visible review number |
| `state` | string \| null | `Opened` `Closed` `RequiresAuthorAttention` `NeedsReview` `Merged` |
| `createdAt` | number \| null | Epoch ms |
| `feedChannelId` | string \| null | Review timeline channel (review-level threads live here) |
| `repository`, `sourceBranch`, `targetBranch` | string \| null | **null for commit-set reviews** (repo is per-file there) |
| `authors`, `reviewers` | string[] | Space **profile ids**, not usernames |
| `discussionCounter` | object \| null | Live thread counters — `unresolved` is the number to work down |
| `commits` | array | `{repositoryId, commitId}` |

### `reviews list` → `ReviewListResult`

Filters: `--repo` (repository name), `--state` (as above), `--author`/`--reviewer`
(profile ids), `--text` (title query), `--limit N` (default 25). Sort is the
server default (newest activity first).

```json
{
  "totalCount": 12443,
  "reviews": [
    {
      "id": "28VGXs1sUE8g",
      "kind": "commitSetReview",
      "number": 29538,
      "title": "[IDEA-CR-1497] enable slow findClass in parameter info …",
      "state": "Opened",
      "createdAt": null,
      "repository": null,
      "sourceBranch": null,
      "targetBranch": null,
      "discussionCounter": { "resolved": 0, "unresolved": 1, "unresolvedSuggestedEdits": 0, "acceptedSuggestedEdits": 0, "rejectedSuggestedEdits": 0 }
    }
  ]
}
```

`totalCount` is the number of reviews matching the **filters**, independent of
`--limit` — use it to detect truncation. List items are the `Review` schema minus
`feedChannelId`/`authors`/`reviewers`/`commits` (call `reviews show` for those).
`createdAt` is null for commit-set reviews that report `0` in list responses.

### `comments list` → thread list

```sh
space-cli comments list --review 4UFkjw4bqG4W --project IJ --unresolved --diff-context 5
```

Emits `{"reviewId": "<id>", "comments": [...]}`, oldest first. **Each item is a
thread**: the root comment plus its replies. Filters: `--file` (exact path,
leading `/` tolerated), `--author` (root comment author, username, exact match),
`--unresolved`.

```json
{
  "reviewId": "4UFkjw4bqG4W",
  "comments": [
    {
      "id": "44NiBZ2XKfeH",
      "reviewId": "4UFkjw4bqG4W",
      "threadChannelId": "1o2Vt11z75WI",
      "kind": "anchored",
      "author": "Ilia.Shulgin",
      "createdAt": 1749133884500,
      "text": "Redundant declaration",
      "resolved": true,
      "outdated": true,
      "anchor": {
        "file": "community/plugins/git4idea/src/git4idea/repo/GitRecentProjectsBranchesProvider.kt",
        "repository": "ultimate",
        "line": 56,
        "oldLine": null,
        "revision": "c064d95b4df050cacc39e9882d4226506de0f0ca",
        "end": null,
        "snippet": [
          { "text": "  };", "oldLineNum": null, "newLineNum": 54 },
          { "text": "", "oldLineNum": null, "newLineNum": 55 },
          { "text": "  abstract override fun toString(): String", "oldLineNum": null, "newLineNum": 56 }
        ],
        "diffContext": {
          "revision": "c064d95b4df050cacc39e9882d4226506de0f0ca",
          "side": "new",
          "lines": [{ "line": 56, "text": "  abstract override fun toString(): String" }]
        }
      },
      "replies": [
        { "id": "BwX7e0VKLda", "author": "Stanislau.Palyn", "createdAt": 1749135728765, "text": "User resolved the discussion" }
      ]
    }
  ]
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | Discussion id — **the `--comment` value for reply/resolve** |
| `threadChannelId` | string \| null | Chat channel backing the thread (review-level threads use the review's feed channel) |
| `kind` | `"anchored"` \| `"review-level"` | Review-level comments discuss the whole review (`anchor` is null) |
| `author` | string \| null | Principal **username** (e.g. `Ilia.Shulgin`) |
| `createdAt` | number \| null | Epoch ms of the root comment |
| `resolved` | boolean | **Live whole-thread state** — Space resolves threads, not single messages |
| `outdated` | boolean \| null | See below |
| `anchor` | object \| null | Present for anchored comments |
| `replies` | array | Chronological `{id, author, createdAt, text}` after the root |

**Anchor fields** — all line numbers are **1-based** (editor / `grep -n` numbering;
Space itself counts from 0, the CLI converts):

| Field | Type | Notes |
|---|---|---|
| `file` | string | Path with Space's leading `/` normalized away |
| `line` | number \| null | Right-side (new file) line; `null` for left-side anchors |
| `oldLine` | number \| null | Left-side (old file) line — set when the comment is on a deleted line, then `line` is null |
| `revision` | string \| null | Commit of the side the anchor points into |
| `end` | object \| null | Multi-line range comment: `{line, oldLine, revision}` of its last line (may end on the other diff side); null for single-line |
| `snippet` | array | Space's built-in snippet (what the reviewer saw): `{text, oldLineNum, newLineNum}` — numbers are 1-based, nulls on context-only lines. **Lossy**: modified lines carry only their new text, so an old-side number can pair with text that isn't in the old file; `diffContext` is the ground truth |
| `diffContext` | object \| null | **Only with `--diff-context N`**: the file at `revision`, N lines around the anchor (widened over a range), `{revision, side: "new"\|"old", lines: [{line, text}]}`. `null` for binary/missing files |

**`outdated` is computed, not stored**: the CLI compares the commented file's git
blob at the anchor's revision against the current review head (review base, for
left-side anchors).

- `false` is a **guarantee**: the file is byte-identical at head, so the anchor's
  line numbers are exact today — you can jump straight to `file:line` in your checkout.
- `true`: the file changed, moved, or was deleted since the comment — locate the
  code by its `snippet`/`diffContext` text instead of trusting line numbers.
- `null` for review-level comments.

`--diff-context N` costs one extra request per distinct file revision (~350 ms
each, run in parallel). Snippets are always included; `--diff-context` is the
opt-in ground-truth upgrade.

### `comments reply` → `ReplyResult`

```sh
space-cli comments reply --comment 44NiBZ2XKfeH --review 4UFkjw4bqG4W \
    --project IJ --text "Removed the redundant declaration in aabc123."
# or: ... --stdin <<< "$reply_text"
```

Exactly one of `--text` / `--stdin` is required (`--stdin` reads until EOF and
strips a single trailing newline; empty text is a `usage-error`). Output:

```json
{
  "commentId": "44NiBZ2XKfeH",
  "reviewId": "4UFkjw4bqG4W",
  "threadChannelId": "1o2Vt11z75WI",
  "message": { "id": "msg-1", "text": "Removed the redundant declaration…", "author": "Anton.Prokhorov", "createdAt": 1793800000000 }
}
```

`message` is what Space reported; any field may be `null` if Space's send
response is lean (the reply is still posted — the command exited 0).

### `comments resolve` / `unresolve` → `ResolveResult`

```sh
space-cli comments resolve --comment 3a5B6B3BkX8s --review 4UFkjw4bqG4W --project IJ
```

```json
{ "commentId": "3a5B6B3BkX8s", "reviewId": "4UFkjw4bqG4W", "resolved": true }
```

`resolved` is **read back from Space after the mutation** (the toggle endpoint
answers 200 with an empty body) — it is always Space's answer, never assumed.

### Mutations (reply / resolve / unresolve)

- **No guardrails.** Mutations run immediately: no confirmation, no dry-run,
  no undo. A reply is posted as the token owner and cannot be deleted through
  this CLI.
- Replies are **flat** — Space threads are chat channels; there is no
  parent-message id. Posting to the thread's channel IS the reply.
- Resolve applies to the **whole thread**.
- **Platform limitation:** anchored (file/line) threads **cannot be resolved
  through Space's public REST API** (the web UI uses a private websocket
  protocol). `resolve`/`unresolve` fail for them with exit 1 and error code
  `platform-limitation` — reply to the thread instead, or resolve it in the
  Space web UI. The CLI will not fake success.

```json
{
  "error": "platform-limitation",
  "error_description": "Comment 44NiBZ2XKfeH is an anchored (file/line) thread; the Space public REST API only supports resolving review-level threads. Reply to the thread instead, or resolve it in the Space web UI."
}
```

## End-to-end agent workflow

The contract this CLI exists for: given only a repository checkout, a review id,
and credentials in the environment, act on every review comment without opening
a web browser. Concretely:

**1. Triage the review.** Thread counters tell you how much work there is:

```sh
space-cli reviews show 4UFkjw4bqG4W --project IJ --pretty
# discussionCounter.unresolved == 0 → nothing to do, stop here
```

**2. Pull the unresolved threads with enough context to interpret them.**
`--diff-context 5` shows the code as the reviewer saw it, at the commented
revision — no git archaeology needed even if the local checkout has moved on:

```sh
space-cli comments list --review 4UFkjw4bqG4W --project IJ --unresolved --diff-context 5 --pretty
```

**3. For each thread, locate the code it refers to:**

- `outdated: false` → the anchor lines are exact today; open `anchor.file`,
  go to `anchor.line` (or `anchor.oldLine` for deleted-line comments) in your checkout.
- `outdated: true` → the file changed since the comment; find the code by
  matching `anchor.snippet` / `anchor.diffContext` text (e.g.
  `grep -n "abstract override fun toString" -r <file>`), not by line number.
- `kind: "review-level"` → the comment discusses the review as a whole; read `text`.

**4. Address it in the code, then reply** (the reply is appended to the thread,
posted as the token owner — say what you did and reference the commit):

```sh
space-cli comments reply --comment 44NiBZ2XKfeH --review 4UFkjw4bqG4W \
    --project IJ --text "Dropped the redundant declaration; the base class now provides toString()."
```

**5. Resolve what the API allows.** Review-level threads resolve directly:

```sh
space-cli comments resolve --comment 3a5B6B3BkX8s --review 4UFkjw4bqG4W --project IJ
# → {"commentId":"3a5B6B3BkX8s","reviewId":"4UFkjw4bqG4W","resolved":true}
```

Anchored threads will answer `platform-limitation` (exit 1). That is expected —
post a reply there and let the reviewer resolve it in the Space web UI; do not
retry.

**6. Verify:** re-run step 2; `resolved` counters in `reviews show` and
`resolved` flags per thread should now reflect the drop.

## Manual E2E checklist

Run against a real Space instance before calling a release done (all steps
read-only except the marked mutations — use your own closed review for those):

1. **Config:** with `SPACE_URL`/`SPACE_TOKEN` unset and no config file, any
   command exits 1 with a `config-error` envelope on stderr.
2. **`reviews show`:** a known merge request returns `kind: "mergeRequest"` with
   `repository`/`sourceBranch`/`targetBranch` set; a commit-set review returns
   `kind: "commitSetReview"` with those three null. A nonexistent id exits 1
   with `{"error":"not-found", …}` and **no** `status` field.
3. **`reviews list`:** `totalCount` ≥ number of returned items; `--state Opened`
   returns only `Opened` reviews.
4. **`comments list`:**
   - anchored thread: `anchor.line` matches the line number shown in the Space
     web UI snippet exactly (the UI counts from 1, the raw Space API from 0 —
     the CLI has already converted);
   - `--unresolved` returns only `resolved: false` threads;
   - `--file` returns only that path; `--author` only that root author;
   - deleted review-level messages do not appear as ghost threads.
5. **`--diff-context`:** the returned lines match `git show <anchor.revision>:<anchor.file>`
     around the anchor; a binary or deleted file yields `diffContext: null`, not an error.
6. **`outdated`:** pick a thread on a file you then change via a new push; re-list
     — `outdated` flips to `true` (anchors compare file blobs at revision vs head).
7. **`comments reply`** *(mutation)*: reply to a review-level thread with `--text`
     and to an anchored thread with `--stdin`; the message appears in the Space
     web UI as the token owner; `--text` + `--stdin` together exits 1 with
     `usage-error`.
8. **`comments resolve` / `unresolve`** *(mutation)*: resolve a review-level
     thread — the emitted `resolved` matches the thread state in the web UI;
     unresolve restores it. An anchored thread refuses with exit 1 and
     `platform-limitation`.
9. **Full agent scenario (the release gate):** from a fresh checkout with only
     the review id and env credentials, complete §*End-to-end agent workflow*
     steps 1–6 without ever opening a web browser for reading, and with web UI
     verification only for what the API cannot do (anchored resolve).

## Layout

- `src/lib/` — core logic (config, HTTP client, review/comment mapping, anchor
  enrichment). Kept framework-free so a future MCP wrapper is trivial.
- `src/cli.ts` — commander wiring; `run(argv, io)` is fully injectable for tests.
- `fixtures/` — real API responses captured in the Step 0 spike; used as golden
  tests to catch API drift.
- `docs/api-notes.md` — pinned endpoints, field names, and quirks.
- `PLAN.md` — the project plan and milestone status.
