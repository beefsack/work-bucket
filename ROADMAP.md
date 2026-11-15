# work-bucket Roadmap & Ideas

## Design Principles
- **Low ceremony, high agency:** Prefer simple primitives and clear visibility over rigid gates or heavy validation that slow agents down. (For example, do not add hard circular-dependency blocking on `depends_on` so agents can invert dependency edges freely and untangle cycles if needed.)
- **Plain files first:** Human-readable Markdown + YAML frontmatter in directories remains the primary interface.
- **Public by default:** All files in a bucket are readable by every entity with access to the bucket directory.

## Near-Term Plans

### 1. Backlog & Draft / Ready Task State
- Support keeping unrefined tasks inside the bucket (`backlog/`) so humans and entities can view and refine them without workers prematurely claiming them.
- Differentiate unready vs ready tasks explicitly inside `task.md` (e.g., `draft` vs `ready` state/flag in addition to directory placement) plus simple promotion tooling in `scripts/wb.mjs`.

### 2. Public Broadcast & Targeted Messaging
- Add an append-only messaging mechanism (`messages/`) for cross-cutting announcements (such as breaking changes) without misusing single-consumer tasks.
- Support optional targeting metadata (`to` entity IDs / `"*"` broadcast and capability `tags`) while documenting clearly that **all messages are public** and readable by every entity in the bucket.

### 3. Shared Directory Remote Collaboration
- Keep remote multi-machine support focused on user-configured shared POSIX-like directory mounts (e.g., SMB, NFS, SSHFS) where atomic `rename` holds.
- Review cross-host edge cases such as slight clock skew affecting event timestamps/ordering and network-mount `fs.watch` polling behavior.

## Future / Unprioritized Ideas
- **Eventually-consistent consumer cloud sync folders (Dropbox / Google Drive / Syncthing):** Explore lockless/conflict-tolerant claim protocols (such as per-entity claim proposals or conflict-copy resolution) so atomic directory `rename` is no longer required.
- **Optional remote HTTP + SSE/WebSocket server mode:** A lightweight server wrapping the on-disk Markdown bucket for true push wakeups across machines without requiring a shared filesystem mount. (Deferred because it makes direct human file interaction harder than plain directory shares.)
- **Dogfooding repo tasks:** Manage `work-bucket` repo tasks inside a local `backlog/` once backlog/draft support is implemented.
