# Protocol v2

## Goal and acceptance

Implement the approved R1-R16 recommendations: explicit transition authority,
dispatcher routing, process-backed liveness, review verdicts and receipts,
replayable state, bounded growth, and a consistent documented CLI.

## Approach

1. Foundation: immutable publication, bucket settings, state snapshots and fsck,
   legacy tolerance, entity lifecycle and cursor pruning, portable test entry.
2. Central transition table, intent verbs and uniform CLI contracts.
3. Dispatcher affinity, automatic registration, run/checkpoint/release, alerts
   and status.
4. Per-criterion review verdicts, message delivery declarations, instruction
   versions and amendment receipts.
5. Role procedures, migration and reference documentation, stateful scenarios.

Keep task paths fixed and event/message files immutable. Never automatically
reassign stalled work. Preserve legacy and terminal records during validation.

## Verification

Use the Node test runner for regression and refusal coverage, including claim
races, sync replicas, replay/repair, legacy records, and lifecycle housekeeping.
Check the documented test entry and command references against the implementation.

## Material decisions

- Bucket settings are deployment-wide; claim settle is always positive.
- Historical tasks without snapshots remain readable and are reported, not
  synthesized into authoritative history.
- Missing bucket settings retain shared-storage defaults (2000 ms settle);
  explicit local settings default to 250 ms. All elections settle.
- `claimed` events are immutable election intents. The winner publishes a
  separate `claim-committed` state snapshot before updating the task view.
- Snapshots include the full task frontmatter and a monotonic state sequence.
  Replay rejects divergent sequence branches and losing claim snapshots.
  Repair preserves the body and never rewrites terminal or snapshot-free tasks.
- Ended entities remain on disk. Default discovery hides ended identities and
  identities older than three TTLs; `--all` exposes their history.
- Known publication limit: on filesystems without hard-link support, exclusive
  creation prevents overwrite but exposes the final filename before the write
  finishes. Event/message readers tolerate malformed frontmatter as plain text;
  they do not retry it, and message cursors can advance past a partial notice.
  Atomic visibility therefore requires the hard-link publication path.

## Accepted evidence

- Foundation regression run: `npm test`, 46 passed, 0 failed.
- Concurrent immutable publication retains all 16 same-identity,
  same-millisecond payloads; exclusive-create fallback preserves prior files.
- Replay coverage includes frontmatter drift, invalid/divergent snapshots,
  losing elections, legacy revision mismatches, and terminal non-repair.
- A mutation during claim settle advances snapshots from sequence 1 to 2 to 3;
  the claim uses the fresh post-settle state and fsck reports no drift.
- A thousand terminal tasks incur no eligibility event-stream reads; a thousand
  terminal cursor entries are pruned while active/temporarily missing cursors
  survive. Entity lifecycle tests cover unauthorized ending and historical lists.
