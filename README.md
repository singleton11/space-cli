# space-cli

A narrow-scope CLI that lets coding agents read, answer, and resolve JetBrains Space
code review comments — with precise line anchors and diff context so agents know
exactly *which* code is commented and can act on it.

Machine-first: **JSON on stdout, JSON error envelope on stderr, non-zero exit on failure.**

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

## Commands (v1 scope — M1 implements `reviews show`)

```
space-cli reviews list [--project KEY] [--repo NAME] [--state STATE] …   (M2)
space-cli reviews show <reviewId> --project KEY                          (M1 ✅)
space-cli comments list --review <reviewId> …                            (M2)
space-cli comments reply --comment <commentId> (--text "…" | --stdin)     (M4)
space-cli comments resolve --comment <commentId>                         (M4)
space-cli comments unresolve --comment <commentId>                       (M4)
```

`--project` takes the project **key** (e.g. `key:IJ`) or project id. `--pretty`
indents JSON output.

```sh
space-cli reviews show 2AomjG0QgoiG --project key:IJ
```

```json
{
  "id": "2AomjG0QgoiG",
  "kind": "mergeRequest",
  "number": 233811,
  "title": "spa/diff/moved-blocks-links",
  "state": "Opened",
  "createdAt": 1793883024163,
  "feedChannelId": "3kHOfT3MaKzo",
  "repository": "ultimate",
  "sourceBranch": "spa/diff/moved-blocks-links",
  "targetBranch": "vcs-smart-diff",
  "authors": ["1kkPrV2CjbGH"],
  "reviewers": [],
  "discussionCounter": { "resolved": 0, "unresolved": 0, "unresolvedSuggestedEdits": 0, "acceptedSuggestedEdits": 0, "rejectedSuggestedEdits": 0 },
  "commits": [{ "repositoryId": "2gCefs2ORyRU", "commitId": "…" }]
}
```

`kind` is `mergeRequest` or `commitSetReview`. For commit-set reviews
`repository`/`sourceBranch`/`targetBranch` are `null` (the repo is per-file there).
`authors`/`reviewers` are Space **profile ids**.

## Error envelope

Every failure is one JSON object on stderr + non-zero exit. Space API error codes
(`not-found`, `request-error`, `validation-error`, `internal-server-error`, …)
pass through verbatim, with the HTTP status attached:

```json
{ "error": "not-found", "error_description": "Review nonexistent-id not found in project key:IJ", "status": 404 }
```

CLI-internal codes: `config-error`, `usage-error`, `network-error`, `http-error`
(non-JSON error body), `protocol-error` (unexpected API shape — drift signal),
`unexpected-error`.

## Known platform limitation (pinned in Step 0)

Space's public REST API can resolve **review-level** comments only.
**Anchored (file/line) discussions have no resolve API** — the web UI uses a
private websocket protocol. `comments resolve` will support review-level comments
and return a documented platform-limitation error for anchored ones. It will not
fake success.

## Layout

- `src/lib/` — core logic (config, HTTP client, review mapping). Kept
  framework-free so a future MCP wrapper is trivial.
- `src/cli.ts` — commander wiring; `run(argv, io)` is fully injectable for tests.
- `fixtures/` — real API responses captured in the Step 0 spike; used as golden
  tests to catch API drift.
- `docs/api-notes.md` — pinned endpoints, field names, and quirks.
- `PLAN.md` — the project plan and milestone status.
