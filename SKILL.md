---
name: work-bucket
description: Lockfile-free, entity-agnostic filesystem Markdown work bucket with immutable event logs and capability tag routing for creating, claiming, decomposing, executing, clarifying, and reviewing work.
---

# Filesystem Work-Bucket Protocol

## 1. Mandatory Session Initialization
- Require three explicit parameters from the user before reading or modifying any bucket files:
  1. `bucket_dir`: Path to the bucket root (`pending/`, `active/`, `archive/`).
  2. `entity_id`: Your opaque identifier for this session (e.g., `entity-a`, `win-worker-1`, `ci-runner`).
  3. `mode` (`once` | `ongoing`; aliases `one-shot` | `continuous`):
     - `once`: Claim and complete **1 task lifecycle**. After posting `review` or `blocked`, watch that specific task (`wb.mjs watch --task <id> --since-status <review|blocked> --after-event <event>`) until it reaches `complete`/`cancelled`, moves to `pending/` (`--reopen`), or `assignee` changes away from `<entity_id>`; if `feedback`/`answer` returns it to `status: "pending"` with `assignee == <entity_id>`, reclaim, fix/continue, and re-watch it until closed or reassigned.
     - `ongoing`: Continuous worker loop. After posting `review` or `blocked` (or finishing an owned review/completion), **do not stop or end your turn with a completion summary**; immediately run `wb.mjs watch --bucket <dir> --entity <entity_id> ...` in the same step so the watcher remains active for both new work and reopened `review` tasks.
- Record any optional capability/platform `tags` (and whether `--include-untagged` applies) supplied by the user for executor task matching.
  - **Owner vs executor tag scope:** `tags` only restrict which tasks you `claim` as an executor. Creating, watching (`--task`), answering, reviewing, completing, or cancelling tasks where `owner == <entity_id>` is always allowed regardless of `tags`.
- Record optional concurrency parameter if supplied (default: `single-threaded`):
  - **Concurrency (`single-threaded` | `multithreaded`):** `single-threaded` claims and executes 1 task inline (`WIP = 1`). `multithreaded` runs as a dispatcher watching the bucket and spawning up to `max_workers` subagents (with configured `agent`/`model`/`effort`), each using a distinct `entity_id` (e.g. `<entity_id>-1`, `<entity_id>-2`) so `WIP = 1` per `entity_id` and `claimed_by` single-writer rules hold; parallelize shared-repo tasks only when `depends_on` or separate git worktrees prevent file conflicts.
- **Never** invent, infer, or auto-generate `bucket_dir`, `entity_id`, `mode`, or `tags`. If `bucket_dir`, `entity_id`, or `mode` (`once` vs `ongoing`) is missing, ask the user and wait.
- Treat all other `entity_id` values as anonymous peers. Never assume what tool, model, script, or human sits behind another `entity_id`.
- Ensure `<bucket_dir>/pending`, `<bucket_dir>/active`, and `<bucket_dir>/archive` exist before operating.
- If `<skill_dir>/scripts/wb.mjs` and `node` (Node 20+) are available, prefer `node "<skill_dir>/scripts/wb.mjs"` subcommands (`watch`, `claim`, `post`, `create`, `render`) for atomic operations and zero-token waiting; otherwise execute the identical filesystem rules below directly.

## 2. Directory Layout & File Rules
- `<bucket_dir>/pending/<task_id>/task.md` + `events/` - Unclaimed tasks (`<task_id>` = `YYYYMMDDTHHMMSSZ-<short-slug>`). Ignore folders missing `task.md` and dotfiles (`.*`).
- `<bucket_dir>/active/<task_id>/task.md` + `events/` - Claimed tasks (folder path stays fixed across `in-progress`, `blocked`, and `review`).
- `<bucket_dir>/archive/<task_id>/task.md` + `events/` - Closed tasks (`complete` or `cancelled`).
- **Immutable `events/` stream:** Append history solely by creating new files named `<YYYYMMDDTHHMMSSZ>-<entity_id>-<type>.md` inside `<task_id>/events/` (via `.<file>.tmp` -> rename). **Never edit or delete an existing file in `events/`.**
- **Single-writer rule on `task.md`:** Only `claimed_by` edits `task.md` while `status == in-progress`; only `owner` edits `task.md` while `status` is `blocked` or `review`. Always write `task.md` via `.task.md.tmp` -> rename, quote all YAML strings (`"..."`), and strip `\r`.
- **Payload-before-flag rule:** Always publish the new file in `events/` *before* updating `task.md` `status`.

## 3. Creating, Amending & Reviewing Tasks (Owner Role)
- **Creating:** Create `<bucket_dir>/pending/<task_id>/events/`, write `<UTC>-<entity_id>-created.md`, and atomically publish `task.md` with:
  - Frontmatter: `id`, `title`, `status: "pending"`, `priority`, `tags: []` (e.g., `["windows"]`, `["macos"]`, `["linux"]`), `owner: "<entity_id>"`, `claimed_by: ""`, `assignee: ""`, `parent: ""`, `depends_on: []`, `revision: 1`, `updated_by: "<entity_id>"`, `updated_at: "<ISO-8601 UTC>"`.
  - Body: `## Context & Target` (workspace path and target files), `## Description`, and numbered `- [ ] #N` `## Acceptance Criteria` including an exact verification command.
- **Amending Mid-Flight:** Never edit `active/<task_id>/task.md` while `status == in-progress`. Publish `active/<task_id>/events/<UTC>-<entity_id>-amend.md` instead.
- **Answering Blocked Tasks:** For `active/<task_id>/task.md` where `owner == <entity_id>` and `status == blocked`, publish `events/<UTC>-<entity_id>-answer.md`, then update `task.md` (`revision + 1`, `status: "pending"`, `claimed_by: ""`, pinning `assignee` to the prior executor in `active/` so they retain context, or `--reopen` to `pending/` with `assignee: ""` to open to any executor).
- **Reviewing & Closing:** For `active/<task_id>/task.md` where `owner == <entity_id>` and `status == review`, inspect `events/`, workspace diffs, and test output. Either:
  - Publish `events/<UTC>-<entity_id>-complete.md`, update `task.md` (`status: "complete"`, `claimed_by: ""`), and move `active/<task_id>` to `archive/<task_id>`, **or**
  - Publish `events/<UTC>-<entity_id>-feedback.md`, increment `revision`, set `status: "pending"`, clear `claimed_by: ""`, and pin `assignee` to the prior executor in `active/<task_id>/task.md` (or `--reopen` to `pending/` with `assignee: ""`), **or**
  - To cancel a task, publish `events/<UTC>-<entity_id>-cancelled.md`, set `status: "cancelled"` and `claimed_by: ""`, and move to `archive/<task_id>`.
- **Stale Recovery:** If an `in-progress` task in `active/` goes stale, `owner` publishes `events/<UTC>-<entity_id>-reset.md`, sets `status: "pending"`, `claimed_by: ""`, `assignee: ""`, and moves `active/<task_id>` back to `pending/<task_id>`.

## 4. Claiming, Decomposing & Executing Tasks (Executor Role)
1. **READY Gate:** Enforce a WIP limit of **1 active `in-progress` task** per `entity_id` (`review` and `blocked` tasks in `active/` do **not** consume WIP, so you remain eligible to claim new `pending/` tasks while earlier tasks await review or answers; in `multithreaded` mode allow up to `max_workers` subagents, each with its own `entity_id`). Scan (or run `wb.mjs watch` with any configured `--tag` / `--include-untagged` flags):
   - `active/*/task.md` where `status == pending` and `assignee == <entity_id>` (resume your own unblocked/rejected tasks first; direct `assignee` matches bypass tag filters), then
   - `pending/*/task.md` where `status == pending`, `claimed_by == ""`, and `assignee` is `""` or `<entity_id>`.
   - **Tag filter check:** If session capability `tags` are configured, require every tag in `task.tags` to be present in your configured `tags`, and ignore untagged tasks (`tags: []`) unless `--include-untagged` was specified (or `assignee == <entity_id>`).
   - **Dependency check:** Require every `<dep_id>` in `depends_on` to have `status: "complete"`. Sort eligible tasks by `priority` (`critical` > `high` > `medium` > `low`), tie-breaking by oldest `<task_id>`.
2. **Atomic Claim:**
   - If claiming from `pending/`, atomically move the folder (`wb.mjs claim`, POSIX `mv`, or PowerShell `Move-Item -ErrorAction Stop`). If the source folder vanished, another entity claimed it first - silently skip to the next candidate.
   - Publish `active/<task_id>/events/<UTC>-<entity_id>-claimed.md`, update `task.md` (`status: "in-progress"`, `claimed_by: "<entity_id>"`, `updated_at: "<UTC>"`), and record the latest filename in `events/` as `last_event_seen`.
   - In `multithreaded` mode, pass the candidate `--task <task_id>` (or worker `entity_id`, `bucket_dir`, and `tags`) to a spawned subagent so it claims and executes in an isolated context while the dispatcher stays in `wb.mjs watch`.
3. **Checkpoint & Amendment Check:** Before modifying workspace files and before finalization, refresh `updated_at` (heartbeat) and check `active/<task_id>/events/` for any files newer than `last_event_seen`. If new `*-amend.md` files exist, read all of them in chronological order, merge changes into `task.md` (incrementing `revision`), publish a `*-log.md` event noting incorporation, and advance `last_event_seen`.
4. **Subtask Decomposition (Optional):** You may split an oversized task into child tasks (`parent: "<task_id>"`, `owner: "<entity_id>"`, plus platform/capability `tags`) in `pending/`, append all child IDs to the parent's `depends_on`, publish a `*-log.md` event, and set the parent to `status: "pending"`, `assignee: "<entity_id>"`, `claimed_by: ""` in `active/`. Execute/review the children until all are `complete`, then resume the parent to verify its `## Acceptance Criteria`.
5. **Assume & Flag Execution Policy:**
   - Make tentative, idiomatic decisions on straightforward, reversible details without stopping, and log every assumption in `events/<UTC>-<entity_id>-log.md`.
   - **Hard Stop (Halt Immediately)** if: (a) an unexpected public API, schema, wire protocol, or dependency change is required, (b) requirements conflict or allow two fundamentally different designs, or (c) verification still fails after **2 fix attempts**.
6. **Halt, DONE Gate, Rework & Continuity:**
   - **If Blocked / Halted:** Publish `events/<UTC>-<entity_id>-question.md`, then set `task.md` `status: "blocked"` (leave in `active/<task_id>/`).
   - **If Complete (DONE Gate):** Verify every acceptance criterion passes, check `- [ ]` to `- [x]` (pass `--check-ac` to `wb.mjs post`), publish `events/<UTC>-<entity_id>-review.md` with files changed, verification command output, and tentative assumptions, then set `task.md` `status: "review"` (leave in `active/<task_id>/`). Do not pass `--bump-revision` on `review`.
   - **Rework after `feedback`:** Resume the `active/` task via `claim`, read the new `*-feedback.md` event(s), apply fixes, re-verify, optionally post `--type log`, and run `wb.mjs post --type review --status review --check-ac` (no `--bump-revision`).
   - **Next step (`once` vs `ongoing`):**
     - If `once`: Run `wb.mjs watch --bucket <dir> --task <task_id> --since-status <review|blocked> --after-event <event> --json` until `stage == "archive"` (`complete`/`cancelled`), `stage == "pending"` (reopened to pool via `--reopen`), `reason == "removed"`, or `assignee` changes away from `<entity_id>`; if `status == "pending"` and `assignee == <entity_id>`, go to Step 2 (`claim`) and rework/continue; if still `review`/`blocked` (e.g., an intermediate event), advance `--after-event` and keep watching; otherwise exit cleanly.
     - If `ongoing`: **Never end your turn after posting `review`/`blocked` or closing an owned task.** Immediately loop back to Step 1 (`wb.mjs watch --bucket <dir> --entity <entity_id> [--tag ...]`) instead of `--task`. Because `feedback` and `answer` pin `assignee` in `active/`, `wb.mjs watch --entity <entity_id>` wakes on reopened tasks (or returns them ahead of `pending/` work after your current task finishes) without blocking new `pending/` tasks.

## 5. Optional Helper CLI (`scripts/wb.mjs`)
Do **not** read `scripts/wb.mjs` source; run `node "<skill_dir>/scripts/wb.mjs" <subcommand> --help` if you need flag details:
- `create`: `wb.mjs create --bucket <dir> --entity <id> --title <text> [--priority ...] [--tag <t>] [--assignee <id>] [--depends-on <ids>]`
- `claim`: `wb.mjs claim --bucket <dir> --entity <id> [--task <id>] [--tag <t>] [--include-untagged] [--json]`
- `post`: `wb.mjs post --bucket <dir> --entity <id> --task <id> --type <type> -m <text> [--status <status>] [--bump-revision] [--check-ac] [--reopen]` (preserves `task.md` body unless `--check-ac` is passed; auto-pins `assignee` from `claimed_by` when returning `review`/`blocked` to `pending` in `active/`)
- `watch`: `wb.mjs watch --bucket <dir> [--entity <id>] [--task <id>] [--tag <t>] [--include-untagged] [--after-event <file>] [--json]` (exiting `124` on `--timeout` means no matching updates yet, not an error)
- `render`: `wb.mjs render --bucket <dir> --task <id> [--json]`
