# Space API notes — pinned in Step 0 (API spike)

**Date:** 2026-11-05 · **Instance:** `https://jetbrains.team/` (JetBrains internal dogfood — alive and healthy)
**Spike status:** ✅ Complete. Instance reachable, token has read+write, all v1-critical endpoints located and exercised live.
**Auth:** `Authorization: Bearer <token>` against `https://jetbrains.team/api/http/*`. Token identity: `Anton.Prokhorov` (profile id `3f5nLE2wzNYi`). Token stored locally in `.space-token` (project dir); wire it as `SPACE_TOKEN` env var per config precedence.

**OpenAPI spec:** `GET /api/http/openapi.json` → OpenAPI 3.0, 628 paths, served by the instance itself. Use it in CI as a drift check.

---

## 1. Endpoint map (all verified live)

Base: `https://jetbrains.team/api/http`

### Projects / discovery
| Purpose | Endpoint |
|---|---|
| List projects | `GET /projects?$skip&$top` (1,759 projects) |
| Find repositories | `GET /projects/repositories/find?term=<name>` |
| Find profile (username→id) | `GET /team-directory/profiles?query=<name>` |

### Reviews
| Purpose | Endpoint |
|---|---|
| List reviews | `GET /projects/{project}/code-reviews` |
| Get review | `GET /projects/{project}/code-reviews/{reviewId}` |
| Review details | `GET /projects/{project}/code-reviews/{reviewId}/details` → `{shortInfo, commits, discussionCounter, branches}` |
| Files in review | `GET /projects/{project}/code-reviews/{reviewId}/files` |

`{project}` = `key:IJ` or the project id. `{reviewId}` = record id (e.g. `2AomjG0QgoiG`); reviews also have a human `number` (e.g. 233811) usable via `ReviewIdentifier.Number`.

**List filters (query params):** `state` · `text` · `author` · `reviewer` · `from` · `to` · `repository` · `sourceBranch` · `targetBranch` · `sort` · `type` · `$skip` · `$top` · `$fields`

- `state`: `Opened` \| `Closed` \| `RequiresAuthorAttention` \| `NeedsReview` \| `Merged` (NOT `Open` — 400 otherwise)
- `type`: `CommitSetReview` \| `MergeRequest`
- `sort`: `CreatedAtDesc` \| `CreatedAtAsc` \| `LastUpdatedDesc` \| `LastUpdatedAsc`
- `author`/`reviewer` take **profile ids**, not usernames (username → id via profiles lookup)

**Review record shape (MergeRequestRecord / CommitSetReviewRecord):**
`id, number, title, state, createdAt (epoch ms), createdBy, branchPair{repository, sourceBranch, targetBranch, sourceBranchRef}, participants[], reviewers[], authors[], discussionCounter{resolved, unresolved, unresolvedSuggestedEdits, acceptedSuggestedEdits, rejectedSuggestedEdits}, feedChannelId, commits[]`

Note: `CommitSetReviewRecord` has **no** `branchPair`/`repository` at top level; the repo is per-file (`files` endpoint). MRs do have `branchPair`.

**Files endpoint shape:** `data[] = {repository (plain string), change: {changeType: MODIFIED|ADDED|..., revision (full sha), new: {path}, old: {path}}, read}` — the filename lives at `change.new.path`, **not** `filename`, and only appears with an explicit `$fields` projection (see §3).

### Comments (anchored code discussions)

Space has **no direct "list discussions of review" REST endpoint**. The pinned read path:

1. `GET /projects/{project}/code-reviews/{reviewId}?$fields=feedChannelId` → the review's feed channel id.
2. `GET /chats/messages?channel={feedChannelId}&sorting=FromOldestToNewest&batchSize=50` → review timeline messages.
3. Filter `details.className == "CodeDiscussionAddedFeedEvent"` → each carries `details.codeDiscussion` (live record, not an event-time snapshot):

```jsonc
{
  "id": "1mZGCe08o6SN",                    // discussion id — the "comment id" for the CLI
  "anchor": {
    "project": { "key": "IJ" },
    "repository": "ultimate",
    "revision": "ef27fe0d...",             // commit the comment is anchored to
    "filename": "/language-server/.../mcp.kt",  // ⚠ leading slash!
    "line": 71,                            // right-side (new) coordinate
    "oldLine": null                        // left-side coordinate; null for pure additions
  },
  "channel": { "id": "qaVlL1x77TG", "totalMessages": 2, "lastMessage": {...}, "participants": [...] },
  "resolvable": true,
  "resolved": true,                        // live state
  "snippet": { "className": "CodeDiscussionSnippet.InlineDiffSnippet|PlainSnippet",
               "lines": [ { "text": "...", "oldLineNum": 51, "newLineNum": 67 } ] },
  "pending": false, "archived": false
}
```

4. Thread messages (root comment + all replies, chronological):
   `GET /chats/messages?channel={discussion.channel.id}&sorting=FromOldestToNewest&batchSize=50`
   → `messages[] = {id, text, time (epoch ms), created, author: {name: "Alexander.Gusakov"}, channelId}`

**Space snippets are built-in** (`snippet.lines` with old/new line numbers) — the CLI can emit them without `--diff-context`, making that flag a pure enhancement.

### Creating comments / replies

| Purpose | Endpoint |
|---|---|
| New anchored comment | `POST /projects/{project}/code-reviews/code-discussions` |
| Reply (any thread) | `POST /chats/messages/send` |

Create body (required: `text`, `repository`, `reviewId`):
```json
{
  "text": "…",
  "repository": "amper",
  "reviewId": { "className": "ReviewIdentifier.Id", "id": "1aqmHR0AKmNT" },
  "revision": "8cda5c13c024…",
  "filename": "sources/.../KnownAgents.kt",
  "line": 5,
  "oldLine": null,
  "diffContext": null,
  "pending": false
}
```
Returns the full discussion record incl. `channel.id` (reply target) — no leading slash echoed back on `filename` (the API normalizes it).

Reply body: `{ "channel": "<discussion channel id>", "text": "…" }` — **replies are flat**: a thread is a chat channel; there is no parent-message id. "Reply to comment X" == post to X's thread channel. (For an MR's top-level channel, a message + `POST .../{reviewId}/unbound-discussions {channelItemId}` makes a review-level comment.)

### Resolve / unresolve — ⚠ the one real gap

- **Unbound (review-level) discussions: supported.**
  `PATCH /projects/{project}/code-reviews/{reviewId}/unbound-discussions/{discussionId}/toggle` with body `{"resolved": true|false}` (omit body = toggle). Returns **200 with an empty body** — verify state via the list endpoint (`GET .../unbound-discussions?$fields=data(id,resolved)`).
- **Anchored (file/line) discussions: NOT exposed via REST.** Exhaustively probed: `code-discussions/{id}/resolve|toggle|resolved` → 404; `PATCH code-discussions/{id}` → 404; chats channel `resolve` variants → 404; the unbound toggle with a bound discussion id → 500. The web UI resolves anchored threads through the private M2 websocket protocol, not `/api/http`.

**CLI consequence (pinned for M4):** `resolve`/`unresolve` work for review-level comments only. For anchored threads the CLI must document this as a platform limitation in `--help` and the JSON error, and offer reply-only. Do NOT fake it.

### File content at a revision (enables `--diff-context`) — ✅ viable

| Purpose | Endpoint |
|---|---|
| Text file at revision | `GET /projects/{project}/repositories/{repository}/text-content?commit={sha}&path={no-leading-slash}` |
| Raw bytes | `GET /projects/{project}/repositories/{repository}/content?blobId&skip&limit` |
| Find files | `GET /projects/{project}/repositories/{repository}/find-files?pattern=&commit=` |

`text-content` returns `{type: "TEXT", lineEnding: "LF", bom, lines: [{text, index, offset, syntax[]}]}` — perfect for hunk building: fetch at `anchor.revision`, slice N lines around `anchor.line`, emit with diff coordinates from the built-in snippet.

### Message deletion (cleanup tool)

`POST /chats/messages/delete-message` with
`{"channel": {"className": "ChannelIdentifier.Id", "id": "..."}, "id": {"className": "ChatMessageIdentifier.InternalId", "id": "..."}}`
Deletes the **message only** — the discussion record remains as a ghost. Useful for test cleanup; also worth exposing as an escape hatch.

---

## 2. Pagination & rate limits

- Offset pagination everywhere: `$skip` / `$top`; responses carry `next` (next offset — opaque, but observed = skip+top) and `totalCount`.
- Chat messages: `batchSize` **max 50** (hard validation error above), continuation via `nextStartFromDate`; `sorting` = `FromOldestToNewest` | `FromNewestToOldest` (required).
- Rate limits: **none observed** — 40 rapid-fire requests all 200, no rate-limit headers exposed.

## 3. `$fields` projections (the big gotcha)

Default responses are **minimal** (e.g. review list items return only `{review: {className, id}}`). You must request what you need:

```
GET .../code-reviews?$fields=data(review(id,number,title,state,createdAt,discussionCounter)),totalCount
```

Quirks verified live:
- An invalid nested field **silently drops the whole projection or the data array** (`repository(name)` on MR list + a bad sibling → `data: []` with `totalCount` intact). Iterate projections incrementally; golden-test them.
- `repository` is a plain string on some records (files, anchors) and an object on others.
- On the MR list, `repository(...)` returned nothing — fetch the repo from the review record itself (`branchPair.repository` for MRs, per-file for commit-set reviews).
- Timestamps are epoch **milliseconds** (integers); some objects also carry ISO strings (`addedAt.iso`).

## 4. Errors

JSON envelope everywhere: `{"error": "<code>", "error_description": "…"}` with codes observed:
`not-found` (404, also for unknown routes), `request-error` (400, bad param values), `validation-error` (400, e.g. batchSize>50), `internal-server-error` (500, e.g. unbound toggle on a bound discussion id). Unknown paths: `No HTTP API endpoint at <METHOD> <path>` — useful for probing.

## 5. Write-path verification (2026-11-05, on Anton's own review)

All performed on `AMPER` review #3842 (`1aqmHR0AKmNT`, commit-set review) — the token owner's own review:
- ✅ Created anchored comment on `KnownAgents.kt` line 5 (discussion `CSBsF1HborG`) — write scope confirmed.
- ✅ Posted reply into the discussion channel via `chats/messages/send`.
- ✅ Created unbound discussion from a review-channel message; toggled `resolved: true` and back; deleted the message (record persists — quirk noted).
- 🧹 Residual test artifact: discussion `CSBsF1HborG` on review #3842 remains (no REST delete for discussions) — clearly labeled "space-cli API spike — safe to resolve/delete" in its text. `/resolve` literal message and unbound test message were deleted.

## 6. Fixtures (`fixtures/`)

| File | Content |
|---|---|
| `projects.json` | `GET /projects` page 1 |
| `reviews-list.json` | MR list, IJ, `state=Opened` sorted `LastUpdatedDesc` |
| `review-show.json` | MR #233811 with branchPair, participants, counters |
| `review-own.json` | Commit-set review #3842 (spike target) |
| `review-files.json` | Files in review #3842 with `change.new.path` |
| `feed-messages.json` | Review feed channel messages (timeline events) |
| `feed-discussion-event.json` | `CodeDiscussionAddedFeedEvent` with full discussion record |
| `discussion-created.json` | Discussion created via API (write-path proof) |
| `unbound-discussions.json` | Unbound (review-level) discussion list |
| `text-content-at-revision.json` | `text-content` response at an anchor revision |

## 7. Open items for M1+

1. Max comment text length & markdown support in replies — untested (prompt advice in agent docs).
2. `batchInfo` (opaque) in `chats/messages/sync-batch` — not needed for v1; polling by `startFromDate` is enough.
3. M2 websocket protocol (used by the web UI for anchored-discussion resolve) — reverse-engineering is a possible post-v1 project if resolve-for-anchored becomes a hard requirement.
4. `ReviewIdentifier.Key` / `.Number` variants exist; we pin `.Id` (list responses give ids).
