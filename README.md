# work-bucket

Version 2.0.0 introduces a breaking protocol/CLI update.

A lockfile-free, entity-agnostic filesystem Markdown work bucket skill (`SKILL.md`) with an optional zero-dependency Node.js 20+ CLI (`scripts/wb.mjs`). Humans, LLM agents across any harness, and automated scripts collaborate across local disks, SMB/NFS mounts, or consumer cloud-sync folders (Dropbox, Google Drive, OneDrive, Syncthing) through plain Markdown files, immutable event logs, and lockless 2-phase claim elections.

## Installation

Install with [`skills`](https://github.com/vercel-labs/skills):

```bash
# Project-local
npx skills add beefsack/work-bucket

# Or global (across all projects)
npx skills add beefsack/work-bucket -g
```

Node.js 20+ is optional at runtime. If `node` is present, agents use `scripts/wb.mjs` for lockless claim election, atomic file updates, and event-driven `watch` waits; otherwise they follow the same Markdown + event-log rules directly.

When starting an agent session, provide three required inputs:
- `bucket_dir`: Path to the bucket root directory.
- `entity_id`: The opaque name for that participant (e.g. `alex`, `worker-linux-1`).
- `mode`: `once` (handle one task through review/completion), `continuous` (keep watching for new, reopened, and owned tasks plus messages), or `owner` (non-worker coordinator watching only owned `blocked`/`review` tasks and relevant messages).
- Optional capability tags (e.g. `--tag linux`) and `--include-untagged`.

## How Humans Interact with the Bucket

### Bucket settings

The owner edits `bucket.md` at the bucket root:

```yaml
---
sync: local
claim_settle_ms: 250
default_ttl_seconds: 300
msg_coalesce_ms: 500
---
```

- `sync`: `local`, `shared`, or `cloud`. Omitted config defaults to `shared`.
- Omitted settle defaults to 250 ms locally, 2000 ms otherwise. It must be a
  positive integer, including for pinned reclaims.
- TTL must be a positive integer; message coalescing must be a non-negative integer.
- Local buckets containing sync-conflict copies are reported by `fsck`.

### Migration to 2.0.0

| Previous behavior | Replacement |
| --- | --- |
| Per-call `--claim-settle-ms` | Set positive `claim_settle_ms` in `bucket.md` |
| Watch `--ttl` / `--msg-coalesce-ms` | `default_ttl_seconds` / `msg_coalesce_ms` in `bucket.md` |
| Pinned reclaims skip settle | Every election settles |
| Second-precision event/message names | Millisecond names; old names remain readable |
| Entity list includes all historical identities | `entity list --all`; `entity end` marks exit |

`fsck --bucket <dir>` is read-only. `fsck --repair` rebuilds drifting
non-terminal task frontmatter from immutable state snapshots, preserving the
body. Terminal tasks and legacy tasks without snapshots are never rewritten.
Legacy revision/round mismatches are reported as known historical anomalies.
Ambiguous or invalid snapshots prevent repair. Claim elections remain immutable
intents; only an elected winner's `claim-committed` event materializes the claim.

Run the tests with `npm test` or `node --test test/` (Node.js 20+).

A bucket uses plain Markdown directories:

```text
<bucket_dir>/
├── tasks/     # Fixed-path task folders (<YYYYMMDDTHHMMSSZ>-<slug>/task.md + events/)
├── messages/  # Append-only public announcements (to / tags)
├── entities/  # Advisory entity presence & message cursor files
└── tags/      # Optional Markdown descriptions of capability tags
```

Each task lives at a permanent path `tasks/<YYYYMMDDTHHMMSSZ>-<slug>/` containing `task.md` (`status`: `draft | ready | pending | in-progress | blocked | review | complete | cancelled`) plus `events/` (immutable, timestamped Markdown files named `<UTC>-<entity_id>-<type>.md`).

You can manage the bucket directly in any text editor or with `node scripts/wb.mjs`:

- **Create a task (ready or backlog):** Run `wb.mjs create --bucket <dir> --entity <you> --title "..."` (or pass `--backlog` for `status: "draft"`). Promote a refined draft/ready task with `wb.mjs post --bucket <dir> --entity <you> --task <id> --type log -m "Ready" --status pending`.
- **Amend a running task:** Never edit `tasks/<id>/task.md` while `status` is `in-progress`. Instead, drop a new file in `tasks/<id>/events/<UTC>-<you>-amend.md` (or run `wb.mjs post --type amend -m "..."`). The executor checks for new amendments at checkpoints and merges them.
- **Unblock a `blocked` task:** Read the latest question; `wb.mjs post --type answer -m "..." --status pending` automatically increments `revision` and `claim_round` once, even with legacy `--bump-revision`.
- **Review a `review` task:** Inspect `wb.mjs render --bucket <dir> --task <id>` (or read `task.md` and `events/`).
  - Approve: post `events/*-complete.md` and set `status: "complete"`, `claimed_by: ""` (or run `wb.mjs post --type complete`).
   - Request changes: `wb.mjs post --type feedback -m "..." --status pending` automatically bumps `revision` and `claim_round`, pinning the previous executor. Use `--reopen` if that assignee is gone.
  - Cancel: run `wb.mjs post --type cancelled`.
- **Send or read public messages:** Run `wb.mjs msg send --bucket <dir> --entity <you> [--to <id|*,...>] [--tag <t>] -m "..."` and `wb.mjs msg list --bucket <dir> --all`. All messages in `messages/` are public to everyone in the bucket.
- **Inspect active entities and tags:** Run `wb.mjs entity list --bucket <dir>` and `wb.mjs tag list --bucket <dir>` (document tags via `wb.mjs tag set --bucket <dir> --entity <you> --tag <name> -m "..."`).

## Agent Loops and Evidence

- Background-completion harness: arm `watch` without `--timeout` and **end your turn**; that is the wait. Never wait in-turn. Foreground/blocking harnesses instead block and re-arm on timeout. Keep one watcher per entity.
- A bounded owner stops watching and reports through its parent harness once all assigned-unit tasks are `complete`/`cancelled`, or a decision requires escalation. Exit is not a bucket pause.
- Only a multithreaded dispatcher watches tags/messages. Children use `once`, `claim --task <id>`, and return after `review`/`blocked`, without pool/message watches. The dispatcher checks pending pins to its `<entity_id>-N` IDs and spawns children under those IDs for rework; owners use `--reopen` when a pinned assignee cannot return.
- Session modes are `once`, `continuous`, `owner`; non-owner pool watches record advisory `mode: "worker"`, also accepted by `entity register`.
- Read optional `INSTRUCTIONS.md` and `tags/<tag>.md` bodies for every task tag before claiming/executing. `claim --json` includes `instructions: [{file, body}]`; task bodies need only task-specific content.
- Correct `in-progress` tasks with `amend`; resume `review` with `feedback`, `blocked` with `answer`, using `--status pending`. Amend alone does not reopen actionable tasks and prints a warning.
- Review bodies include claims, raw evidence with `file:line`, observed vs inferred conclusions, unverified items, files changed/diff status, and verification commands/output.
- Task corrections use task events; cross-cutting notices use public messages; parent reports use the harness; pauses use bucket-level pause.
- `create` and `post` accept `--body-file <path>` or `--stdin`. Avoid shell substitution in multiline bodies:

```bash
wb.mjs post --bucket "$BUCKET" --entity "$ENTITY" --task "$TASK" --type review --status review --stdin <<'REVIEW'
- Claims: <claims>; raw evidence: <verbatim excerpt, file:line>.
- Observed: <facts>; inferred: <interpretation>; unverified: <list>.
- Files/diff status: <paths and status>; verification: <command and output>.
REVIEW
```

- `render --after-event <filename>` limits history to newer events.

## Watch Delivery

- Pool watches skip pending tasks with any `claimed` event for the current `claim_round`, including elections still settling. Explicit/unscoped `claim` can still resume its own interrupted election.
- Dispatchers use repeatable `watch --exclude-task <id>` for tasks already handed to children. Exclusions apply to pool and owned-task results, not `--task` watches or messages.
- Owner watches are edge-triggered: only owned `review`/`blocked` tasks with events newer than their delivered cursor wake again. Delivery stores `owner_task_seen: ["<task_id>/<event_file>"]` in the entity file; ordinary heartbeats/registration preserve it. Existing buckets need no migration.
- Use `watch --owner-only --all-actionable` to include all currently actionable owned tasks, including previously delivered tasks and hand-written tasks without events. This still delivers/advances cursors.
- Task summaries include `revision`, `claim_round`, `claimed_by`, `assignee`, and `latest_event: {filename, type, entity_id, timestamp, body, truncated}`. Event bodies default to the first 5 lines (`--event-lines N`, including `0` for metadata only).
- `watch --task` preserves `new_events` filename arrays and adds `events` with the same event details, plus top-level revision/round/executor/assignee and `latest_event`. `--include-events` includes full bodies of surfaced events, not the entire historical stream.

## Compact Inspection, Amendments and Control

- `render --tail-events N` limits history after any `--after-event` filter; `--latest-event` means one event, `--tail-events 0` means none. JSON shape: `{task_id, stage, path, claim_winner, task, body, events}`; frontmatter is nested (use `task.status`, not `status`). Events contain `{filename,type,entity_id,timestamp,body}`.
- `list --bucket <dir>` emits one line per task: ID, status, assignee/claimed_by, revision, claim_round, latest event filename/type. Filter with repeatable/comma-separated `--status`, OR-matching `--tag`/`--tags`, and `--owner` (filters combine with AND). `--json` returns `{count,tasks:[summary]}` with the watch summary fields and 5-line latest-event previews.
- `claim --json` adds `unread_events` with full bodies: unaccepted amends, including those before the first claim, plus feedback since the previous round's claim. Amends remain visible across rounds until accepted, even if older than that previous claim.
- The current executor uses `post --type log --accept-amends` on an `in-progress` task. This preserves the original brief and appends unaccepted amendment bodies verbatim under chronological filename headings; apply their meaning during execution. It bumps revision once (also with `--bump-revision`), stores `last_amend_seen`, and publishes a log of filenames before atomically updating `task.md`. A repeated call with no new amends fails without changes. Old manually merged amendments without a cursor are conservatively treated as unaccepted.
- Register executors with `entity register` before execution, and refresh their entity heartbeat at checkpoints. Owner watch wakes with `reason: "stale"` and `stale_tasks` when an owned `in-progress` task's registered `claimed_by` heartbeat exceeds its TTL. Results include executor, timestamp, TTL and age. Each task/round/heartbeat alert is delivered once (`stale_task_seen`); a newer heartbeat or claim round can signal a later stall. Missing/unparseable heartbeats cannot signal TTL expiry. This is advisory, not an automatic reset or proof that execution stopped.
- Terminal `post --type complete|cancelled --outcome pass|partial|fail|abandoned` optionally records `outcome` in `task.md`; existing lifecycle states and dependency rules are unchanged. A completed bounded investigation with negative findings uses `complete --outcome fail`; partial verification can use `complete --outcome partial` when the investigation's own acceptance criteria are met. Unfinished work uses `cancelled --outcome abandoned`. State the product verdict separately.
- `bucket pause --bucket <dir> [-m <reason>]` atomically creates plain `PAUSED`; `bucket resume --bucket <dir>` removes it (idempotently). Humans can create/remove the file directly. Pause is bucket-wide, not task cancellation. `claim` refuses with exit 2, including a pause detected during settle; that election's immutable claim remains and can be resumed by its winner or reset by the owner.
- Paused pool `watch` reports `reason: "paused"`, `paused: true` and no ready work. Executors stop at checkpoints and do not repeatedly re-arm pool watches until explicitly resumed. Owners may continue `--owner-only` watches/reviews/messages/stall handling; those watches include the pause flag but do not wake solely for pause. Task-specific watches retain lifecycle/event behavior and include `paused` on updates.

## Reclaims and Session Handover

- All claims, including pinned reclaims, use the positive settle configured in `bucket.md`. Winner election and late-sync split-brain checks remain in place.
- Optional `--session-nonce <token>` is accepted by `create`, `claim`, `post`, `watch`, `msg send`, `entity register` and `tag set`; it overrides `WB_SESSION_NONCE`. Register the entity first, then supply the same caller-chosen token on writes (or inherit the environment variable). The marker is stored as `session_nonce` in `entities/<id>.md`.
- A different nonce on a still-live entity prints one warning per command but does not refuse the write: presence remains advisory, not an exclusive lease. Stale transfers do not warn. Commands without a nonce preserve an existing marker and cannot detect collisions; existing buckets need no migration. Resolve unexpected identity sharing with the coordinator rather than inventing a new ID.
- Before context handover, capture task IDs, last-seen event filename and the existing watcher's handle/PID. The successor must stop that known watcher for its entity before re-arming, even if its completion targets the predecessor session. Resume task waits with `watch --task <id> --after-event <last_seen> --since-status <review|blocked>`; owner/pool watches reuse persisted entity cursors. An already `in-progress` task resumes from its checkpoint without another claim.

## License

[MIT](LICENSE)
