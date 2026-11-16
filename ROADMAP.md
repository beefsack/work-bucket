# work-bucket Roadmap & Ideas

## Design Principles
- **Low ceremony, high agency:** Prefer simple primitives and clear visibility over rigid gates or heavy validation that slow agents down. (For example, do not add hard circular-dependency blocking on `depends_on` so agents can invert dependency edges freely and untangle cycles if needed.)
- **Plain files first:** Human-readable Markdown + YAML frontmatter in directories remains the primary interface.
- **Public by default:** All files in a bucket are readable by every entity with access to the bucket directory.

## Implemented in 2.0.0

| Area | Contract |
| --- | --- |
| State and authority | Central intent transitions; owner closure/recovery; immutable snapshots and `fsck` replay/repair |
| Claims and storage | Fixed task paths, positive bucket-configured settle for every election, separate winner snapshots, millisecond no-overwrite publication |
| Routing | Recorded dispatcher relationships, dispatcher pins with child affinity, fresh-child rework and checkpointed `release` |
| Liveness | Automatic claim registration, `run` heartbeats/process evidence, structured checkpoints and advisory stale/abandoned/pinned-idle/unclaimed alerts |
| Acceptance | Per-criterion review verdicts, proposed outcomes and owner `complete --accept-ac` |
| Corrections | Amendment receipts/explicit ignores, bulk corrections, versioned standing rules and acknowledgement |
| Visibility | Read-only `status`, normalized top-level summaries, filterable lists, bounded event previews and persisted watch cursors |
| Lifecycle | Explicit entity exit, historical discovery, terminal cursor pruning, backlog promotion/demotion and bucket pause/resume |
| Notices | Public targeted/broadcast messages, delivery declarations, unread cursors and burst coalescing |
| Agent interface | Role procedures in SKILL, parser-derived help/reference, uniform body/list flags and `npm test` |

## Future / Unprioritized Ideas
- **Message archiving & pruning:** Revisit retention, archiving, or compaction for `messages/` once buckets accumulate significant message history.
- **Boolean / logical tag expressions:** Support `AND` / `OR` / `NOT` task tag requirements if `OR` matching plus combined tags (such as `macos-worker`) proves insufficient.
- **Configurable owner wake filters:** Allow opt-in wakes for in-progress `log` events alongside actionable-task updates.
- **Optional remote HTTP + SSE/WebSocket server mode:** A lightweight server wrapping the on-disk Markdown bucket for true push wakeups across machines without requiring a shared filesystem mount. (Deferred because it makes direct human file interaction harder than plain directory shares.)
- **Dogfooding repo tasks:** Manage `work-bucket` repo tasks inside a local `tasks/` directory.
