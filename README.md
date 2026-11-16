# work-bucket

A filesystem Markdown work bucket for humans, agents and scripts. Version 2.0.0 is a breaking protocol/CLI release.

## Installation

```bash
# Project-local
npx skills add beefsack/work-bucket

# Global
npx skills add beefsack/work-bucket -g
```

The zero-dependency CLI requires Node.js 20+. [SKILL.md](SKILL.md) is the agent procedure source; `node scripts/wb.mjs <command> --help` lists flags and examples.

## Concepts

| Item | Meaning |
| --- | --- |
| Bucket | Shared directory on local disk, a network mount or cloud-sync storage |
| Participant | Caller-supplied `entity_id`, `bucket_dir` and mode: `owner`, `once` or `continuous`; optional capability tags |
| Owner / executor | Brief and acceptance authority / elected task claimant |
| Dispatcher / child | Long-lived routing identity / recorded one-shot executor; rework pins the dispatcher with child affinity |
| Task | Fixed `tasks/<id>/task.md` plus immutable `events/`; draft, ready, pending, in-progress, blocked, review, complete or cancelled |
| State | Task frontmatter materialized from immutable event snapshots; claim intents elect a winner before a separate claim-committed snapshot |
| Liveness | Advisory presence, process-backed heartbeats, checkpoints and stall alerts; never automatic reassignment |
| Instructions / notices | Versioned `INSTRUCTIONS.md` and `tags/<tag>.md` bodies / immutable public `messages/` |
| Presence | Advisory `entities/<id>.md` with lifecycle, dispatcher relationship and delivery cursors |
| Privacy | Everyone with bucket access can read every bucket file, including targeted messages |

`fsck` checks replay without writing. `fsck --repair` rebuilds unambiguous non-terminal frontmatter, preserving bodies; terminal and snapshot-free legacy tasks are not rewritten. Historical legacy revision/round anomalies remain reported.

## bucket.md

The bucket owner configures deployment-wide settings at the bucket root:

```yaml
---
sync: local
claim_settle_ms: 250
default_ttl_seconds: 300
msg_coalesce_ms: 500
abandoned_ttl_multiplier: 3
pinned_idle_seconds: 600
unclaimed_seconds: 600
---
```

| Setting | Default / constraint |
| --- | --- |
| `sync` | `shared`; `local`, `shared` or `cloud` |
| `claim_settle_ms` | 250 for local, 2000 otherwise; positive integer for every election |
| `default_ttl_seconds` | 300; positive integer |
| `msg_coalesce_ms` | 500; non-negative integer |
| `abandoned_ttl_multiplier` | 3; integer >= 2 |
| `pinned_idle_seconds`, `unclaimed_seconds` | 600 each; positive integers |

`fsck` and `status` report sync-conflict copies in a bucket configured as local.

## Migration to 2.0.0

| Previous contract | Replacement |
| --- | --- |
| Per-call `--claim-settle-ms`; pinned settle bypass | Positive `claim_settle_ms` in `bucket.md` for every election |
| Watch `--ttl` / `--msg-coalesce-ms` | `default_ttl_seconds` / `msg_coalesce_ms` in `bucket.md` |
| Second-precision filenames | Millisecond filenames; old names remain readable |
| All historical entities in default discovery | `entity list --all`; `entity end` records exit |
| `post --type <lifecycle> --status ...` | `review`, `question`, `feedback`, `answer`, `reset`, `complete`, `cancel`, `promote`, `demote`, `release` |
| Generic `post` metadata/state changes | `post` appends log/note; owner `amend` edits unclaimed draft/ready/pending metadata |
| `post --type log --accept-amends` | `accept-amends` |
| `--bump-revision` | Intent-specific revision/round updates |
| `--check-ac` | `review --ac N=pass\|fail\|not-run --proposed-outcome ...`; owner `complete --accept-ac` |
| `--body`, `--tags` | `-m`/`--message`, `--body-file`, `--stdin`; repeatable/comma-split `--tag` |
| Nested `task` / `task_id` JSON | Top-level task summary with `id` |
| Claim not-found/paused/conflict all exit 2 | Not-found 1, conflict/permission 3, paused 4 |
| Rework pinned to ephemeral child | Recorded dispatcher pin plus child `affinity` |
| Manual claim registration/long-leg heartbeats | Automatic claim registration; `run -- <command>` |
| Direct child messages | Receipted task amendments; messages remain notices |
| Unversioned standing instructions / optional receipts | Claim rule snapshot; `ack-instructions` and `accept-amends` |

## Tests

```bash
npm test
```

Stateful integration scenarios: [test/E2E_PLAYBOOK.md](test/E2E_PLAYBOOK.md).

## License

[MIT](LICENSE)
