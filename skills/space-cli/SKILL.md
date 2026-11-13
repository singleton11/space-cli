---
name: space-cli
description: Read and act on JetBrains Space code reviews and merge requests via the installed space-cli (REST API, machine-first JSON). List the user's reviews, read discussion threads with line anchors and diff context, reply to comments, resolve/unresolve threads. Use when the user asks about their Space code reviews, review comments, "any updates on my reviews", reviews needing their attention, addressing review feedback, or resolving threads. Covers jetbrains.team instances (e.g. AMPER-MR-3804, AMPER-CR-3842).
---

# JetBrains Space code reviews via space-cli

`space-cli` is a narrow-scope CLI for coding agents: machine-first JSON on stdout,
JSON error envelope on stderr, exit 0 on success / 1 on every failure.
It is installed globally on this host (`space-cli` on PATH) and configured with a
permanent token (reads + posts as the token owner's identity).

## When to use

- "Check my code reviews" / "anything new in my reviews?" / "reviews needing my attention"
- Reading review threads/comments, including which file+line each comment anchors to
- Replying to review comments, resolving/unresolving threads
- Any scripted/agent handling of a JetBrains Space review (jetbrains.team or another org's instance)

Do NOT use for merging or reading timeline events (commits added, approvals) —
space-cli has no commands for those.

## Setup check (30 seconds)

```sh
space-cli --version          # must print a version
space-cli reviews list --project <KEY> --limit 1   # config-error → fix config first
```

Config precedence: `SPACE_URL`/`SPACE_TOKEN` env vars override
`~/.config/space-cli/config.json` (`{ "url": "https://…", "token": "…" }`, mode 600).
URL must be https. If config is missing, ask the user for a Space permanent token
(read + write scopes) and write the file.

## Output contract (trust this, always)

- Exit 0 + exactly one JSON value on stdout (compact; `--pretty` indents) → parse it.
- Exit 1 + JSON error envelope on stderr, nothing on stdout → read `error` code.
- `--help`/`--version` print text, exit 0. Bare `space-cli` prints help, exit 1.
- Space 404 for a missing review arrives as `{"error":"not-found",…}` **without** a
  `status` field (Space returns HTTP 200 + `null` body there). Trust `error`, not `status`.
- Error codes to act on: `config-error` (fix setup), `usage-error` (your flags),
  `not-found` (wrong review id/project), `network-error`, `http-error`,
  `protocol-error` (API drift — report it), `platform-limitation` (REST can't do it),
  `unexpected-error` (CLI bug).

## Command reference

```sh
space-cli reviews list  --project KEY [--repo NAME] [--state Opened|Closed|RequiresAuthorAttention|NeedsReview|Merged] [--author PID] [--reviewer PID] [--text QUERY] [--limit N]
space-cli reviews show  <reviewId> --project KEY
space-cli reviews accept <reviewId> --project KEY
space-cli reviews accept-and-finalize <reviewId> --project KEY
space-cli reviews request-changes <reviewId> --project KEY
space-cli comments list  --review <reviewId> --project KEY [--unresolved] [--file PATH] [--author PID] [--diff-context N]
space-cli comments reply --comment <commentId> --review <reviewId> --project KEY --text "…"
space-cli comments resolve   --comment <commentId> --review <reviewId> --project KEY
space-cli comments unresolve --comment <commentId> --review <reviewId> --project KEY
```

`--project` is required everywhere. Bare keys are auto-prefixed `key:` (escape
hatches: `key:XX`, `id:XX`). Timestamps are epoch milliseconds.

Review decisions act immediately as the token owner. Only submit them when asked.
`accept-and-finalize` makes the approval sticky across later changes; it does not
merge or close the review. Success reports the submitted action, not a read-back.

## Workflow A: "anything new in my reviews?"

1. **Get the user's profile id** (filters take profile ids, not usernames):
   `curl -s -H "Authorization: Bearer $TOKEN" "$SPACE_URL/api/http/team-directory/profiles?query=<Username>&\$fields=data(id,name,username)"`
   (token/url from config file; or the JWT `sub` claim of the token).
2. **Find candidate projects** — there is NO cross-project review search in Space:
   - Starred projects (user's own picks): `GET /projects?starred=true&$fields=data(key(key),name)`
   - By name: `GET /projects?term=<word>&$fields=data(key(key),name)`
3. **List the user's reviews per project**:
   `space-cli reviews list --project <KEY> --author <PID> --limit 25` and
   `space-cli reviews list --project <KEY> --reviewer <PID> --limit 25`
4. **Triage by `discussionCounter`**: only reviews with `unresolved > 0` (or state
   `RequiresAuthorAttention`) need a closer look.
5. **Read unresolved threads**:
   `space-cli comments list --review <id> --project <KEY> --unresolved --diff-context 3 --pretty`
6. Judge what "requires attention": threads authored by *others* with no reply from
   the user, or replies to the user's comments. The user's own unresolved notes
   (cross-refs, test leftovers) are usually noise — say so, don't hide it.
7. Report per review: title, state, what's unresolved, who's waiting on whom.
   Offer cleanup (resolve/delete test threads) but don't act unasked.

## Workflow B: address feedback on a specific review

1. `space-cli reviews show <reviewId> --project KEY --pretty` (id from a URL like
   `jetbrains.team/p/amper/reviews/3842/timeline` → the number is NOT the id; find it
   via `reviews list --text <title-fragment>` if needed).
2. `space-cli comments list --review <reviewId> --project KEY --unresolved --diff-context 5 --pretty`
   — each comment carries `anchor.file`, `anchor.line` (1-based, `oldLine` for the
   deleted side), `snippet` (the commented lines), `diffContext` (surrounding code),
   `outdated` (true = the code moved after the comment), and `replies` (chronological).
3. To answer or fix-and-answer: push the fix (separate concern, ask the user), then
   `space-cli comments reply --comment <commentId> --review <reviewId> --project KEY --text "…"`
   — replies post flat into the thread, as the token owner.
4. Resolve only when explicitly asked: `space-cli comments resolve …`.

## Pitfalls

- **Anchored (file/line) threads CANNOT be resolved via REST** — the web UI uses a
  private websocket. `resolve` on an anchored comment fails with
  `platform-limitation`. Only review-level (unbound) discussions resolve via REST.
  Tell the user when a thread must be resolved in the web UI.
- `--author`/`--reviewer` need **profile ids**; a username silently returns 0 results.
- `--project` required for every command; commit-set reviews have `repository: null`.
- `outdated: true` means the diff the comment anchored to has changed since.
- Space API needs `$fields` projections when you curl raw endpoints; an invalid
  nested field silently empties `data` (totalCount stays). Iterate projections carefully.
- Don't parse stdout unless exit code is 0. Don't trust presence/absence of `status`.

## Verification

- After a reply: re-run `comments list` and confirm the reply appears in `replies[]`
  (server echoes id + author). After resolve: the thread shows `resolved: true`
  (and `comments list --unresolved` omits it).
- After config changes: `reviews list --project <KEY> --limit 1` exits 0.
