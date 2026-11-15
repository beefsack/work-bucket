# work-bucket

A lockfile-free, entity-agnostic filesystem Markdown work bucket skill (`SKILL.md`) with an optional zero-dependency Node.js 20+ CLI (`scripts/wb.mjs`). Humans, LLM agents across any harness, and automated scripts collaborate through plain Markdown files, immutable event logs, and atomic directory renames.

## Installation

Install with [`skills`](https://github.com/vercel-labs/skills):

```bash
# Project-local
npx skills add beefsack/work-bucket

# Or global (across all projects)
npx skills add beefsack/work-bucket -g
```

Node.js 20+ is optional at runtime. If `node` is present, agents use `scripts/wb.mjs` for atomic operations and event-driven `watch` waits; otherwise they use standard filesystem moves and file edits directly.

When starting an agent session, provide two required inputs:
- `bucket_dir`: Path to the bucket root directory.
- `entity_id`: The opaque name for that participant (e.g. `alex`, `worker-linux-1`).
- Optional capability tags (e.g. `--tag linux`) and `--include-untagged`.

## How Humans Interact with the Bucket

A bucket has three directories:

```text
<bucket_dir>/
├── pending/   # Unclaimed tasks
├── active/    # Claimed tasks (in-progress, blocked, or review)
└── archive/   # Closed tasks (complete or cancelled)
```

Each task lives in `<stage>/<YYYYMMDDTHHMMSSZ>-<slug>/` and contains `task.md` (current state and specification) plus `events/` (immutable, timestamped Markdown files named `<UTC>-<entity_id>-<type>.md`).

You can manage tasks directly in any text editor or with `node scripts/wb.mjs`:

- **Create a task:** Run `wb.mjs create --bucket <dir> --entity <you> --title "..."` (or create `pending/<UTC>-<slug>/events/<UTC>-<you>-created.md` and `task.md`).
- **Amend a running task:** Never edit `active/<id>/task.md` while `status` is `in-progress`. Instead, drop a new file in `active/<id>/events/<UTC>-<you>-amend.md` (or run `wb.mjs post --type amend -m "..."`). The executor checks for new amendments at checkpoints and merges them.
- **Unblock a `blocked` task:** Read the latest `events/*-question.md`, post `events/<UTC>-<you>-answer.md`, increment `revision`, and set `status: "pending"` in `task.md` (or use `wb.mjs post --type answer -m "..." --status pending --bump-revision`).
- **Review a `review` task:** Inspect `wb.mjs render --bucket <dir> --task <id>` (or read `task.md` and `events/`).
  - Approve: post `events/*-complete.md`, set `status: "complete"`, `claimed_by: ""`, and move `active/<id>` to `archive/<id>` (or run `wb.mjs post --type complete`).
  - Request changes: post `events/*-feedback.md`, bump `revision`, and set `status: "pending"` (or run `wb.mjs post --type feedback -m "..." --status pending --bump-revision`).
  - Cancel: run `wb.mjs post --type cancelled`.

## License

[MIT](LICENSE)
