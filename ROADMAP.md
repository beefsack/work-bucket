# work-bucket Roadmap & Ideas

## Design Principles
- **Low ceremony, high agency:** Prefer simple primitives and clear visibility over rigid gates or heavy validation that slow agents down. (For example, do not add hard circular-dependency blocking on `depends_on` so agents can invert dependency edges freely and untangle cycles if needed.)
- **Plain files first:** Human-readable Markdown + YAML frontmatter in directories remains the primary interface.
- **Public by default:** All files in a bucket are readable by every entity with access to the bucket directory.

## Implemented Foundations

- **Compact inspection:** `render --tail-events|--latest-event` and documented nested JSON; filterable `list` summaries by status/tag/owner.
- **Amendment incorporation:** Claims surface pre-claim/unaccepted amendments and recent feedback; `post --type log --accept-amends` appends amendments atomically with a revision bump, cursor and immutable incorporation log.
- **Stall, result and pause signals:** Deduplicated owner TTL-expiry alerts for registered executors, optional terminal outcome metadata, and plain `PAUSED` control (`bucket pause|resume`) that refuses claims without preventing owner review.

- **Quiet, evidence-rich watches:** Pool watches ignore current-round claims and support dispatched-task exclusions; owner delivery persists per-task event cursors with `--all-actionable` for level listings. Watch results include revision/round/executor and bounded latest/new event bodies, optionally expanded with `--include-events`.

- **Resumable agent loops and evidence:** Harness-aware background waiting, bounded-owner exits, dispatcher-only pool watching, standing bucket/tag instructions surfaced in claims, and compact raw-evidence review guidance.
- **Automatic rework revisions:** Feedback/answer returning actionable tasks to pending increment revision and claim round; legacy `--bump-revision` remains accepted without double increments. Amend warns on review/blocked without implicitly reopening.

- **Backlog & `draft` / `ready` task state:** `status: "draft"` and held-back `status: "ready"` tasks stay out of worker queues until promoted via `post --status pending`.
- **Public broadcast & targeted messaging (`messages/`):** Append-only `messages/<UTC>-<entity>-<slug>.md` with `to` (`["*"]` or entity IDs) and `tags`, per-entity `last_msg_seen` cursor, relevance filtering, and burst coalescing in `watch`.
- **Advisory entity & tag discovery (`entities/`, `tags/`):** TTL-based peer presence files (`entity register` / `entity list`), optional `tags/<tag>.md` descriptions (`tag set` / `tag list`), and non-worker `owner` mode (`watch --owner-only`).
- **Cloud-sync-safe unified `tasks/` & lockless 2-phase claims:** Fixed `tasks/<task_id>/` paths (no folder moves), `claim_round`-scoped `*-claimed.md` event elections with `--claim-settle-ms` (default `2000` ms), late-sync split-brain guards, conflict-copy resilience (`.sync-conflict-` / `conflicted copy`), and NTP clock guidance for both POSIX mounts (SMB/NFS/SSHFS) and consumer cloud sync folders (Syncthing, Dropbox, Google Drive, OneDrive).

## Future / Unprioritized Ideas
- **Message archiving & pruning:** Revisit retention, archiving, or compaction for `messages/` once buckets accumulate significant message history.
- **Boolean / logical tag expressions:** Support `AND` / `OR` / `NOT` task tag requirements if `OR` matching plus combined tags (such as `macos-worker`) proves insufficient.
- **Configurable owner wake filters:** Allow owners to optionally opt into wakes on intermediate `log` events in addition to actionable `blocked` / `review` status changes.
- **Optional remote HTTP + SSE/WebSocket server mode:** A lightweight server wrapping the on-disk Markdown bucket for true push wakeups across machines without requiring a shared filesystem mount. (Deferred because it makes direct human file interaction harder than plain directory shares.)
- **Dogfooding repo tasks:** Manage `work-bucket` repo tasks inside a local `tasks/` directory.
