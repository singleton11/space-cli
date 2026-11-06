# space-cli — Project Plan

**One-liner:** A narrow-scope CLI that lets coding agents read, answer, and resolve JetBrains Space code review comments — with precise line anchors and diff context so agents know exactly *which* code is commented and can act on it.

**Status:** Draft for review · **Owner:** TBD · **Stack:** TypeScript / Node.js

---

## 1. Problem

Coding agents that act on PR feedback need four abilities against JetBrains Space:

1. **Find** the code review in question
2. **Read** the comments — knowing exactly which file, line, and revision each comment refers to
3. **Understand** what the reviewer wants (thread context, author, state)
4. **Answer** (reply in-thread) and **resolve** the comment when done

Space's UI is not agent-accessible. Its HTTP API is, but is a raw REST surface not designed for agent consumption. This CLI is the thin, boring bridge between the two.

## 2. Decisions (from planning interview)

| # | Question | Decision |
|---|----------|----------|
| 1 | Target instance | **`https://jetbrains.team/`** (JetBrains internal dogfood) — ✅ **verified alive in Step 0** (2026-11-05); unaffected by the Space cloud shutdown. |
| 2 | Interface | **Plain CLI, JSON on stdout.** No MCP server in v1 (thin MCP wrapper is a possible later addition; core logic goes in a lib from day one to make that cheap). |
| 3 | Operations in scope | List/find reviews · read comments with anchors · reply to comments · resolve/unresolve |
| 4 | Stack | TypeScript / Node (REST is plain HTTP+JSON; official Kotlin SDK not worth the JVM weight for agents) |
| 5 | Anchor → local code mapping | CLI reports **raw anchors + commented-text snippet + optional diff hunk** fetched at the comment's revision. **No local-git mapping** — the agent maps to its own checkout. |
| 6 | Auth | **Single token**: `SPACE_URL` + `SPACE_TOKEN` env vars, or a config file. No multi-org profiles. Replies post as the token owner's identity. |
| 7 | Mutation safety | **No guardrails.** reply/resolve/unresolve just run; irreversibility documented. |
| 8 | Reviewer intent | **Structured data only.** No classification/NLP in the CLI — agents interpret raw text. |
| 9 | Review discovery | `reviews list` with filters; **agent picks the review ID** explicitly. No branch→review magic. |

## 3. Explicit non-goals (v1)

- Creating new code reviews or top-level review comments (**replying only** — v1 exists to *work* a review, not open one)
- Review state changes: approve / "needs work" / merge / delete
- Any git operations (clone/fetch/push/merge)
- Mapping comment anchors to local files via git (agent's job; we provide the data)
- Intent classification, summarization, or any NLP
- Multi-org profiles, token management, `login` flows
- MCP server (future thin wrapper only)
- Human-facing TUI / interactive mode

## 4. Users & UX principles

- **Primary consumer: a coding agent** (shells out, parses JSON). Secondary: humans in shell scripts.
- **Machine-first:** JSON by default with a stable, documented schema; `--pretty` for humans.
- **Explicit IDs everywhere:** no implicit "current review" state, no cwd sniffing.
- **Errors as data:** JSON error object on stderr, non-zero exit, pass-through of Space's error code/message.
- **Boring and predictable** beats clever — this tool's job is to be trustworthy plumbing.

## 5. Command surface (v1)

**Config precedence:** `SPACE_URL`/`SPACE_TOKEN` env vars override `~/.config/space-cli/config.json` (`{ "url": ..., "token": ... }`).

```
space-cli reviews list [--project KEY] [--repo NAME] [--state STATE]
                       [--author USER] [--reviewer USER] [--text QUERY]
                       [--limit N]                         // author/reviewer = profile ids, state = Opened|Closed|RequiresAuthorAttention|NeedsReview|Merged
space-cli reviews show <reviewId> [--project KEY]

space-cli comments list --review <reviewId> [--project KEY]
                        [--file PATH] [--author USER] [--unresolved]
                        [--diff-context LINES]
space-cli comments reply --comment <commentId> (--text "..." | --stdin)
space-cli comments resolve --comment <commentId>
space-cli comments unresolve --comment <commentId>
```

**Comment output shape (field names pinned in Step 0 — API mapping in `docs/api-notes.md`):**

```jsonc
{
  "id": "1mZGCe08o6SN",             // Space CodeDiscussionRecord.id
  "reviewId": "4fjews3Ivlae",        // review record id (not the human number)
  "threadChannelId": "qaVlL1x77TG", // Space chat channel backing this thread
  "kind": "anchored",              // "anchored" (file/line) | "review-level" (unbound)
  "author": "Alexander.Gusakov",   // principal username (author.name)
  "createdAt": 1793699891738,        // epoch ms
  "text": "This will NPE when the cache is cold. Guard with ...",
  "resolved": true,                 // live thread state (Space resolves whole threads)
  "outdated": false,                // false = file byte-identical at review head → lines exact; true = changed since; null = review-level
  "anchor": {                       // ALL line numbers 1-based (Space is 0-based; the CLI converts — pinned M3)
    "file": "language-server/.../mcp.kt",   // leading "/" from Space normalized away
    "repository": "ultimate",
    "line": 72,                      // right-side (new file) line; null for left-side anchors
    "oldLine": null,                 // left-side (old file) line — comment on a deleted line; else null
    "revision": "ef27fe0d",         // commit of the side the anchor points into
    "end": null,                     // multi-line range end {line, oldLine, revision}; may sit on the other side
    "snippet": [                     // built into Space: snippet.lines[]
      { "text": "  return cache.get(key);", "oldLineNum": 52, "newLineNum": 68 }
    ],
    "diffContext": {                 // only with --diff-context N; null if binary/missing
      "revision": "ef27fe0d", "side": "new",
      "lines": [ { "line": 69, "text": "" }, { "line": 70, "text": "..." } ]
    }
  },
  "replies": [                      // chronological messages from the thread channel
    { "id": "FB6A90W8DsP", "author": "Anton.Prokhorov", "createdAt": 1793889048514, "text": "..." }
  ]
}
```

**List envelopes:** `reviews list` emits `{"totalCount": <matching filters, independent of --limit>, "reviews": [...]}`; `comments list` emits `{"reviewId": "<id>", "comments": [...]}` (oldest first).

**Snippet:** Space already returns a code snippet per comment (`snippet.lines` with old/new line numbers) — `comments list` emits it by default, making `--diff-context` a pure enhancement. Snippets are lossy (modified lines carry only their new text — see api-notes §9); `diffContext` is the ground truth.

**Diff context (`--diff-context N`):** the CLI fetches the file content **at the comment's revision** from Space and emits N lines around the anchored line(s) (widened over a multi-line range) as `{revision, side, lines: [{line, text}]}` — the code *exactly as the reviewer saw it*, on the side they commented. This lets an agent interpret the comment without any git operations, even if its local checkout has moved on. Opt-in because `text-content` costs ~350 ms per distinct file/revision.

**Outdated anchors:** always computed for anchored comments by comparing the commented file's **git blob** at the anchor's revision against the current review head (review base, for left-side anchors). `false` is a guarantee — byte-identical file, the anchor's line numbers are exact today; `true` warns that the file changed, moved, or was deleted since the comment, so the agent should locate the code by snippet/diffContext text. (The originally planned "anchor.revision ≠ head" test was dropped: IJ reviews are rebased so often that it flagged 48/48 live anchors — api-notes §9.)

## 6. Threading & resolve semantics

- A **thread** = a comment tree rooted at one top-level anchored comment. In Space each thread is backed by a **chat channel**; `comments list` returns thread roots with nested `replies` (chronological messages from the thread channel).
- `reply` posts a message into the thread's channel: `POST /chats/messages/send {channel, text}`. There is **no parent-message id** — "reply to comment X" = post to X's thread channel. (Pinned in Step 0.)
- `resolve`/`unresolve` apply at the **whole-thread** level. **Pinned in Step 0:** review-level (unbound) discussions resolve via REST (`PATCH .../unbound-discussions/{id}/toggle {"resolved": bool}` → 200 with empty body). **Anchored (file/line) discussions have no resolve API** — the web UI uses the private M2 websocket protocol. The CLI's `resolve` works for review-level comments and returns a documented platform-limitation error for anchored ones (`--help` spells this out so agents can't misuse it).

## 7. Step 0 — API spike (gates everything, ~½ day) — ✅ DONE 2026-11-05

**Result: all gates passed.** Instance alive (JetBrains internal dogfood, `jetbrains.team`, 1759 projects); token read + write verified with a live comment/reply/resolve round-trip on the owner's own review; all endpoints pinned in **`docs/api-notes.md`**; fixtures captured in **`fixtures/`**. One material finding: **anchored-discussion resolve is not available via the public REST API** (review-level resolve is) — §6 and api-notes.md §Resolve reflect this.

This plan deliberately does **not** claim exact Space endpoint paths. Step 0 pins them against the live instance:

1. **Verify the org is actually alive and reachable** (given the June 2025 cloud shutdown announcement, this is a hard gate: if the instance is dead, the project stops here).
2. Verify token auth works for code-review read + comment write.
3. Verify/locate endpoints for: listing reviews + filters; review details; comments with full anchor data; posting replies; resolve/unresolve; file content (or diff) **at a revision** (needed for `--diff-context`; if absent, feature drops to "snippet only" and the flag is cut).
4. Confirm pagination and practical rate limits.
5. Capture real API responses as **test fixtures**; write `docs/api-notes.md` with pinned paths/fields.
6. Update §5 of this doc with the real field names.

## 8. Milestones

| Milestone | Contents | Est. |
|---|---|---|
| **M0 — Spike** | §7. Hard gate. | 0.5 d |
| **M1 — Skeleton** | Config/env, HTTP client, auth, JSON output + error envelope, `reviews show` — ✅ **DONE 2026-11-05** (TypeScript/Node, commander, vitest: 33 tests incl. golden fixture tests; live E2E on jetbrains.team verified: MR + commit-set reviews, not-found path) | 0.5–1 d |
| **M2 — Read path** | `reviews list` (filters, pagination), `comments list` (threads, anchors, filters) — ✅ **DONE 2026-11-05** (31 new tests, 64 total; live E2E on jetbrains.team: 81-thread review with feed pagination + 40 review-level threads, `--file`/`--author`/`--unresolved` filters, deleted-message ghost filtering; bare project keys now auto-prefixed `key:` — bare keys 404 live, fixing the M1 trap; `--project` escape hatches: `key:XX` / `id:XX`) | 1–2 d |
| **M3 — Diff context** | `--diff-context`: revision content fetch, hunk builder, `outdated` flag — ✅ **DONE 2026-11-05** (42 new tests, 106 total, incl. golden tests on 5 new live fixtures; live E2E on jetbrains.team: unrebased MR, 81-thread rebased MR with left-side + cross-side range anchors, commit-set review with disjoint commits — 451 snippet lines cross-checked against fetched content. Findings fixed on the way: **Space line numbers are 0-based → output is now 1-based everywhere** (changes M2 output by +1); multi-line ranges (`endAnchor`) now exposed as `anchor.end`; `outdated` compares file blobs instead of revisions — api-notes §9) | 1 d |
| **M4 — Mutations** | `comments reply`, `resolve`, `unresolve` | 1 d |
| **M5 — Agent docs** | README with JSON schemas, an end-to-end agent workflow example, exit codes | 0.5 d |

~**5–6 focused days** total. Core logic lives in `src/lib/` from M1 so a future MCP wrapper is trivial.

## 9. Testing

- **Unit:** hunk builder, anchor normalization, config precedence.
- **Golden/fixture tests:** parsers run against M0 fixtures (protects against API surprises being silently swallowed).
- **Optional live smoke test:** read-only commands against the real org, opt-in via `SPACE_SMOKE=1` in CI, never in default test runs.
- **Manual E2E checklist (M5):** full agent scenario from §10 passes.

## 10. Success criteria

A coding agent, given only a repo and a review ID (and env creds), can — without reading any human docs:

1. List the unresolved comment threads, each with file/line/revision/snippet(+diff context)
2. Correctly identify the code each comment refers to, even in a checkout that has moved on (via `outdated` + snippet)
3. Post a sensible reply to each thread
4. Resolve the threads it addressed

…and never once opens a web browser.

## 11. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Space cloud is dead/being sunset** (JetBrains announced orgs disabled June 2025) | Fatal | Step 0 hard gate; owner's "still alive" claim gets verified before a line of code is written. If dead → stop, or retarget to an on-prem instance if one exists. |
| API endpoints/fields differ from assumptions | Medium | Nothing is hard-coded until M0 pins it; fixtures + golden tests catch drift. |
| No API for file content at revision | Medium | `--diff-context` degrades to snippet-only; flag is cut, not the project. |
| Resolve semantics (thread vs comment) unclear | Medium | Pinned in M0, surfaced in `--help` and JSON output. |
| Force-pushed reviews leave stale anchors | Medium | `outdated` flag + always-include revision + snippet; agent is told the ground truth. |
| Token lacks required permissions | Low | Step 0 checks both read and write scopes with a live comment round-trip. |
| Product dies mid-development | Medium | Narrow scope = small sunk cost (~1 week); the read path alone (M1–M3) is the bulk of agent value. |

## 12. Open questions (to resolve during M0)

All resolved in Step 0 (2026-11-05) — details in `docs/api-notes.md`:

1. Bearer token against `https://jetbrains.team/api/http/*`; the instance serves its own OpenAPI spec at `GET /api/http/openapi.json` (useful as a CI drift check).
2. `anchor.line` (right/new) + `anchor.oldLine` (left/old, `null` for additions); Space echoes a leading `/` on `filename` that the CLI normalizes away.
3. Resolve is whole-thread; REST-exposed **only for review-level (unbound) discussions** — anchored threads have no resolve API.
4. `state`: `Opened` / `Closed` / `RequiresAuthorAttention` / `NeedsReview` / `Merged`; plus `type` (`CommitSetReview`|`MergeRequest`), `sort`, `author`/`reviewer` (profile **ids**, not usernames), repository and branch filters.
5. Offset pagination (`$skip`/`$top`, `next`, `totalCount`); chat history `batchSize` ≤ 50; no rate limits observed (40 rapid requests, no limit headers).
6. Either — replies are flat messages in the thread's channel; no parent id exists in the API.
7. Untested — pin in M4 with a live round-trip; note the limit in agent docs if one is found.
