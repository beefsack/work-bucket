---
name: work-bucket
description: Lockfile-free, entity-agnostic filesystem Markdown work bucket with immutable event logs and capability tag routing for creating, claiming, decomposing, executing, clarifying, and reviewing work.
---

# Filesystem Work-Bucket Protocol

## 1. Mandatory Session Initialization
- Require three explicit parameters from the user before reading or modifying any bucket files:
  1. `bucket_dir`: Path to the bucket root (`tasks/`, `messages/`, `entities/`, `tags/`).
  2. `entity_id`: Your opaque identifier for this session (e.g., `entity-a`, `win-worker-1`, `ci-runner`).
  3. `mode` (`once` | `continuous` | `owner`; alias `one-shot`):
     - `once`: Claim and complete **1 task lifecycle**. After posting `review` or `blocked`, watch that specific task (`wb.mjs watch --task <id> --since-status <review|blocked> --after-event <event>`) until `status` is `complete` or `cancelled`, `status` returns to unassigned `pending` (`--reopen`), `reason == "removed"`, or `assignee` changes away from `<entity_id>`; if `feedback`/`answer` returns it to `status: "pending"` with `assignee == <entity_id>`, reclaim, fix/continue, and re-watch it until closed or reassigned.
     - `continuous`: Continuous worker loop. After handling work, re-arm `watch`; in background-completion harnesses **END YOUR TURN** after arming it (no `--timeout`). That is the wait, not an exit. Never wait in-turn.
     - `owner`: Non-worker coordinator/owner loop. **Never** claim tasks. Use `watch --entity <entity_id> --owner-only` for owned `blocked`/`review` tasks and messages, handle them, then re-arm with the same waiting rule. A bounded owner acting for a parent/coordinator exits when every task in its assigned unit is `complete`/`cancelled`, or when a decision must be escalated: stop watching and report via the harness. Exit is not a bucket pause.
- Record any optional capability/platform `tags` (and whether `--include-untagged` applies) supplied by the user for executor task matching and message filtering.
  - **Owner vs executor tag scope:** `tags` only restrict which tasks you `claim` as an executor (and which tag-targeted messages wake you). Creating, watching (`--task`), answering, reviewing, completing, or cancelling tasks where `owner == <entity_id>` is always allowed regardless of `tags`.
- Record optional concurrency parameter if supplied (default: `single-threaded`):
   - **Concurrency (`single-threaded` | `multithreaded`):** `single-threaded` claims and executes 1 task inline (`WIP = 1`). `multithreaded` runs as a dispatcher watching the bucket and spawning up to `max_workers` subagents (with configured `agent`/`model`/`effort`), each using a distinct `entity_id` (e.g. `<entity_id>-1`, `<entity_id>-2`) so `WIP = 1` per `entity_id` and `claimed_by` single-writer rules hold; parallelize shared-repo tasks only when `depends_on` or separate git worktrees prevent file conflicts.
   - **Dispatcher alone watches tags/messages.** Each child runs `once`, scoped to `claim --task <id>`, never watches tags/messages, and returns to the dispatcher immediately after posting `review`/`blocked` (exception to the standalone `once` lifecycle). The dispatcher checks pending tasks pinned to its `<entity_id>-N` child IDs and spawns a child under that same ID for rework; if that assignee cannot return, ask the owner to `post --reopen`.
- **Never** invent, infer, default, or auto-generate `bucket_dir`, `entity_id`, `mode`, or `tags`. If `bucket_dir`, `entity_id`, or `mode` (`once` vs `continuous` vs `owner`) is missing, ask the user and wait.
- Treat all other `entity_id` values as anonymous peers (use `wb.mjs entity list` / `wb.mjs tag list` to discover active peers and documented tags). Never assume what tool, model, script, or human sits behind another `entity_id`.
- Ensure `<bucket_dir>/tasks`, `messages`, `entities`, and `tags` exist before operating. Keep host clocks reasonably synced (e.g., via NTP) so timestamp-ordered events and lockless claim elections stay deterministic across hosts/cloud sync folders.
- If `<skill_dir>/scripts/wb.mjs` and `node` (Node 20+) are available, prefer `node "<skill_dir>/scripts/wb.mjs"` subcommands for lockless claim election, atomic file updates, and zero-token waiting; otherwise execute the identical filesystem rules below directly.
- **Watching:** In harnesses that wake on background completion, arm one background `watch` **without `--timeout` and END YOUR TURN**; never wait in-turn. "Do not end your turn" applies only to foreground/blocking harnesses: run foreground with `--timeout` below the tool limit, re-running on `124` or outer timeout `143`. Keep at most one watcher per entity; re-arm after handling a match unless exiting a bounded unit.
- **Mode vocabulary:** `once`/`continuous` describe session behavior; non-owner pool `watch` records advisory entity `mode: "worker"` (`entity register` also accepts `worker`). This is not a different execution policy.

## 2. Directory Layout & File Rules
- `<bucket_dir>/tasks/<task_id>/task.md` + `events/` - Single fixed directory per task across its entire lifecycle (`status` in `task.md` is the sole lifecycle state: `draft`, `ready`, `pending`, `in-progress`, `blocked`, `review`, `complete`, `cancelled`). Never move or rename task folders after creation. Ignore folders missing `task.md`, dotfiles (`.*`), and sync-conflict files (`.sync-conflict-`, `conflicted copy`).
- `<bucket_dir>/messages/<UTC>-<from_entity>-<slug>.md` - Append-only, immutable **public** messages (`from`, `to: [...]`, `tags: []`, `timestamp`).
- `<bucket_dir>/entities/<entity_id>.md` - Advisory peer presence & message cursor (`entity_id`, `tags`, `include_untagged`, `mode`, `ttl_seconds`, `last_msg_seen`, `updated_at`). Single-writer: only `<entity_id>` edits its own file; heartbeats never block restarts or wake task watchers.
- `<bucket_dir>/tags/<tag>.md` - Optional tag descriptions and standing instructions, not a strict allowlist. Executors read bodies for every task tag plus optional bucket-level `INSTRUCTIONS.md` before claiming/executing; task bodies contain only task-specific content. `claim --json` includes these as `instructions: [{file, body}]`.
- **Immutable `events/` & `messages/` streams:** Append solely by creating unique timestamped files (via `.<file>.tmp` -> rename). **Never edit or delete an existing file in `events/` or `messages/`.**
- **Single-writer rule on `task.md`:** Only `claimed_by` edits `task.md` while `status == in-progress`; only `owner` edits `task.md` while `status` is `draft`, `ready`, `blocked`, `review`, or unclaimed `pending`. Always write `task.md` via `.task.md.tmp` -> rename, quote all YAML strings (`"..."`), and strip `\r`.
- **Payload-before-flag rule:** Always publish the new file in `events/` *before* updating `task.md` `status`.

## 3. Creating, Refining, Amending & Reviewing Tasks (Owner Role)
- **Creating:** Create `<bucket_dir>/tasks/<task_id>/events/` (`--backlog` / `--draft` for `status: "draft"`, `--status ready` for held-back, or default `status: "pending"`), write `<UTC>-<entity_id>-created.md`, and atomically publish `task.md` with:
  - Frontmatter: `id`, `title`, `status: "pending" | "draft" | "ready"`, `priority`, `tags: []` (e.g., `["windows"]`, `["macos"]`, `["linux"]`), `owner: "<entity_id>"`, `claimed_by: ""`, `claim_round: 1`, `assignee: ""`, `parent: ""`, `depends_on: []`, `revision: 1`, `updated_by: "<entity_id>"`, `updated_at: "<ISO-8601 UTC>"`.
  - Body: `## Context & Target` (workspace path and target files), `## Description`, and numbered `- [ ] #N` `## Acceptance Criteria` including an exact verification command.
- **Backlog Refinement & Promotion:** Tasks in `tasks/` with `status: "draft"` or `status: "ready"` stay out of worker queues. Promote to claimable work (`wb.mjs post --status pending`), or pull an unclaimed `pending` task back (`wb.mjs post --status ready` or `draft`).
- **Amending Mid-Flight:** Never edit `tasks/<task_id>/task.md` while `status == in-progress`. Publish `tasks/<task_id>/events/<UTC>-<entity_id>-amend.md` instead.
- **Owner decision table:** `in-progress` correction = `amend`; `review` rework = `feedback --status pending`; `blocked` continuation = `answer --status pending`. Amend alone on `review`/`blocked` warns and does not reopen execution.
- **Answering Blocked Tasks:** For `tasks/<task_id>/task.md` where `owner == <entity_id>` and `status == blocked`, publish `events/<UTC>-<entity_id>-answer.md`, then update `task.md` (`revision + 1`, `claim_round + 1`, `status: "pending"`, `claimed_by: ""`, auto-pinning `assignee` to the prior executor so they retain context, or pass `--reopen` to clear `assignee` and open to the pool).
- **Reviewing & Closing:** For `tasks/<task_id>/task.md` where `owner == <entity_id>` and `status == review`, inspect `events/`, workspace diffs, and test output. Either:
  - Publish `events/<UTC>-<entity_id>-complete.md` and update `task.md` (`status: "complete"`, `claimed_by: ""`), **or**
  - Publish `events/<UTC>-<entity_id>-feedback.md`, increment `revision` and `claim_round`, set `status: "pending"`, clear `claimed_by: ""`, and pin `assignee` to the prior executor (or pass `--reopen` to clear `assignee`), **or**
  - To cancel a task, publish `events/<UTC>-<entity_id>-cancelled.md` and set `status: "cancelled"`, `claimed_by: ""`.
- **Stale Recovery:** If an `in-progress` task goes stale, `owner` publishes `events/<UTC>-<entity_id>-reset.md`, increments `claim_round`, sets `status: "pending"`, and clears `claimed_by: ""` and `assignee: ""`.

## 4. Claiming, Decomposing & Executing Tasks (Executor Role)
1. **READY Gate:** Enforce a WIP limit of **1 active `in-progress` task** per `entity_id` (`review` and `blocked` tasks do **not** consume WIP, so you remain eligible to claim new `pending` tasks while earlier tasks await review or answers; in `multithreaded` mode allow up to `max_workers` subagents, each with its own `entity_id`). Never run `claim` in `owner` mode. Scan `tasks/*/task.md` (or run `wb.mjs watch` with any configured `--tag` / `--include-untagged` flags):
   - Tasks where `status == pending`, `claimed_by == ""`, and `assignee == <entity_id>` (resume your own unblocked/rejected tasks first; direct `assignee` matches bypass tag filters), then
   - Tasks where `status == pending`, `claimed_by == ""`, and `assignee == ""`. (Ignore `draft` and `ready`, and skip any task that already has a competing earlier `claimed` event for the current `claim_round`.)
   - **Tag filter check (OR by default):** If session capability `tags` are configured, require at least one tag in `task.tags` to match your configured `tags` (`OR` matching; use a combined tag such as `macos-worker` when `AND` is required), and ignore untagged tasks (`tags: []`) unless `--include-untagged` was specified (or `assignee == <entity_id>`).
   - **Dependency check:** Require every `<dep_id>` in `depends_on` to have `status: "complete"`. Sort eligible tasks by `priority` (`critical` > `high` > `medium` > `low`), tie-breaking by oldest `<task_id>`.
2. **Lockless 2-Phase Claim:**
   - Run `wb.mjs claim` (or manually: append `<UTC>-<entity_id>-claimed.md` with `round: <claim_round>`, wait `--claim-settle-ms` [default `2000` ms] for cloud sync / concurrent claims, then check all `*-claimed.md` files for `claim_round`). The deterministic winner is the earliest `<UTC>` timestamp, tie-breaking lexicographically by `entity_id` then filename.
   - Only the winner updates `task.md` (`status: "in-progress"`, `claimed_by: "<entity_id>"`, `updated_at: "<UTC>"`) and records the latest filename in `events/` as `last_event_seen`. Losers exit without touching `task.md`.
    - In `multithreaded` mode, pass `--task <task_id>`, child `entity_id`, `bucket_dir`, tags, and `mode=once` to the child. Only the dispatcher watches the pool/messages; the child returns after `review`/`blocked`.
3. **Checkpoint & Amendment Check:** Before modifying workspace files and before finalization, refresh `updated_at` (heartbeat), verify `claim_winner == <entity_id>` (e.g., via `wb.mjs render --json` in case a late-synced earlier claim arrived during cloud replication - if you lost `claim_round`, abort cleanly without writing `task.md`), and check `tasks/<task_id>/events/` for any files newer than `last_event_seen`. If new `*-amend.md` files exist, read all of them in chronological order, merge changes into `task.md` (incrementing `revision`), publish a `*-log.md` event noting incorporation, and advance `last_event_seen`.
4. **Subtask Decomposition (Optional):** You may split an oversized task into child tasks (`parent: "<task_id>"`, `owner: "<entity_id>"`, plus platform/capability `tags`) in `tasks/`, append all child IDs to the parent's `depends_on`, publish a `*-log.md` event, and set the parent to `status: "pending"`, `assignee: "<entity_id>"`, `claimed_by: ""` (`claim_round + 1`). Execute/review the children until all are `complete`, then resume the parent to verify its `## Acceptance Criteria`.
5. **Assume & Flag Execution Policy:**
   - Make tentative, idiomatic decisions on straightforward, reversible details without stopping, and log every assumption in `events/<UTC>-<entity_id>-log.md`.
   - **Hard Stop (Halt Immediately)** if: (a) an unexpected public API, schema, wire protocol, or dependency change is required, (b) requirements conflict or allow two fundamentally different designs, or (c) verification still fails after **2 fix attempts**.
6. **Halt, DONE Gate, Rework & Continuity:**
   - **If Blocked / Halted:** Publish `events/<UTC>-<entity_id>-question.md`, then set `task.md` `status: "blocked"`.
    - **If Complete (DONE Gate):** Verify every acceptance criterion passes, check `- [ ]` to `- [x]` (`--check-ac`), post `review --status review` (no `--bump-revision`). Review body template: claims; raw evidence excerpts with `file:line`; observed vs inferred; unverified list; files changed and diff/status; verification commands and verbatim output.
   - **Rework after `feedback`:** Resume the task via `claim`, read the new `*-feedback.md` event(s), apply fixes, re-verify, optionally post `--type log`, and run `wb.mjs post --type review --status review --check-ac` (no `--bump-revision`).
   - **Next step (`once` vs `continuous` vs `owner`):** (Run `wb.mjs watch` in the background when your harness wakes on background exit, otherwise foreground.)
     - If `once`: Run `wb.mjs watch --bucket <dir> --task <task_id> --since-status <review|blocked> --after-event <event> --json` until `status == "complete"` or `"cancelled"`, `status == "pending"` with `assignee == ""` (`--reopen`), `reason == "removed"`, or `assignee` changes away from `<entity_id>`; if `status == "pending"` and `assignee == <entity_id>`, go to Step 2 (`claim`) and rework/continue; if still `review`/`blocked` (e.g., an intermediate event), advance `--after-event` and keep watching; otherwise exit cleanly.
      - If `continuous`: Loop back to Step 1 and re-arm `watch --entity <entity_id> [--tag ...]` for rework, owned reviews, work and messages. Background-completion harness: arm without `--timeout`, **END YOUR TURN**. Foreground harness: block/re-arm, do not end your turn. Never wait in-turn.
      - If `owner`: Re-arm `watch --entity <entity_id> --owner-only`, using the same wait rule, unless all assigned-unit tasks are terminal or a decision must be escalated; then stop watching and report.

## 5. Public Messaging (`messages/`)
- **All messages are strictly public:** Every entity with bucket access can read every file in `messages/`, even when `to` or `tags` target specific recipients. Never put secrets or private assumptions in `messages/`.
- Use `messages/` for cross-cutting announcements (e.g., breaking changes, coordination notices) rather than single-consumer tasks.
- Task correction = task event; cross-cutting notice = public message; report to a parent = harness; pause = bucket-level pause, not a message or task cancellation.
- `wb.mjs watch --entity <id> [--tag ...]` wakes only on messages newer than `last_msg_seen` where `from != <id>` and (`to` contains `"*"` or `<id>`, or `tags` intersect your `--tag`s), coalescing rapid message-only bursts (~500ms quiet window) and advancing `last_msg_seen` in `entities/<id>.md` on delivery.

## 6. Optional Helper CLI (`scripts/wb.mjs`)
Do **not** read `scripts/wb.mjs` source; run `node "<skill_dir>/scripts/wb.mjs" <subcommand> --help` if you need flag details:
- `create`: `wb.mjs create --bucket <dir> --entity <id> --title <text> [--backlog|--draft] [--status draft|ready|pending] [--priority ...] [--tag <t>] [--assignee <id>] [--depends-on <ids>] [--body-file <path>|--stdin]`
- `claim`: `wb.mjs claim --bucket <dir> --entity <id> [--task <id>] [--tag <t>] [--include-untagged] [--claim-settle-ms 2000] [--json]`
- `post`: `wb.mjs post --bucket <dir> --entity <id> --task <id> --type <type> [-m <text>|--body-file <path>|--stdin] [--status <status>] [--bump-revision] [--check-ac] [--reopen]` (`feedback`/`answer` to pending auto-increment revision once, including with `--bump-revision`; returns increment `claim_round` and auto-pin prior executor)
- `watch`: `wb.mjs watch --bucket <dir> [--entity <id>] [--owner-only] [--task <id>] [--tag <t>] [--include-untagged] [--after-event <file>] [--after-msg <file>] [--json]` (exiting `124` on `--timeout` or `143` on outer timeout means no matching updates yet - immediately re-run `watch` if still waiting)
- `render`: `wb.mjs render --bucket <dir> --task <id> [--after-event <file>] [--json]`
- `msg`: `wb.mjs msg send --bucket <dir> --entity <id> [--to <id|*,...>] [--tag <t>] -m <text>` | `wb.mjs msg list --bucket <dir> [--entity <id>] [--unread] [--all]`
- `entity`: `wb.mjs entity register --bucket <dir> --entity <id> [--tag <t>] [--mode <m>] [--ttl 300]` | `wb.mjs entity list --bucket <dir> [--online]`
- `tag`: `wb.mjs tag set --bucket <dir> --entity <id> --tag <name> -m <description>` | `wb.mjs tag list --bucket <dir>`

Use quoted here-docs for multi-line bodies (also supported by `create --stdin`):
```bash
wb.mjs post --bucket "$BUCKET" --entity "$ENTITY" --task "$TASK" --type review --status review --stdin <<'REVIEW'
- Claim: implemented; observed: `test` passed (evidence.txt:1-4).
- Raw evidence: <verbatim excerpt>; inferred: <interpretation>.
- Unverified: none. Files/diff status: <paths and status>.
- Verification: <command and verbatim output>.
REVIEW
```
