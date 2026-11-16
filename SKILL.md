---
name: work-bucket
description: Lockfile-free, entity-agnostic filesystem Markdown work bucket with immutable event logs and capability tag routing for creating, claiming, decomposing, executing, clarifying, and reviewing work.
---

# Work-bucket

Use `node "<skill_dir>/scripts/wb.mjs"` (Node.js 20+), abbreviated `wb` below. Add `--bucket <bucket_dir>` to every command and `--entity <entity_id>` when acting. Use `wb --help` for commands and `<command> --help` for flags.

| Input | Use |
| --- | --- |
| Required | Obtain `bucket_dir`, `entity_id`, and `mode` (`owner`, `once`, `continuous`) from the caller; ask for missing values. |
| Executor filters | Use supplied `--tag` and `--include-untagged`; do not invent capabilities. |
| Dispatcher | Obtain `max_workers` and child agent/model settings from the caller. Treat peer IDs as opaque; discover peers with `entity list`/`tag list`. |
| Bucket writes | Use the CLI for task/entity/event/message mutations. Keep task paths fixed and existing events/messages immutable. |

## Owner

1. Put shared rules in `INSTRUCTIONS.md` or `tags/<tag>.md` bodies. Create task-specific briefs with scope, verification commands and numbered acceptance criteria (`- [ ] #N ...`, or `create --ac`). Use `create --status draft|ready` to hold work, then `promote` to release it.
2. Arm `watch --owner-only --json`. Inspect delivered questions, reviews and evidence with `render --task <id> --after-event <cursor>`; use the transition table to answer, request rework, close or cancel. Apply accepted verdicts with `complete --accept-ac`.
3. Send corrections through the channel table. After a failed bulk amend, inspect the reported completed IDs and stopped task before retrying.
4. Investigate stall alerts with `status`, the workspace diff, process state and checkpoint manifests. Resolve dead pending pins with `amend --assignee <dispatcher-or-executor>` or `--assignee ""`; recover stopped in-progress work with `reset`, or cancel it. Do not treat TTL expiry alone as proof that execution stopped.
5. On resumption, inspect `status` and `watch --owner-only --all-actionable` to recover delivered but unresolved work. Follow the wait/rollover table when re-arming.
6. When the assigned unit is terminal or needs escalation, stop its watcher, run `entity end` and report through the parent harness. Do not pause the bucket merely to exit.

## Dispatcher

1. Register with `entity register --mode continuous` and supplied filters. Restore active child IDs, task IDs and watcher ownership on resumption; inspect `status` and checkpoints before dispatching replacements.
2. Arm `watch --json` with supplied filters and `--exclude-task <id>` for each active child, including settling claims. Use `--owner-only` while all worker slots are occupied; on a child return, stop that watcher and re-arm the pool watch.
3. Dispatch up to `max_workers`. Give each new child a fresh entity ID, task ID, bucket, dispatcher ID, scope and the dispatcher-child procedure. Prefer resuming the `affinity` session for rework when available; otherwise spawn a fresh child. Parallelize workspace writes only when dependencies or separate worktrees prevent conflicts.
4. Remove a task's exclusion when its child returns. If it remains in-progress, inspect the tree, processes and checkpoint manifest: resume the same child identity without claiming again, or, after execution stops, `release --task <id> --notes <resume-state>` with its files/resources and dispatch a fresh child. Escalate unsafe recovery to the owner.
5. On pause, stop children at checkpoints and suspend pool watches until explicitly resumed; retain owner-only watching for notices or owned decisions. On bounded exit, stop the watcher, settle or hand back active children, run `entity end` and report through the harness.
6. Before rollover, transfer active child/task IDs, event cursors and the known watcher handle/PID. On resumption, stop that watcher and promptly re-arm from those cursors and current active-child exclusions before waiting.

## Dispatcher-child

1. For pending work, run `claim --task <id> --dispatcher <dispatcher-id> --json`. For interrupted in-progress work under this same identity, inspect its checkpoint and workspace. Then follow Execute.
2. Run `entity end` and return the task ID, status and latest event to the dispatcher immediately after review, question or handback. Leave pool/message watching to the dispatcher.

## Standalone (`once` / `continuous`)

1. On resumption, inspect `status`: resume your in-progress task from its checkpoint or restore the saved wait using the rollover table. For new work, arm `watch --json` with supplied filters and claim a surfaced task with `claim --task <id> --json`. For claimed or resumed execution, follow Execute.
2. After release, exit via step 4. In `once` mode after review/question, watch the task with `--task <id> --since-status <review|blocked> --after-event <last-event> --json`. Reclaim pending work pinned to you, then follow Execute; advance the cursor after intermediate events. Exit on complete, cancelled, removed, unassigned pending work or reassignment away from you.
3. In `continuous` mode, re-arm the pool watch after review/question and handle owned decisions using the owner procedure. On pause, stop execution at a checkpoint and suspend pool watches until explicitly resumed.
4. Follow the wait/rollover table. On actual exit, stop the watcher, run `entity end` and report through the harness.

## Execute

1. Read the brief, returned `instructions` and `unread_events`; follow the execution checkpoint table.
2. Resolve reversible details within scope and log material assumptions. Use `question --task <id>` with the decision needed for conflicts or changes outside scope.
3. Verify the criteria, then submit `review --task <id> --ac N=pass|fail|not-run --proposed-outcome <outcome>` with the review body below. For an early handback, use `release` with a checkpoint containing cleanup/resume notes and files/resources.

## Execution checkpoints

| When | Action |
| --- | --- |
| Between legs | Stop if the bucket is paused or `render --json` `claim_winner` is not you. Apply events after your cursor. Refresh presence with `entity register` if the next leg is unwrapped and may exceed TTL. |
| Outstanding amends | Read and apply them, then `accept-amends`. Exclude a correction only with `--ignore-amend <event-file> --reason <text>`. |
| Standing rules changed | Run `ack-instructions`, read its diff and apply it before continuing. |
| Command expected to exceed TTL/2 | Use `run --task <id> [--log <file>] -- <command> [args...]`. |
| Risky leg, interruption or handback | Record `checkpoint --notes <resume-and-cleanup-state>` with `--files-touched` and `--resources`; inspect and settle resources before replacement execution. |
| Oversized task | Agree child scope and parent dependency edits with its owner; create children with `--parent <id>`. Review children before returning to the parent's criteria. |

## Waiting and rollover

| Situation | Action |
| --- | --- |
| Background-completion harness | Keep one watcher per entity; arm without `--timeout`, print a `waiting:` line from `status`, then end the turn. |
| Foreground-only harness | Watch with `--timeout` below the tool limit; re-arm after 124 or an outer timeout while still waiting. |
| Rollover | Transfer task IDs, status baselines, event cursors and watcher handle/PID. Stop the known predecessor watcher before re-arming. Task waits reuse `--after-event`/`--since-status`; pool/owner waits reuse entity cursors. |
| Unexpected identity-sharing warning | Resolve sharing with the caller; reuse any caller-supplied session nonce rather than inventing a replacement identity. |

## Transition reference

| Intent | State change | Actor |
| --- | --- | --- |
| `create`; `promote` / `demote` | New draft/ready/pending; draft/ready toward pending / ready/pending toward draft | Owner |
| `claim` | pending -> in-progress | Eligible executor |
| `review` / `question` | in-progress -> review / blocked | Claimant |
| `feedback` / `answer` | review / blocked -> pending; pin dispatcher or standalone claimant, retain child affinity | Owner |
| `release` | in-progress -> pending with checkpoint; same pin/affinity rule | Claimant or recorded dispatcher |
| `reset` | in-progress -> unpinned pending | Owner |
| `complete` / `cancel` | Non-terminal -> complete / cancelled | Owner |
| `amend` | Correction; metadata edits on unclaimed draft/ready/pending | Owner |
| `accept-amends` / `ack-instructions` | Receipt / rule-version update in-progress | Claimant |
| `log`, `post`, `checkpoint`, `run` | Append / execute, no lifecycle transition | Owner, claimant or recorded dispatcher |

## Channels

| Content | Destination |
| --- | --- |
| Shared rules | `INSTRUCTIONS.md`, `tags/<tag>.md` bodies |
| Active task correction | `amend --task <id>`; bulk: `amend --all-in-progress [--tag <tag>]` |
| Review rework / blocked continuation | `feedback` / `answer`; add `--reopen` to return to the pool |
| Public notice | `msg send`; keep secrets out of all bucket files |
| Parent report / bucket pause | Harness / `bucket pause` and `bucket resume` |

## Review body

| Result | Evidence |
| --- | --- |
| <observed result; label inference> | <file:line; command and result> |

Unverified: <items or none>.

## Exit codes

| Exit | Meaning |
| --- | --- |
| 0 / 1 | Success / usage, validation or not-found |
| 2 / 3 / 4 | No work, ineligible or non-polling recipient / conflict, race or permission / paused |
| 124 / 130 | Watch timeout / interrupted watch |
| `run` | Child exit; spawn failures 126/127; termination 128 + signal number |
