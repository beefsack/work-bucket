# Stateful E2E playbook

Use one fresh temporary bucket and workspace throughout; retain them for inspection. Follow [SKILL.md](../SKILL.md) for role procedures and waiting. Commands below abbreviate `node "$SKILL_DIR/scripts/wb.mjs"` as `wb` and omit the common `--bucket "$BUCKET"` and acting `--entity <actor>` arguments.

## Fixture

```bash
BUCKET=$(mktemp -d)
WORKDIR=$(mktemp -d)
cat >"$BUCKET/bucket.md" <<'CONFIG'
---
sync: local
default_ttl_seconds: 10
---
CONFIG
```

Participants: `owner`, continuous executor `continuous`, dispatcher `dispatch` (one slot), and fresh once children `child-1` through `child-4`. Executor filter: `--tag e2e`.

| Setup | Expected |
| --- | --- |
| Write `INSTRUCTIONS.md`: "Keep evidence in the fixture workspace." | Bucket rule selected by all claims |
| Owner `tag set --tag e2e -m "Use exact fixture text."` | `tag list --json` reports documented e2e |
| Start owner and continuous pool watches | Presence/delivery registered; notices after this point are deliverable |

## A. Owner and continuous executor

| Action | Expected |
| --- | --- |
| Owner `create --title "Write first file" --status draft --tag e2e,alt --ac "Write ok-1 to t1.txt and verify exact content"`; save ID as T1 | Draft absent from pool |
| Owner `promote --task T1 --status ready`, then `promote --task T1` | Ready absent from pool; pending delivered via OR tag match |
| Continuous `claim --task T1 --tag e2e --json` | Top-level in-progress summary, instructions and unread events |
| Write `ok-1` to workspace t1.txt; verify `grep -qx ok-1 "$WORKDIR/t1.txt"`; `review --task T1 --ac 1=pass --proposed-outcome pass --stdin` using the SKILL evidence template | Review event stores verdict; brief box remains unchecked |
| Owner `complete --task T1 --accept-ac` | Complete, checked criterion, outcome pass |
| Owner creates T2 with criterion "Write alpha and verified on separate lines in t2.txt"; brief requires asking which first-line value to use | Pending work |
| Continuous claims T2, then `question --task T2 -m "Choose first-line value"` | Blocked, owner wake |
| Owner `answer --task T2 -m "Use alpha"` | Pending pin to continuous; revision/round advance |
| Continuous reclaims, writes alpha only, verifies, reviews `--ac 1=fail --proposed-outcome fail` | Failed result reported without ticking brief |
| Owner `feedback --task T2 -m "Append verified"`; continuous reclaims, appends verified, verifies and reviews `--ac 1=pass --proposed-outcome pass` | Rework retains standalone pin; new round evidence |
| Owner `complete --task T2 --accept-ac` | Complete, checked criterion |
| Owner sends a notice `msg send --to continuous -m "Confirm receipt"`; continuous replies to owner | Both pollers receive once; `msg list --all` retains public notices |

## B. Dispatcher, receipts and fresh-child rework

| Action | Expected |
| --- | --- |
| Start dispatch pool watch; owner creates T3 pinned with `--assignee dispatch`, tag e2e and criterion "Write corrected to t3.txt" | Dispatcher sees new pinned work |
| Dispatch hands T3 to child-1 and excludes T3 from its watch; child-1 `claim --task T3 --dispatcher dispatch --json` | Child relationship recorded; settling task is not redispatched |
| Owner `amend --task T3 -m "Use corrected, not initial"`; append "Verify exact content." to INSTRUCTIONS.md | Outstanding amend and new rule version |
| Child-1 attempts `review --task T3 --ac 1=pass --proposed-outcome pass` | Refused, no review publication |
| Child-1 reads correction, `accept-amends --task T3`, then `ack-instructions --task T3 --json` | Receipt cursor advances; rule diff contains added text |
| Child-1 writes/validates corrected, reviews with verdict/evidence, ends identity and returns | No child pool/message watch; dispatcher removes exclusion |
| Owner `feedback --task T3 -m "Repeat exact-content verification"` | Pending assignee dispatch, affinity child-1 |
| Dispatch spawns child-2; `claim --task T3 --dispatcher dispatch --json` | Fresh child claims pin after positive settle; feedback visible, accepted amend absent from unread events |
| Child-2 verifies, reviews, ends and returns; owner `complete --task T3 --accept-ac` | Complete, verdict applied |
| Send a direct notice to child-2 without force | Exit 2; no message published |

## C. Stopped child and checkpointed recovery

| Action | Expected |
| --- | --- |
| Owner creates T4 pinned to dispatch, with a file-writing criterion; child-3 claims using recorded dispatcher | In-progress, auto-registered claimant |
| Child-3 writes partial content, then `checkpoint --task T4 --files-touched <workspace-file> --notes "Partial content; resume by replacing it; no live resources"` | Structured manifest visible in render/watch |
| Stop child-3 before review; inspect its workspace, checkpoint and any process state | No concurrent execution before recovery |
| Dispatch `release --task T4 --files-touched <workspace-file> --notes "Child stopped; replace partial content; no live resources"` | Pending dispatcher pin, child-3 affinity, round advances |
| Fresh child-4 claims, replaces partial content, verifies, reviews and ends; owner completes with `--accept-ac` | No same-round competing execution; complete |
| Extra short-TTL task: stop a claimant's wrapper forcibly after its start checkpoint; owner watches | Abandoned advisory, task still in-progress; owner inspects before `reset` or `cancel` |

## D. Delivery, pause and rollover checks

| Probe | Expected |
| --- | --- |
| Owner watch immediately after consuming a review/blocked edge, with `--timeout 1` | Exit 124; `--all-actionable` still returns unresolved work |
| Post a new log while actionable; rewatch normally | New edge delivered once; cursor survives entity registration |
| Review body over five lines; compare default watch, `--event-lines 2`, `--include-events` | Five-line/two-line previews versus full surfaced bodies; verdict metadata retained |
| Compare `render --tail-events 2`, `--latest-event`, `--after-event <cursor>` and `list --status review,blocked --json` | Top-level summary fields; list envelope `{count,tasks}` |
| `bucket pause -m "Fixture pause"`; try claiming pending work and poll pool | Claim exit 4; paused pool has no work; owner can still review |
| `bucket resume`; explicitly resume executor loop | Positive-settle claims work again |
| Transfer an armed task watch: record baseline/cursor/handle, stop it, post feedback, then re-arm with saved `--after-event` and `--since-status review` | Immediate pending update, no predecessor watcher remains |
| Transfer dispatcher watch ownership and active child IDs; re-arm with only current active exclusions | Existing dispatcher pins delivered; active children not duplicated |
| Time initial claim and feedback reclaim under local config | Both elections settle; render reports the elected winner |
| Wrap a command longer than TTL/2 with `run --task <id> --log <workspace-log> -- <command>` | Heartbeats preserve liveness; start/exit checkpoints and log agree with command result |

## Final checks

| Check | Pass condition |
| --- | --- |
| T1-T4 renders | Complete, owner-applied boxes; T2 answer/feedback and T3 dispatcher/fresh-child history retained |
| Workspace | t1 equals ok-1; t2 contains alpha then verified; t3 equals corrected; T4 has no partial content |
| `fsck --json` | No drift or invalid snapshots |
| `status --json` | No unexpected active work/resources; waiting parties and any retained fixture alerts accurate |
| End participants; `entity list --all --json` | Explicit ended identities retained; no test watcher or fixture process left running |
