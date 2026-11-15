# work-bucket Roadmap & Ideas

## Design Principles
- **Low ceremony, high agency:** Prefer simple primitives and clear visibility over rigid gates or heavy validation that slow agents down. (For example, do not add hard circular-dependency blocking on `depends_on` so agents can invert dependency edges freely and untangle cycles if needed.)
- **Plain files first:** Human-readable Markdown + YAML frontmatter in directories remains the primary interface.
- **Public by default:** All files in a bucket are readable by every entity with access to the bucket directory.

## Implemented Foundations

- **Backlog & `draft` / `ready` task state:** `backlog/` holds `status: "draft"` and held-back `status: "ready"` tasks separately from `pending/`, with `create --backlog` and `post --status <draft|ready|pending>` transitions.
- **Public broadcast & targeted messaging (`messages/`):** Append-only `messages/<UTC>-<entity>-<slug>.md` with `to` (`["*"]` or entity IDs) and `tags`, per-entity `last_msg_seen` cursor, relevance filtering, and burst coalescing in `watch`.
- **Advisory entity & tag discovery (`entities/`, `tags/`):** TTL-based peer presence files (`entity register` / `entity list`), optional `tags/<tag>.md` descriptions (`tag set` / `tag list`), and non-worker `owner` mode (`watch --owner-only`).
- **Shared-directory remote collaboration:** POSIX-like mounts (SMB, NFS, SSHFS) using atomic `rename`, `1000ms` stat polling, and NTP-synced host clocks.

## Future / Unprioritized Ideas
- **Message archiving & pruning:** Revisit retention, archiving, or compaction for `messages/` once buckets accumulate significant message history.
- **Boolean / logical tag expressions:** Support `AND` / `OR` / `NOT` task tag requirements if `OR` matching plus combined tags (such as `macos-worker`) proves insufficient.
- **Configurable owner wake filters:** Allow owners to optionally opt into wakes on intermediate `log` events in addition to actionable `blocked` / `review` status changes.
- **Eventually-consistent consumer cloud sync folders (Dropbox / Google Drive / Syncthing):** Explore lockless/conflict-tolerant claim protocols (such as per-entity claim proposals or conflict-copy resolution) so atomic directory `rename` is no longer required.
- **Optional remote HTTP + SSE/WebSocket server mode:** A lightweight server wrapping the on-disk Markdown bucket for true push wakeups across machines without requiring a shared filesystem mount. (Deferred because it makes direct human file interaction harder than plain directory shares.)
- **Dogfooding repo tasks:** Manage `work-bucket` repo tasks inside a local `backlog/` directory.
