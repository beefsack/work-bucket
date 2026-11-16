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
- Intent commands share one transition-authority table. Complete, cancel and
  reset require ownership, including when the owner is also the executor.
  Append authority follows the elected claimant rather than a conflicting
  materialized claimant, and includes their recorded dispatcher.
- Generic post accepts only log/note and cannot change state, claim, metadata,
  revision or the brief. Owner metadata amendments are limited to unclaimed
  draft/ready/pending work; other amendments remain append-only.
- Body input is message/file/stdin, with mutually exclusive sources. Tags use
  only repeatable/comma-split `--tag`; all list-valued flags share that parsing.
  Task summaries are normalized at the top level, without nested task aliases.
- `--check-ac` was removed with generic brief mutation so it cannot bypass
  transition authority. Structured verdicts and owner acceptance remain in the
  review-verdict work. Amendment incorporation is now the `accept-amends` intent;
  receipt/instruction gating remains in the delivery work.
- Ownerless legacy records remain readable and claimable but confer no owner
  authority. Establish explicit ownership before owner transitions.

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
- Transition/CLI regression run: `npm test`, 60 passed, 0 failed (46 migrated
  foundation/regression tests plus 14 new enforcement/contract tests).
- Authority tests cover 448 intent/state/actor combinations, self-owned executor
  closure/recovery, in-progress owner cancellation, forged post refusals,
  metadata restrictions, settle-time revalidation and split-brain participants.
- All 28 command tables have executable fixture-checked examples, matching help
  options and clean unknown-flag/positional errors. All 18 body-writing commands
  share the same input flags and reject obsolete aliases or combined sources.
- Summary equality covers create/list/pool and owner watches/claim/transitions/
  render/task watches, including absent legacy fields. Exit-code checks include
  permissions, pause, timeout and both watch interruption signals.
- Explicit false boolean defaults preserve bounded watch previews; the migration
  regression that exposed undefined selecting full event bodies is covered.
- Syntax checks for both script modules and `git diff --check` pass. Claim races,
  asynchronous and slow-sync replicas, cursor/message delivery, nonces and replay
  remain covered through public intent commands rather than compatibility shims.
