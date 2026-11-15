import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  compareEventFilenames,
  parseFrontmatter,
  serializeFrontmatter,
  slugify,
} from "../scripts/wb.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WB_PATH = path.resolve(__dirname, "../scripts/wb.mjs");

function makeTempBucket() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "work-bucket-test-"));
}

function runWb(args, options = {}) {
  return spawnSync(process.execPath, [WB_PATH, ...args], {
    encoding: "utf8",
    ...options,
  });
}

function runWbJson(args) {
  const res = runWb([...args, "--json"]);
  assert.equal(
    res.status,
    0,
    `Expected exit 0 for wb ${args.join(" ")}, got ${res.status}\nstderr: ${res.stderr}\nstdout: ${res.stdout}`
  );
  return JSON.parse(res.stdout);
}

function runWbAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WB_PATH, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ status: code, stdout, stderr });
    });
  });
}

test("YAML frontmatter parsing handles CRLF, comments, quotes, and multiline arrays", () => {
  const raw = [
    "---",
    'id: "20261115T042000Z-test"',
    'title: "Fix \\"quoted\\" #hash"',
    "status: pending # inline comment",
    "tags:",
    "  - Windows",
    '  - "gpu"',
    'depends_on: ["dep-1", "dep-2"] # deps',
    "revision: 3 # rev",
    "---",
    "",
    "## Body",
    "- [ ] #1 Check it",
    "",
  ].join("\r\n");

  const { data, body } = parseFrontmatter(raw);
  assert.equal(data.id, "20261115T042000Z-test");
  assert.equal(data.title, 'Fix "quoted" #hash');
  assert.equal(data.status, "pending");
  assert.deepEqual(data.tags, ["Windows", "gpu"]);
  assert.deepEqual(data.depends_on, ["dep-1", "dep-2"]);
  assert.equal(data.revision, 3);
  assert.match(body, /## Body/);
  assert.ok(!body.includes("\r"));

  const serialized = serializeFrontmatter({ id: "x", tags: ["a", "b"], revision: 2 });
  assert.match(serialized, /id: "x"/);
  assert.match(serialized, /tags: \["a", "b"\]/);
  assert.match(serialized, /revision: 2/);
});

test("compareEventFilenames sorts same-second -2 and -10 suffixes chronologically", () => {
  const files = [
    "20261115T042310Z-entity-a-amend-10.md",
    "20261115T042310Z-entity-a-amend-2.md",
    "20261115T042310Z-entity-a-amend.md",
    "20261115T042309Z-entity-b-claimed.md",
  ];
  const sorted = [...files].sort(compareEventFilenames);
  assert.deepEqual(sorted, [
    "20261115T042309Z-entity-b-claimed.md",
    "20261115T042310Z-entity-a-amend.md",
    "20261115T042310Z-entity-a-amend-2.md",
    "20261115T042310Z-entity-a-amend-10.md",
  ]);
});

test("create handles same-second ID collisions and populates task.md + created event", () => {
  const bucket = makeTempBucket();
  try {
    const first = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "entity-a",
      "--title",
      "Rate Limiter",
      "--priority",
      "high",
      "--tag",
      "Linux",
      "--tag",
      "GPU",
      "--workspace",
      "/tmp/repo",
      "--ac",
      "Limit 60/min",
    ]);
    const second = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "entity-a",
      "--title",
      "Rate Limiter",
    ]);

    assert.notEqual(first.task_id, second.task_id);
    assert.ok(fs.existsSync(path.join(bucket, "pending", first.task_id, "task.md")));
    assert.ok(
      fs.existsSync(
        path.join(bucket, "pending", first.task_id, "events", first.created_event)
      )
    );
    assert.deepEqual(first.task.tags, ["linux", "gpu"]);
    assert.equal(first.task.priority, "high");
    assert.equal(first.task.status, "pending");
    assert.equal(slugify("Hello, World!"), "hello-world");
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("capability tag routing, --include-untagged, and direct assignee bypass", () => {
  const bucket = makeTempBucket();
  try {
    const tWin = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--title",
      "Windows task",
      "--tag",
      "windows",
    ]);
    const tWinCert = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--title",
      "Windows signed task",
      "--tags",
      "windows,signing-cert",
    ]);
    const tUntagged = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--title",
      "Untagged task",
    ]);
    const tPinned = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--title",
      "Pinned mac task for win-worker",
      "--tag",
      "macos",
      "--assignee",
      "win-worker",
    ]);

    // Worker with --tag windows matches pinned task (bypass) and windows task, ignores win+cert, macos, and untagged
    const c1 = runWbJson([
      "claim",
      "--bucket",
      bucket,
      "--entity",
      "win-worker",
      "--tag",
      "windows",
    ]);
    // Both tWin and tPinned are medium; whichever was created earlier (tWin) or let's check both are eligible
    assert.ok([tWin.task_id, tPinned.task_id].includes(c1.task_id));

    // Complete c1 to free WIP
    runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "win-worker",
      "--task",
      c1.task_id,
      "--type",
      "review",
      "--status",
      "review",
    ]);
    runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      c1.task_id,
      "--type",
      "complete",
    ]);

    const c2 = runWbJson([
      "claim",
      "--bucket",
      bucket,
      "--entity",
      "win-worker",
      "--tag",
      "windows",
    ]);
    assert.ok([tWin.task_id, tPinned.task_id].includes(c2.task_id));
    assert.notEqual(c2.task_id, c1.task_id);

    runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "win-worker",
      "--task",
      c2.task_id,
      "--type",
      "review",
      "--status",
      "review",
    ]);
    runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      c2.task_id,
      "--type",
      "complete",
    ]);

    // Now only tWinCert and tUntagged remain; --tag windows without --include-untagged finds nothing (exit 2)
    const noMatch = runWb([
      "claim",
      "--bucket",
      bucket,
      "--entity",
      "win-worker",
      "--tag",
      "windows",
    ]);
    assert.equal(noMatch.status, 2);

    // With --include-untagged, it claims tUntagged (still ignoring tWinCert)
    const c3 = runWbJson([
      "claim",
      "--bucket",
      bucket,
      "--entity",
      "win-worker",
      "--tag",
      "windows",
      "--include-untagged",
    ]);
    assert.equal(c3.task_id, tUntagged.task_id);

    // Worker with both tags can claim tWinCert
    const c4 = runWbJson([
      "claim",
      "--bucket",
      bucket,
      "--entity",
      "win-cert-worker",
      "--tag",
      "windows",
      "--tag",
      "signing-cert",
    ]);
    assert.equal(c4.task_id, tWinCert.task_id);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("depends_on blocks until complete, stays blocked if cancelled, and priority sorting works", () => {
  const bucket = makeTempBucket();
  try {
    const dep = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--title",
      "Upstream dep",
      "--priority",
      "low",
    ]);
    const downstream = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--title",
      "Downstream critical",
      "--priority",
      "critical",
      "--depends-on",
      dep.task_id,
    ]);
    const cancelledUpstream = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--title",
      "Will be cancelled",
      "--priority",
      "low",
    ]);
    const blockedByCancel = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--title",
      "Depends on cancelled",
      "--priority",
      "high",
      "--depends-on",
      cancelledUpstream.task_id,
    ]);

    // Cancel cancelledUpstream
    runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      cancelledUpstream.task_id,
      "--type",
      "cancelled",
    ]);

    // Next claimable must be `dep` (because downstream & blockedByCancel have unmet deps)
    const c1 = runWbJson(["claim", "--bucket", bucket, "--entity", "exec-1"]);
    assert.equal(c1.task_id, dep.task_id);

    // WIP limit prevents exec-1 from claiming anything else while in-progress
    const wipErr = runWb(["claim", "--bucket", bucket, "--entity", "exec-1"]);
    assert.equal(wipErr.status, 2);

    // Complete dep
    runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "exec-1",
      "--task",
      dep.task_id,
      "--type",
      "review",
      "--status",
      "review",
    ]);
    runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      dep.task_id,
      "--type",
      "complete",
    ]);

    // Now downstream is claimable, while blockedByCancel remains blocked
    const c2 = runWbJson(["claim", "--bucket", bucket, "--entity", "exec-1"]);
    assert.equal(c2.task_id, downstream.task_id);

    const noneLeft = runWb(["claim", "--bucket", bucket, "--entity", "exec-2"]);
    assert.equal(noneLeft.status, 2);

    // Removing cancelled dep makes blockedByCancel claimable
    runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      blockedByCancel.task_id,
      "--type",
      "amend",
      "--remove-depends-on",
      cancelledUpstream.task_id,
    ]);
    const c3 = runWbJson(["claim", "--bucket", bucket, "--entity", "exec-2"]);
    assert.equal(c3.task_id, blockedByCancel.task_id);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("full lifecycle: amend mid-flight, question/answer preserving assignee, feedback, reopen, reset, render", () => {
  const bucket = makeTempBucket();
  try {
    const created = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "owner-a",
      "--title",
      "Lifecycle test",
      "--assignee",
      "worker-b",
    ]);
    const id = created.task_id;

    // Claim
    const claimed = runWbJson(["claim", "--bucket", bucket, "--entity", "worker-b"]);
    assert.equal(claimed.task_id, id);
    assert.equal(claimed.task.status, "in-progress");
    assert.equal(claimed.task.claimed_by, "worker-b");

    // Owner posts mid-flight amend without mutating task.md
    const amend1 = runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "owner-a",
      "--task",
      id,
      "--type",
      "amend",
      "-m",
      "First amendment",
    ]);
    assert.equal(amend1.task_updated, false);

    // Owner attempting to mutate status while in-progress fails single-writer check
    const illegal = runWb([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "owner-a",
      "--task",
      id,
      "--type",
      "amend",
      "--status",
      "blocked",
    ]);
    assert.notEqual(illegal.status, 0);

    // Worker posts second same-second log and blocks with question
    runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "worker-b",
      "--task",
      id,
      "--type",
      "question",
      "-m",
      "Which Redis key prefix?",
      "--status",
      "blocked",
    ]);

    // Owner answers, bumps revision, sets pending (stays in active/ with assignee=worker-b)
    const answered = runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "owner-a",
      "--task",
      id,
      "--type",
      "answer",
      "-m",
      "Use rl:",
      "--status",
      "pending",
      "--bump-revision",
    ]);
    assert.equal(answered.stage, "active");
    assert.equal(answered.task.status, "pending");
    assert.equal(answered.task.revision, 2);
    assert.equal(answered.task.assignee, "worker-b");

    // Worker-b re-claims from active/
    const reclaimed = runWbJson(["claim", "--bucket", bucket, "--entity", "worker-b"]);
    assert.equal(reclaimed.task_id, id);
    assert.equal(reclaimed.task.status, "in-progress");

    // Stale reset moves back to pending/
    const reset = runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "owner-a",
      "--task",
      id,
      "--type",
      "reset",
      "-m",
      "Timed out",
    ]);
    assert.equal(reset.stage, "pending");
    assert.equal(reset.task.status, "pending");
    assert.equal(reset.task.claimed_by, "");
    assert.equal(reset.task.assignee, "");

    // Another worker can now claim and complete
    runWbJson(["claim", "--bucket", bucket, "--entity", "worker-c"]);
    runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "worker-c",
      "--task",
      id,
      "--type",
      "review",
      "--status",
      "review",
      "-m",
      "All tests passed",
    ]);
    const done = runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "owner-a",
      "--task",
      id,
      "--type",
      "complete",
      "-m",
      "Approved",
    ]);
    assert.equal(done.stage, "archive");
    assert.equal(done.task.status, "complete");
    assert.equal(done.task.claimed_by, "");

    // Render returns task + sorted events
    const rendered = runWbJson(["render", "--bucket", bucket, "--task", id]);
    assert.equal(rendered.stage, "archive");
    assert.ok(rendered.events.length >= 6);
    assert.equal(rendered.events[0].type, "created");
    assert.equal(rendered.events[rendered.events.length - 1].type, "complete");
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("concurrent claim race allows only one winner", async () => {
  const bucket = makeTempBucket();
  try {
    const created = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--title",
      "Race task",
    ]);

    const racers = await Promise.all([
      runWbAsync(["claim", "--bucket", bucket, "--entity", "w-1", "--json"]),
      runWbAsync(["claim", "--bucket", bucket, "--entity", "w-2", "--json"]),
      runWbAsync(["claim", "--bucket", bucket, "--entity", "w-3", "--json"]),
    ]);

    const winners = racers.filter((r) => r.status === 0);
    const losers = racers.filter((r) => r.status === 2);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 2);

    const winData = JSON.parse(winners[0].stdout);
    assert.equal(winData.task_id, created.task_id);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("watch blocks and wakes on matching task creation and on task event arrival", async () => {
  const bucket = makeTempBucket();
  try {
    // Ensure bucket dirs exist by creating an unrelated linux task first
    runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--title",
      "Linux only",
      "--tag",
      "linux",
    ]);

    // Start watch for windows tasks
    const watchReadyPromise = runWbAsync([
      "watch",
      "--bucket",
      bucket,
      "--entity",
      "win-1",
      "--tag",
      "windows",
      "--poll-ms",
      "100",
      "--timeout",
      "5",
      "--json",
    ]);

    // Give watcher a moment to attach, then create matching windows task
    await new Promise((r) => setTimeout(r, 150));
    const winTask = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--title",
      "Windows build",
      "--tag",
      "windows",
    ]);

    const watchReadyRes = await watchReadyPromise;
    assert.equal(watchReadyRes.status, 0, watchReadyRes.stderr);
    const readyPayload = JSON.parse(watchReadyRes.stdout);
    assert.equal(readyPayload.mode, "ready");
    assert.equal(readyPayload.tasks.length, 1);
    assert.equal(readyPayload.tasks[0].id, winTask.task_id);

    // Claim it and watch for new events on this specific task
    const claimed = runWbJson([
      "claim",
      "--bucket",
      bucket,
      "--entity",
      "win-1",
      "--task",
      winTask.task_id,
    ]);

    const watchTaskPromise = runWbAsync([
      "watch",
      "--bucket",
      bucket,
      "--task",
      winTask.task_id,
      "--after-event",
      claimed.last_event_seen,
      "--since-status",
      "in-progress",
      "--poll-ms",
      "100",
      "--timeout",
      "5",
      "--json",
    ]);

    await new Promise((r) => setTimeout(r, 150));
    const amend = runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      winTask.task_id,
      "--type",
      "amend",
      "-m",
      "Also sign binary",
    ]);

    const watchTaskRes = await watchTaskPromise;
    assert.equal(watchTaskRes.status, 0, watchTaskRes.stderr);
    const taskPayload = JSON.parse(watchTaskRes.stdout);
    assert.equal(taskPayload.mode, "task");
    assert.equal(taskPayload.task_id, winTask.task_id);
    assert.deepEqual(taskPayload.new_events, [amend.event]);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("subtask decomposition, feedback loop, dotfile/incomplete-folder resilience, and pre-watch --after-event", () => {
  const bucket = makeTempBucket();
  try {
    // Create noisy dotfiles and an incomplete directory missing task.md
    fs.mkdirSync(path.join(bucket, "pending", ".hidden-dir"), { recursive: true });
    fs.mkdirSync(path.join(bucket, "pending", "incomplete-no-task"), { recursive: true });

    const parent = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--title",
      "Parent epic",
    ]);

    const cParent = runWbJson(["claim", "--bucket", bucket, "--entity", "exec-1"]);
    assert.equal(cParent.task_id, parent.task_id);

    // Decompose into a child task and release WIP slot on parent
    const child = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "exec-1",
      "--title",
      "Child subtask",
      "--parent",
      parent.task_id,
    ]);
    assert.equal(child.task.parent, parent.task_id);

    const parked = runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "exec-1",
      "--task",
      parent.task_id,
      "--type",
      "log",
      "-m",
      "Decomposed into child",
      "--add-depends-on",
      child.task_id,
      "--status",
      "pending",
      "--assignee",
      "exec-1",
      "--claimed-by",
      "",
    ]);
    assert.equal(parked.task.status, "pending");
    assert.equal(parked.task.claimed_by, "");
    assert.equal(parked.task.assignee, "exec-1");
    assert.deepEqual(parked.task.depends_on, [child.task_id]);

    // exec-1 can now claim child because parent WIP was freed (and parent is blocked by child)
    const cChild = runWbJson(["claim", "--bucket", bucket, "--entity", "exec-1"]);
    assert.equal(cChild.task_id, child.task_id);

    // Complete child
    runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "exec-1",
      "--task",
      child.task_id,
      "--type",
      "review",
      "--status",
      "review",
    ]);
    runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "exec-1",
      "--task",
      child.task_id,
      "--type",
      "complete",
    ]);

    // Resume parent from active/
    const resumed = runWbJson(["claim", "--bucket", bucket, "--entity", "exec-1"]);
    assert.equal(resumed.task_id, parent.task_id);

    // Submit review -> owner sends feedback -> exec-1 re-claims -> review -> complete
    runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "exec-1",
      "--task",
      parent.task_id,
      "--type",
      "review",
      "--status",
      "review",
      "-m",
      "Initial submission",
    ]);
    const fb = runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      parent.task_id,
      "--type",
      "feedback",
      "-m",
      "Please add edge-case test",
      "--status",
      "pending",
      "--bump-revision",
    ]);
    assert.equal(fb.task.revision, 2);

    //watch --after-event on an amend emitted BEFORE watch starts must exit immediately
    const preAmend = runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      parent.task_id,
      "--type",
      "amend",
      "-m",
      "Before watch started",
    ]);
    const immediateWatch = runWbJson([
      "watch",
      "--bucket",
      bucket,
      "--task",
      parent.task_id,
      "--after-event",
      fb.event,
      "--timeout",
      "2",
    ]);
    assert.deepEqual(immediateWatch.new_events, [preAmend.event]);

    // Write a dotfile inside events/ and ensure render ignores it
    fs.writeFileSync(
      path.join(bucket, "active", parent.task_id, "events", ".tmp-event.tmp"),
      "junk"
    );
    const mdRender = runWb(["render", "--bucket", bucket, "--task", parent.task_id]);
    assert.equal(mdRender.status, 0);
    assert.ok(!mdRender.stdout.includes(".tmp-event.tmp"));
    assert.match(mdRender.stdout, /## Event Stream/);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});
