# Work-Bucket E2E Playbook (Two-Entity Stateful Run)

A low-token, stateful integration test run in a single temporary bucket (`/tmp/wb-e2e-*`) without cleanup between steps. Designed to be executed by two peer agents (`lead` in `owner` mode and `worker-1` in `continuous` mode) using `work-bucket`.

## Setup

1. Create a fresh temp bucket and work dir (leave `/tmp/wb-e2e-*` in place after the run for inspection):
   ```bash
   BUCKET=$(mktemp -d /tmp/wb-e2e-XXXXXX)
   WORKDIR=$(mktemp -d /tmp/wb-e2e-work-XXXXXX)
   ```
2. Spawn two agents against `$BUCKET` (with `$SKILL_DIR` = installed `work-bucket` path):
   - **Agent A (`lead`):** `bucket_dir=$BUCKET`, `entity_id=lead`, `mode=owner`.
   - **Agent B (`worker-1`):** `bucket_dir=$BUCKET`, `entity_id=worker-1`, `mode=continuous`, `tags=["e2e"]`.

## Stateful Scenario Sequence

Run these in one continuous flow in `$BUCKET`:

1. **Discovery & Backlog Guard (`lead`):**
   - Document tag `e2e` via `wb.mjs tag set --bucket "$BUCKET" --entity lead --tag e2e -m "E2E test tasks"`.
   - Create **Task 1** as draft (`--backlog --tags "e2e,alt"`): write `ok-1` to `$WORKDIR/t1.txt` (`- [ ] #1` verified by `grep -qx ok-1 $WORKDIR/t1.txt`).
   - Mark **Task 1** `ready` (`post --type log --status ready`). Confirm `status` is `ready` in `tasks/` and it is not claimed by `worker-1`.
   - Promote **Task 1** to `pending` (`post --type log --status pending`).

2. **Ambiguous Task + Targeted Message (`lead`):**
   - Create **Task 2** in `pending` state (`--tag e2e`): *"Write either `alpha` or `beta` to `$WORKDIR/t2.txt` (do not guess - ask `lead` which value is wanted before writing)."*
   - Send a targeted message: `wb.mjs msg send --bucket "$BUCKET" --entity lead --to worker-1 -m "Reply via msg send --to lead confirming you saw this."`
   - Start watching in `owner` mode: `wb.mjs watch --bucket "$BUCKET" --entity lead --owner-only --json`.

3. **Execution, Question & Reply (`worker-1`):**
   - Claims **Task 1** via OR tag match (`e2e,alt` matches `e2e`), writes `$WORKDIR/t1.txt`, submits `review` (`--check-ac`).
   - Claims **Task 2**, hits ambiguity Hard Stop, posts `question` with `--status blocked`, and re-arms `watch`.
   - Wakes on `lead`'s message and sends `wb.mjs msg send --bucket "$BUCKET" --entity worker-1 --to lead -m "Confirmed receipt."`

4. **Review, Answer & Feedback Rework (`lead` <-> `worker-1`):**
   - `lead` wakes in `--owner-only` mode:
     - Approves **Task 1** (`post --type complete`).
     - Answers **Task 2** (`post --type answer -m "Use alpha." --status pending --bump-revision`), keeping `assignee: "worker-1"` and incrementing `claim_round`.
     - Re-arms `watch --owner-only`.
   - `worker-1` reclaims **Task 2**, writes `alpha` to `$WORKDIR/t2.txt`, submits `review` (`--check-ac`).
   - `lead` sends **1 feedback round** (`post --type feedback -m "Append a second line 'verified' to $WORKDIR/t2.txt" --status pending --bump-revision`) and re-arms `watch --owner-only`.
   - `worker-1` reclaims **Task 2**, appends `verified`, re-submits `review` (`--check-ac`).
   - `lead` approves **Task 2** (`post --type complete`) and exits/reports done.

## Loose Pass Gates

After both agents finish, run these checks against `$BUCKET`:

```bash
WB="node $SKILL_DIR/scripts/wb.mjs"
$WB entity list --bucket "$BUCKET" --json
$WB tag list --bucket "$BUCKET" --json
$WB msg list --bucket "$BUCKET" --all --json
ls "$BUCKET/tasks"
```

- [ ] `entity list` contains both `lead` (`mode: "owner"`) and `worker-1` (`mode: "worker"`, `tags: ["e2e"]`), both `online: true` with non-empty `last_msg_seen`.
- [ ] `tag list` shows `e2e` as `documented: true`.
- [ ] `tasks/` contains **2** completed tasks (`status: "complete"`, `- [x]` boxes checked).
- [ ] `wb.mjs render --bucket "$BUCKET" --task <task1_id> --json` shows `created` -> `log` (`ready`) -> `log` (`pending`) -> `claimed` -> `review` -> `complete`.
- [ ] `wb.mjs render --bucket "$BUCKET" --task <task2_id> --json` shows `revision >= 3`, `claim_round >= 3`, and events including `question`, `answer`, `review`, `feedback`, `review`, `complete`.
- [ ] `msg list --all` shows at least 2 messages (`lead` -> `worker-1` and `worker-1` -> `lead`).
- [ ] `$WORKDIR/t1.txt` equals `ok-1` and `$WORKDIR/t2.txt` contains `alpha` and `verified`.
