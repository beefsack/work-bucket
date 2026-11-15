# work-bucket

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
- **Unblock a `blocked` task:** Read the latest `events/*-question.md`, post `events/<UTC>-<you>-answer.md`, increment `revision`, and set `status: "pending"` in `task.md` (or use `wb.mjs post --type answer -m "..." --status pending --bump-revision`).
- **Review a `review` task:** Inspect `wb.mjs render --bucket <dir> --task <id>` (or read `task.md` and `events/`).
  - Approve: post `events/*-complete.md` and set `status: "complete"`, `claimed_by: ""` (or run `wb.mjs post --type complete`).
  - Request changes: post `events/*-feedback.md`, bump `revision` and `claim_round`, and set `status: "pending"` (or run `wb.mjs post --type feedback -m "..." --status pending --bump-revision`).
  - Cancel: run `wb.mjs post --type cancelled`.
- **Send or read public messages:** Run `wb.mjs msg send --bucket <dir> --entity <you> [--to <id|*,...>] [--tag <t>] -m "..."` and `wb.mjs msg list --bucket <dir> --all`. All messages in `messages/` are public to everyone in the bucket.
- **Inspect active entities and tags:** Run `wb.mjs entity list --bucket <dir>` and `wb.mjs tag list --bucket <dir>` (document tags via `wb.mjs tag set --bucket <dir> --entity <you> --tag <name> -m "..."`).

## License

[MIT](LICENSE)
