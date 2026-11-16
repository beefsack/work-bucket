import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  compareEventFilenames,
  compareMessageFilenames,
  getRoundClaims,
  isSyncConflictFilename,
  parseFrontmatter,
  serializeFrontmatter,
  slugify,
  readBucketConfig,
  findEligibleTasks,
  writeUniqueMarkdown,
  writeUniqueEvent,
  writeUniqueMessage,
} from "../scripts/wb.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WB_PATH = path.resolve(__dirname, "../scripts/wb.mjs");

function makeTempBucket() {
  const bucket = fs.mkdtempSync(path.join(os.tmpdir(), "work-bucket-test-"));
  setBucketConfig(bucket);
  return bucket;
}

function setBucketConfig(bucket, data = {}) {
  fs.mkdirSync(bucket, { recursive: true });
  fs.writeFileSync(path.join(bucket, "bucket.md"), `${serializeFrontmatter({
    sync: "local", claim_settle_ms: 250, default_ttl_seconds: 300, msg_coalesce_ms: 250, ...data,
  })}\n`);
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

test("bucket config chooses deployment defaults and rejects zero/invalid settings before writes", () => {
  const bucket = makeTempBucket();
  try {
    fs.unlinkSync(path.join(bucket, "bucket.md"));
    assert.deepEqual(readBucketConfig(bucket), {
      sync: "shared", claim_settle_ms: 2000, default_ttl_seconds: 300, msg_coalesce_ms: 500,
    });
    for (const [sync, settle] of [["local", 250], ["shared", 2000], ["cloud", 2000]]) {
      fs.writeFileSync(path.join(bucket, "bucket.md"), `${serializeFrontmatter({ sync })}\n`);
      assert.equal(readBucketConfig(bucket).claim_settle_ms, settle);
    }
    for (const data of [
      { sync: "invalid" }, { claim_settle_ms: 0 }, { claim_settle_ms: -1 },
      { claim_settle_ms: "1ms" }, { default_ttl_seconds: 0 }, { msg_coalesce_ms: -1 },
    ]) {
      setBucketConfig(bucket, data);
      const result = runWb(["create", "--bucket", bucket, "--entity", "owner", "--title", "Invalid config"]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /bucket.md:/);
      assert.equal(fs.existsSync(path.join(bucket, "tasks")), false);
    }
    setBucketConfig(bucket, { default_ttl_seconds: 42, msg_coalesce_ms: 0 });
    const entity = runWbJson(["entity", "register", "--bucket", bucket, "--entity", "reader"]);
    assert.equal(entity.ttl_seconds, 42);
    const watched = runWb(["watch", "--bucket", bucket, "--entity", "watcher", "--timeout", "0.1"]);
    assert.equal(watched.status, 124);
    const watcher = parseFrontmatter(fs.readFileSync(path.join(bucket, "entities", "watcher.md"), "utf8")).data;
    assert.equal(watcher.ttl_seconds, 42);
    for (const args of [
      ["claim", "--entity", "executor", "--claim-settle-ms", "0"],
      ["watch", "--entity", "reader", "--msg-coalesce-ms", "0"],
      ["watch", "--entity", "reader", "--ttl", "10"],
    ]) {
      assert.equal(runWb([...args, "--bucket", bucket]).status, 1);
    }
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("millisecond event/message names coexist with legacy names in chronological order", () => {
  const bucket = makeTempBucket();
  try {
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Names"]);
    const date = new Date("2026-11-16T00:00:00.123Z");
    const event = writeUniqueEvent(path.join(created.path, "events"), "owner", "log", "new", date);
    const message = writeUniqueMessage(path.join(bucket, "messages"), "owner", ["*"], [], "notice", "new", date);
    assert.equal(event.filename, "20261116T000000123Z-owner-log.md");
    assert.equal(message.filename, "20261116T000000123Z-owner-notice.md");
    const events = [
      "20261116T000001Z-old-log.md", event.filename,
      "20261116T000000Z-old-log.md", "20261116T000000001Z-new-log.md",
    ];
    assert.deepEqual(events.sort(compareEventFilenames), [
      "20261116T000000Z-old-log.md", "20261116T000000001Z-new-log.md",
      event.filename, "20261116T000001Z-old-log.md",
    ]);
    assert.ok(compareMessageFilenames("20261116T000000Z-old-notice.md", message.filename) < 0);
    fs.writeFileSync(path.join(created.path, "events", "20261116T000000Z-old-log.md"),
      '---\ntype: log\nentity_id: old\n---\nlegacy\n');
    const rendered = runWbJson(["render", "--bucket", bucket, "--task", created.task_id,
      "--after-event", "20261116T000000Z-old-log.md"]);
    assert.equal(rendered.events[0].filename, event.filename);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("immutable publication never clobbers concurrent same-ID same-millisecond writes", async () => {
  const bucket = makeTempBucket();
  try {
    const dir = path.join(bucket, "events");
    const moduleUrl = new URL("../scripts/wb.mjs", import.meta.url).href;
    const results = await Promise.all(Array.from({ length: 16 }, (_, index) =>
      new Promise((resolve, reject) => {
        const code = `import {writeUniqueEvent} from ${JSON.stringify(moduleUrl)};
          writeUniqueEvent(${JSON.stringify(dir)}, "same", "log", ${JSON.stringify(`payload-${index}`)}, new Date("2026-11-16T00:00:00.123Z"));`;
        const child = spawn(process.execPath, ["--input-type=module", "--eval", code], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (data) => { stderr += data; });
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, stderr }));
      })));
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 16);
    assert.equal(new Set(files.map((name) =>
      parseFrontmatter(fs.readFileSync(path.join(dir, name), "utf8")).body.trim())).size, 16);
    assert.equal(files.some((name) => name.startsWith(".")), false);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("exclusive-create fallback preserves existing immutable files and cleans temporary payloads", (t) => {
  const bucket = makeTempBucket();
  try {
    t.mock.method(fs, "linkSync", () => { throw Object.assign(new Error("Unsupported"), { code: "ENOTSUP" }); });
    const first = writeUniqueMarkdown(bucket, "same", "first");
    const second = writeUniqueMarkdown(bucket, "same", "second");
    assert.equal(first.filename, "same.md");
    assert.equal(second.filename, "same-2.md");
    assert.equal(fs.readFileSync(first.path, "utf8"), "first");
    assert.equal(fs.readFileSync(second.path, "utf8"), "second");
    assert.equal(fs.readdirSync(bucket).some((name) => name.startsWith(".")), false);
  } finally {
    t.mock.restoreAll();
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("a state mutation during claim settle preserves increasing snapshot sequences", async () => {
  const bucket = makeTempBucket();
  let claiming;
  try {
    setBucketConfig(bucket, { claim_settle_ms: 1000 });
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Settle mutation"]);
    const args = ["--bucket", bucket, "--task", created.task_id];
    const eventsDir = path.join(created.path, "events");
    claiming = runWbAsync(["claim", ...args, "--entity", "executor", "--json"]);
    const deadline = Date.now() + 2000;
    while (!fs.readdirSync(eventsDir).some((file) => file.endsWith("-claimed.md")) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(fs.readdirSync(eventsDir).some((file) => file.endsWith("-claimed.md")));
    const mutated = runWbJson(["post", ...args, "--entity", "owner", "--type", "log", "--bump-revision"]);
    const claimed = await claiming;
    assert.equal(claimed.status, 0, claimed.stderr);
    assert.equal(mutated.task.state_seq, 2);
    assert.equal(JSON.parse(claimed.stdout).task.state_seq, 3);
    const sequences = fs.readdirSync(eventsDir).map((file) =>
      parseFrontmatter(fs.readFileSync(path.join(eventsDir, file), "utf8")).data)
      .filter((data) => data.snapshot_version === 1).map((data) => data.state_seq).sort();
    assert.deepEqual(sequences, [1, 2, 3]);
    assert.equal(runWbJson(["fsck", "--bucket", bucket]).unresolved, 0);
  } finally {
    if (claiming) await claiming;
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("all materialized state changes carry complete snapshots and fsck repairs frontmatter only", () => {
  const bucket = makeTempBucket();
  try {
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Replay"]);
    const args = ["--bucket", bucket, "--task", created.task_id];
    const claimed = runWbJson(["claim", ...args, "--entity", "executor"]);
    runWbJson(["post", ...args, "--entity", "owner", "--type", "amend", "-m", "Correction"]);
    runWbJson(["post", ...args, "--entity", "executor", "--type", "log", "--accept-amends"]);
    runWbJson(["post", ...args, "--entity", "executor", "--type", "review", "--status", "review"]);
    const feedback = runWbJson(["post", ...args, "--entity", "owner", "--type", "feedback", "--status", "pending"]);
    const original = fs.readFileSync(created.task_path, "utf8");
    const eventsDir = path.join(created.path, "events");
    const snapshots = fs.readdirSync(eventsDir).map((file) =>
      parseFrontmatter(fs.readFileSync(path.join(eventsDir, file), "utf8")).data)
      .filter((data) => data.snapshot_version === 1);
    assert.equal(snapshots.length, 5);
    for (const state of snapshots) {
      for (const key of ["status", "assignee", "affinity", "claimed_by", "revision", "claim_round",
        "outcome", "depends_on", "last_amend_seen", "instructions_seen"]) {
        assert.ok(Object.hasOwn(state, key), `Missing ${key}`);
      }
    }
    assert.ok(snapshots.some((data) => data.type === "claim-committed" && data.claim_event === claimed.claimed_event));
    assert.equal(runWbJson(["fsck", "--bucket", bucket]).unresolved, 0);
    fs.writeFileSync(created.task_path, original.replace('assignee: "executor"', 'assignee: "wrong"'));
    const stat = fs.statSync(created.task_path);
    const drift = runWb(["fsck", "--bucket", bucket, "--json"]);
    assert.equal(drift.status, 1);
    assert.equal(JSON.parse(drift.stdout).issues[0].kind, "drift");
    assert.equal(fs.statSync(created.task_path).mtimeMs, stat.mtimeMs);
    const repair = runWbJson(["fsck", "--bucket", bucket, "--repair"]);
    assert.equal(repair.repaired, 1);
    assert.equal(fs.readFileSync(created.task_path, "utf8"), original);
    assert.equal(runWbJson(["fsck", "--bucket", bucket, "--repair"]).repaired, 0);
    assert.equal(feedback.task.state_seq, 5);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("fsck uses state sequence rather than filenames or mtimes and refuses ambiguous repair", () => {
  const bucket = makeTempBucket();
  try {
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Sequence"]);
    const args = ["--bucket", bucket, "--task", created.task_id];
    const updated = runWbJson(["post", ...args, "--entity", "owner", "--type", "log", "--bump-revision"]);
    const eventsDir = path.join(created.path, "events");
    const newestPath = path.join(eventsDir, updated.event);
    fs.renameSync(newestPath, path.join(eventsDir, "20000101T000000000Z-owner-log.md"));
    assert.equal(runWbJson(["fsck", "--bucket", bucket]).unresolved, 0);
    const conflicting = fs.readFileSync(path.join(eventsDir, "20000101T000000000Z-owner-log.md"), "utf8")
      .replace("revision: 2", "revision: 99");
    fs.writeFileSync(path.join(eventsDir, "20000101T000000001Z-owner-log.md"), conflicting);
    const original = fs.readFileSync(created.task_path, "utf8");
    const broken = original.replace("revision: 2", "revision: 8");
    fs.writeFileSync(created.task_path, broken);
    const result = runWb(["fsck", "--bucket", bucket, "--repair", "--json"]);
    assert.equal(result.status, 1);
    assert.ok(JSON.parse(result.stdout).issues.some((issue) => issue.kind === "snapshot_conflict"));
    assert.equal(fs.readFileSync(created.task_path, "utf8"), broken);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("fsck refuses invalid snapshot repair and rejects losing-election state", () => {
  const bucket = makeTempBucket();
  try {
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Election replay"]);
    const args = ["--bucket", bucket, "--task", created.task_id];
    runWbJson(["claim", ...args, "--entity", "zeta"]);
    const eventsDir = path.join(created.path, "events");
    const legitimate = fs.readFileSync(created.task_path, "utf8");
    const winnerIntent = "20000101T000000000Z-alpha-claimed.md";
    fs.writeFileSync(path.join(eventsDir, winnerIntent),
      `${serializeFrontmatter({ type: "claimed", entity_id: "alpha", timestamp: "2000-01-01T00:00:00.000Z", round: 1 })}\n`);
    const winnerState = {
      ...parseFrontmatter(legitimate).data, claimed_by: "alpha", updated_by: "alpha",
    };
    fs.writeFileSync(path.join(eventsDir, "20000101T000001000Z-alpha-claim-committed.md"),
      `${serializeFrontmatter({
        type: "claim-committed", entity_id: "alpha", claim_event: winnerIntent,
        snapshot_version: 1, state_keys: Object.keys(winnerState), ...winnerState,
      })}\n`);
    const repaired = runWb(["fsck", "--bucket", bucket, "--repair", "--json"]);
    assert.equal(repaired.status, 1);
    const data = JSON.parse(repaired.stdout);
    assert.equal(data.repaired, 1);
    assert.ok(data.issues.some((issue) => issue.kind === "losing_claim_snapshot"));
    assert.equal(parseFrontmatter(fs.readFileSync(created.task_path, "utf8")).data.claimed_by, "alpha");
    fs.writeFileSync(path.join(eventsDir, "20000101T000002000Z-owner-log.md"),
      `${serializeFrontmatter({
        type: "log", snapshot_version: 1, state_keys: ["id"], id: created.task_id,
        status: "pending", state_seq: 3,
      })}\n`);
    fs.writeFileSync(created.task_path, legitimate);
    const invalid = runWb(["fsck", "--bucket", bucket, "--repair", "--json"]);
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stdout).repaired, 0);
    assert.ok(JSON.parse(invalid.stdout).issues.some((issue) => issue.kind === "invalid_snapshot"));
    assert.equal(fs.readFileSync(created.task_path, "utf8"), legitimate);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("fsck tolerates legacy revision mismatches and never repairs terminal records", () => {
  const bucket = makeTempBucket();
  try {
    const legacyDir = path.join(bucket, "tasks", "legacy");
    fs.mkdirSync(path.join(legacyDir, "events"), { recursive: true });
    const legacyPath = path.join(legacyDir, "task.md");
    const legacy = '---\nid: legacy\nstatus: complete\nrevision: 1\nclaim_round: 2\n---\nHistorical brief\n';
    fs.writeFileSync(legacyPath, legacy);
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Terminal"]);
    runWbJson(["post", "--bucket", bucket, "--entity", "owner", "--task", created.task_id, "--type", "complete"]);
    const terminal = fs.readFileSync(created.task_path, "utf8").replace("revision: 1", "revision: 99");
    fs.writeFileSync(created.task_path, terminal);
    for (const flags of [[], ["--repair"]]) {
      const result = runWb(["fsck", "--bucket", bucket, ...flags, "--json"]);
      assert.equal(result.status, 1);
      const data = JSON.parse(result.stdout);
      assert.equal(data.repaired, 0);
      assert.ok(data.issues.some((issue) => issue.kind === "legacy" && issue.message === "legacy: revision not bumped on rework"));
      assert.ok(data.issues.some((issue) => issue.kind === "drift" && issue.terminal));
      assert.equal(fs.readFileSync(legacyPath, "utf8"), legacy);
      assert.equal(fs.readFileSync(created.task_path, "utf8"), terminal);
    }
    fs.writeFileSync(created.task_path, terminal.replace('status: "complete"', 'status: "pending"'));
    assert.equal(runWb(["fsck", "--bucket", bucket, "--repair"]).status, 1);
    assert.match(fs.readFileSync(created.task_path, "utf8"), /status: "pending"/);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("fsck warns about local sync conflicts without editing or treating them as events", () => {
  const bucket = makeTempBucket();
  try {
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Conflict"]);
    fs.writeFileSync(path.join(created.path, "events", "note (conflicted copy).md"), "conflict");
    const result = runWb(["fsck", "--bucket", bucket]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /warning: local bucket contains sync conflicts/);
    assert.equal(fs.readFileSync(path.join(created.path, "events", "note (conflicted copy).md"), "utf8"), "conflict");
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("terminal cursor pruning preserves active deliveries on every entity write", () => {
  const bucket = makeTempBucket();
  try {
    const active = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Active"]);
    const done = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Done"]);
    runWbJson(["post", "--bucket", bucket, "--entity", "owner", "--task", done.task_id, "--type", "complete"]);
    const entity = runWbJson(["entity", "register", "--bucket", bucket, "--entity", "owner"]);
    const data = parseFrontmatter(fs.readFileSync(entity.path, "utf8")).data;
    fs.mkdirSync(path.join(bucket, "tasks", "partly-synced"));
    fs.writeFileSync(path.join(bucket, "tasks", "partly-synced", "task.md"), "---\n");
    data.owner_task_seen = [`${active.task_id}/live.md`, `${done.task_id}/old.md`, "not-synced-yet/old.md", "partly-synced/old.md"];
    data.stale_task_seen = [`${active.task_id}/1/child/old`, `${done.task_id}/1/child/old`];
    fs.writeFileSync(entity.path, `${serializeFrontmatter(data)}\n`);
    const saved = runWbJson(["entity", "register", "--bucket", bucket, "--entity", "owner"]);
    assert.deepEqual(saved.owner_task_seen, [`${active.task_id}/live.md`, "not-synced-yet/old.md", "partly-synced/old.md"]);
    assert.deepEqual(saved.stale_task_seen, [`${active.task_id}/1/child/old`]);
    runWbJson(["entity", "end", "--bucket", bucket, "--entity", "owner"]);
    const ended = parseFrontmatter(fs.readFileSync(entity.path, "utf8")).data;
    assert.deepEqual(ended.owner_task_seen, saved.owner_task_seen);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("entities end explicitly, restrict dispatcher writes, and list history only with --all", () => {
  const bucket = makeTempBucket();
  try {
    const args = ["--bucket", bucket];
    const child = runWbJson(["entity", "register", ...args, "--entity", "child"]);
    const data = parseFrontmatter(fs.readFileSync(child.path, "utf8")).data;
    data.dispatcher = "pool";
    fs.writeFileSync(child.path, `${serializeFrontmatter(data)}\n`);
    const before = fs.readFileSync(child.path, "utf8");
    assert.equal(runWb(["entity", "end", ...args, "--entity", "stranger", "--target", "child"]).status, 3);
    assert.equal(fs.readFileSync(child.path, "utf8"), before);
    const ended = runWbJson(["entity", "end", ...args, "--entity", "pool", "--target", "child"]);
    assert.ok(ended.ended_at);
    assert.equal(runWbJson(["entity", "list", ...args]).count, 0);
    const history = runWbJson(["entity", "list", ...args, "--all"]).entities[0];
    assert.equal(history.state, "ended");
    assert.equal(history.online, false);
    runWbJson(["entity", "register", ...args, "--entity", "child"]);
    assert.equal(runWbJson(["entity", "list", ...args]).count, 1);
    const stale = parseFrontmatter(fs.readFileSync(child.path, "utf8")).data;
    stale.updated_at = new Date(Date.now() - 1000 * stale.ttl_seconds * 4).toISOString();
    fs.writeFileSync(child.path, `${serializeFrontmatter(stale)}\n`);
    assert.equal(runWbJson(["entity", "list", ...args]).count, 0);
    assert.equal(runWbJson(["entity", "list", ...args, "--all"]).count, 1);
    assert.equal(runWbJson(["entity", "list", ...args, "--all", "--online"]).count, 0);
    assert.equal(runWb(["entity", "end", ...args, "--entity", "missing"]).status, 1);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("eligibility never scans terminal event streams even with a thousand completed tasks", (t) => {
  const bucket = makeTempBucket();
  try {
    const pending = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Pending"]);
    for (let index = 0; index < 1000; index += 1) {
      const dir = path.join(bucket, "tasks", `terminal-${index}`);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "task.md"), `${serializeFrontmatter({
        id: `terminal-${index}`, status: "complete", claimed_by: "", assignee: "",
      })}\n`);
    }
    const readdir = fs.readdirSync;
    let terminalEventReads = 0;
    t.mock.method(fs, "readdirSync", (dir, ...args) => {
      if (String(dir).includes("terminal-") && path.basename(String(dir)) === "events") terminalEventReads += 1;
      return readdir(dir, ...args);
    });
    assert.deepEqual(findEligibleTasks(bucket, "executor", new Set(), false).map((item) => item.task.id), [pending.task_id]);
    assert.equal(terminalEventReads, 0);
    const entity = runWbJson(["entity", "register", "--bucket", bucket, "--entity", "owner"]);
    const data = parseFrontmatter(fs.readFileSync(entity.path, "utf8")).data;
    data.owner_task_seen = Array.from({ length: 1000 }, (_, index) => `terminal-${index}/old.md`);
    data.stale_task_seen = Array.from({ length: 1000 }, (_, index) => `terminal-${index}/1/child/old`);
    data.owner_task_seen.push(`${pending.task_id}/live.md`);
    fs.writeFileSync(entity.path, `${serializeFrontmatter(data)}\n`);
    const saved = runWbJson(["entity", "register", "--bucket", bucket, "--entity", "owner"]);
    assert.deepEqual(saved.owner_task_seen, [`${pending.task_id}/live.md`]);
    assert.deepEqual(saved.stale_task_seen, []);
  } finally {
    t.mock.restoreAll();
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("rework auto-bumps revision once, warns on actionable amends, and reports transitions", () => {
  const bucket = makeTempBucket();
  try {
    const { task_id: id } = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Revisions"]);
    for (const [index, status] of ["review", "blocked"].entries()) {
      runWbJson(["claim", "--bucket", bucket, "--entity", "worker", "--task", id]);
      runWbJson(["post", "--bucket", bucket, "--entity", "worker", "--task", id, "--type", status === "review" ? "review" : "question", "--status", status]);
      const amend = runWb(["post", "--bucket", bucket, "--entity", "owner", "--task", id, "--type", "amend", "-m", "Correction", "--json"]);
      assert.equal(amend.status, 0, amend.stderr);
      assert.match(amend.stderr, /amend does not reopen/);
      assert.equal(JSON.parse(amend.stdout).task.status, status);
      const res = runWbJson(["post", "--bucket", bucket, "--entity", "owner", "--task", id, "--type", status === "review" ? "feedback" : "answer", "--status", "pending", ...(index ? ["--bump-revision"] : [])]);
      assert.equal(res.task.revision, index + 2);
      assert.equal(res.task.claim_round, index + 2);
      assert.equal(res.previous_revision, index + 1);
      assert.equal(res.previous_claim_round, index + 1);
      assert.equal(res.task.assignee, "worker");
    }
    const text = runWb(["post", "--bucket", bucket, "--entity", "owner", "--task", id, "--type", "log", "--bump-revision"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /revision=3->4 claim_round=3->3/);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("claim JSON includes bucket/tag instructions and multiline stdin/file bodies stay literal", () => {
  const bucket = makeTempBucket();
  try {
    const body = "## Brief\n`literal $(no-substitution)`\n- [ ] #1 Test\n";
    const created = runWb(["create", "--bucket", bucket, "--entity", "owner", "--title", "Instructions", "--tag", "linux", "--stdin", "--json"], { input: body });
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).task_id;
    fs.writeFileSync(path.join(bucket, "INSTRUCTIONS.md"), "No git writes.\r\n");
    runWbJson(["tag", "set", "--bucket", bucket, "--entity", "owner", "--tag", "linux", "-m", "Use the toolchain."]);
    const claim = runWbJson(["claim", "--bucket", bucket, "--entity", "worker", "--task", id]);
    assert.deepEqual(claim.instructions, [
      { file: "INSTRUCTIONS.md", body: "No git writes." },
      { file: "tags/linux.md", body: "Use the toolchain." },
    ]);
    const reviewPath = path.join(bucket, "review-body.md");
    fs.writeFileSync(reviewPath, body);
    runWbJson(["post", "--bucket", bucket, "--entity", "worker", "--task", id, "--type", "review", "--status", "review", "--body-file", reviewPath]);
    const rendered = runWbJson(["render", "--bucket", bucket, "--task", id, "--after-event", claim.last_event_seen]);
    assert.equal(rendered.body, body.trim());
    assert.equal(rendered.events.length, 1);
    assert.equal(rendered.events[0].body, body.trim());
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("pool watches skip current-round claim events, preserve claim recovery, and allow repeatable exclusions", () => {
  const bucket = makeTempBucket();
  try {
    const first = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Election pending"]);
    const second = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Available"]);
    const third = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Also available"]);
    const eventsDir = path.join(first.path, "events");
    fs.writeFileSync(path.join(eventsDir, "20200101T000000Z-worker-claimed.md"),
      '---\ntype: "claimed"\nentity_id: "worker"\nround: 1\n---\nElection in flight\n');
    const ready = runWbJson(["watch", "--bucket", bucket, "--entity", "worker", "--exclude-task", second.task_id, "--timeout", "1"]);
    assert.deepEqual(ready.tasks.map((t) => t.id), [third.task_id]);
    assert.equal(runWb(["watch", "--bucket", bucket, "--entity", "dispatcher", "--exclude-task", second.task_id, "--exclude-task", third.task_id, "--timeout", "0.1"]).status, 124);
    const recovered = runWbJson(["claim", "--bucket", bucket, "--entity", "worker", "--task", first.task_id]);
    assert.equal(recovered.task_id, first.task_id);
    runWbJson(["post", "--bucket", bucket, "--entity", "worker", "--task", first.task_id, "--type", "review", "--status", "review"]);
    runWbJson(["post", "--bucket", bucket, "--entity", "owner", "--task", first.task_id, "--type", "feedback", "--reopen"]);
    const nextRound = runWbJson(["watch", "--bucket", bucket, "--entity", "dispatcher", "--exclude-task", second.task_id, "--exclude-task", third.task_id, "--timeout", "1"]);
    assert.equal(nextRound.tasks[0].id, first.task_id);
    assert.equal(nextRound.tasks[0].claim_round, 2);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("owner watches deliver each task edge once, persist cursors, and can list all actionable tasks", () => {
  const bucket = makeTempBucket();
  try {
    const first = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "First review"]);
    const second = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Second review"]);
    for (const task of [first, second]) {
      runWbJson(["claim", "--bucket", bucket, "--entity", "worker", "--task", task.task_id]);
      runWbJson(["post", "--bucket", bucket, "--entity", "worker", "--task", task.task_id, "--type", "review", "--status", "review", "-m", "Evidence"]);
    }
    const watchArgs = ["watch", "--bucket", bucket, "--entity", "owner", "--owner-only"];
    const firstEdge = runWbJson([...watchArgs, "--exclude-task", second.task_id]);
    assert.deepEqual(firstEdge.owner_tasks.map((t) => t.id), [first.task_id]);
    const secondEdge = runWbJson(watchArgs);
    assert.deepEqual(secondEdge.owner_tasks.map((t) => t.id), [second.task_id]);
    const registered = runWbJson(["entity", "register", "--bucket", bucket, "--entity", "owner"]);
    assert.equal(registered.owner_task_seen.length, 2);
    assert.equal(runWb([...watchArgs, "--timeout", "0.1"]).status, 124);
    const note = runWbJson(["post", "--bucket", bucket, "--entity", "owner", "--task", first.task_id, "--type", "log", "-m", "Additional evidence"]);
    const nextEdge = runWbJson(watchArgs);
    assert.equal(nextEdge.owner_tasks.length, 1);
    assert.equal(nextEdge.owner_tasks[0].latest_event.filename, note.event);
    assert.equal(runWb([...watchArgs, "--timeout", "0.1"]).status, 124);
    const all = runWbJson([...watchArgs, "--all-actionable"]);
    assert.equal(all.owner_tasks.length, 2);
    assert.equal(runWb([...watchArgs, "--timeout", "0.1"]).status, 124);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("watch summaries and task updates include bounded event evidence or full bodies on request", () => {
  const bucket = makeTempBucket();
  try {
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Preview"]);
    const claimed = runWbJson(["claim", "--bucket", bucket, "--entity", "worker", "--task", created.task_id]);
    const body = "one\ntwo\nthree\nfour\nfive\nsix";
    const review = runWbJson(["post", "--bucket", bucket, "--entity", "worker", "--task", created.task_id, "--type", "review", "--status", "review", "-m", body]);
    const args = ["watch", "--bucket", bucket, "--entity", "owner", "--owner-only", "--all-actionable"];
    const summary = runWbJson(args).owner_tasks[0];
    assert.equal(summary.revision, 1);
    assert.equal(summary.claim_round, 1);
    assert.equal(summary.claimed_by, "worker");
    assert.equal(summary.assignee, "");
    assert.equal(summary.latest_event.filename, review.event);
    assert.equal(summary.latest_event.type, "review");
    assert.equal(summary.latest_event.body, "one\ntwo\nthree\nfour\nfive");
    assert.equal(summary.latest_event.truncated, true);
    assert.equal(runWbJson([...args, "--include-events"]).owner_tasks[0].latest_event.body, body);
    const taskArgs = ["watch", "--bucket", bucket, "--task", created.task_id, "--after-event", claimed.last_event_seen];
    const update = runWbJson([...taskArgs, "--event-lines", "2"]);
    assert.deepEqual(update.new_events, [review.event]);
    assert.equal(update.latest_event.body, "one\ntwo");
    assert.equal(update.events[0].body, "one\ntwo");
    assert.equal(update.revision, 1);
    assert.equal(update.claim_round, 1);
    assert.equal(update.claimed_by, "worker");
    assert.equal(update.assignee, "");
    const full = runWbJson([...taskArgs, "--include-events"]);
    assert.equal(full.events[0].body, body);
    assert.equal(full.events[0].truncated, false);
    assert.equal(runWbJson([...taskArgs, "--event-lines", "0"]).events[0].body, "");
    const text = runWb([...taskArgs, "--event-lines", "2"]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /revision=1 claim_round=1 claimed_by=worker/);
    assert.ok(text.stdout.includes(`Event: ${review.event} type=review (truncated)\none\ntwo`));
    assert.equal(runWb([...taskArgs, "--event-lines", "-1"]).status, 1);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("render bounds history after the cursor and documents its nested JSON shape", () => {
  const bucket = makeTempBucket();
  try {
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "History"]);
    const args = ["--bucket", bucket, "--task", created.task_id];
    const first = runWbJson(["post", ...args, "--entity", "owner", "--type", "log", "-m", "First"]);
    const second = runWbJson(["post", ...args, "--entity", "owner", "--type", "log", "-m", "Second"]);
    const rendered = runWbJson(["render", ...args, "--tail-events", "2"]);
    assert.deepEqual(rendered.events.map((event) => event.filename), [first.event, second.event]);
    assert.equal(rendered.task.status, "pending");
    assert.deepEqual(runWbJson(["render", ...args, "--latest-event"]).events.map((event) => event.filename), [second.event]);
    assert.deepEqual(runWbJson(["render", ...args, "--after-event", second.event, "--latest-event"]).events, []);
    assert.deepEqual(runWbJson(["render", ...args, "--tail-events", "0"]).events, []);
    const text = runWb(["render", ...args, "--after-event", first.event, "--tail-events", "10"]);
    assert.equal(text.status, 0, text.stderr);
    assert.ok(text.stdout.includes(second.event));
    assert.ok(!text.stdout.includes(first.event));
    for (const invalid of [["--tail-events", "-1"], ["--tail-events", "1.5"], ["--latest-event", "--tail-events", "1"]]) {
      assert.equal(runWb(["render", ...args, ...invalid]).status, 1);
    }
    assert.match(runWb(["render", "--help"]).stdout, /task holds frontmatter fields/);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("list emits one line per task and combines status, OR-tag and owner filters", () => {
  const bucket = makeTempBucket();
  try {
    const first = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Listed", "--tag", "linux", "--assignee", "worker"]);
    runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Held", "--tag", "windows", "--status", "ready"]);
    runWbJson(["create", "--bucket", bucket, "--entity", "other", "--title", "Other", "--tag", "linux"]);
    const args = ["list", "--bucket", bucket];
    const all = runWbJson(args);
    assert.equal(all.count, 3);
    const selected = runWbJson([...args, "--status", "pending,ready", "--tags", "LINUX,macos", "--owner", "owner"]);
    assert.equal(selected.count, 1);
    assert.equal(selected.tasks[0].id, first.task_id);
    assert.equal(selected.tasks[0].revision, 1);
    assert.equal(selected.tasks[0].claim_round, 1);
    assert.equal(selected.tasks[0].assignee, "worker");
    assert.equal(selected.tasks[0].claimed_by, "");
    assert.equal(selected.tasks[0].latest_event.filename, first.created_event);
    const text = runWb(args);
    assert.equal(text.status, 0, text.stderr);
    assert.equal(text.stdout.trim().split("\n").length, 3);
    assert.match(text.stdout, /status=pending assignee=worker claimed_by=- revision=1 claim_round=1 latest=/);
    assert.equal(runWbJson([...args, "--status", "review"]).count, 0);
    assert.equal(runWb([...args, "--status", "nonsense"]).status, 1);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("claim surfaces pre-claim/unaccepted amends and feedback; accept-amends merges once with an atomic revision/log", () => {
  const bucket = makeTempBucket();
  try {
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Amends"]);
    const args = ["--bucket", bucket, "--task", created.task_id];
    const pre = runWbJson(["post", ...args, "--entity", "owner", "--type", "amend", "-m", "Pre-claim correction"]);
    const claim = runWbJson(["claim", ...args, "--entity", "worker"]);
    assert.deepEqual(claim.unread_events.map((event) => event.filename), [pre.event]);
    assert.equal(claim.unread_events[0].body, "Pre-claim correction");
    const mid = runWbJson(["post", ...args, "--entity", "owner", "--type", "amend", "-m", "Mid-flight correction"]);
    assert.equal(runWb(["post", ...args, "--entity", "other", "--type", "log", "--accept-amends"]).status, 1);
    assert.equal(runWb(["post", ...args, "--entity", "worker", "--type", "amend", "--accept-amends"]).status, 1);
    const accepted = runWbJson(["post", ...args, "--entity", "worker", "--type", "log", "--accept-amends", "--bump-revision", "-m", "Applied"]);
    assert.equal(accepted.task.revision, 2);
    assert.equal(accepted.task.claim_round, 1);
    assert.equal(accepted.task.status, "in-progress");
    assert.equal(accepted.task.last_amend_seen, mid.event);
    const render = runWbJson(["render", ...args]);
    assert.ok(render.body.includes(`## Amendment: ${pre.event}\n\nPre-claim correction`));
    assert.ok(render.body.includes(`## Amendment: ${mid.event}\n\nMid-flight correction`));
    assert.match(render.body, /## Acceptance Criteria/);
    assert.ok(render.events.at(-1).body.includes(pre.event));
    assert.ok(render.events.at(-1).body.includes(mid.event));
    assert.equal(runWb(["post", ...args, "--entity", "worker", "--type", "log", "--accept-amends"]).status, 1);
    assert.equal(runWbJson(["render", ...args]).events.length, render.events.length);
    runWbJson(["post", ...args, "--entity", "worker", "--type", "review", "--status", "review"]);
    const feedback = runWbJson(["post", ...args, "--entity", "owner", "--type", "feedback", "--status", "pending", "-m", "Fix the test"]);
    const rework = runWbJson(["claim", ...args, "--entity", "worker"]);
    assert.deepEqual(rework.unread_events.map((event) => event.filename), [feedback.event]);
    const later = runWbJson(["post", ...args, "--entity", "owner", "--type", "amend", "-m", "Still unaccepted"]);
    runWbJson(["post", ...args, "--entity", "worker", "--type", "review", "--status", "review"]);
    const nextFeedback = runWbJson(["post", ...args, "--entity", "owner", "--type", "feedback", "--status", "pending", "-m", "Another fix"]);
    const nextClaim = runWbJson(["claim", ...args, "--entity", "worker"]);
    assert.deepEqual(nextClaim.unread_events.map((event) => event.filename), [later.event, nextFeedback.event]);
    runWbJson(["post", ...args, "--entity", "worker", "--type", "log", "--accept-amends"]);
    const merged = runWbJson(["render", ...args]);
    assert.equal(merged.body.split("Pre-claim correction").length, 2);
    assert.equal(merged.body.split("Still unaccepted").length, 2);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("owner watches signal stale registered executors once per round/heartbeat and preserve delivery cursors", () => {
  const bucket = makeTempBucket();
  try {
    runWbJson(["entity", "register", "--bucket", bucket, "--entity", "worker", "--ttl", "10"]);
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Stalled"]);
    runWbJson(["claim", "--bucket", bucket, "--entity", "worker", "--task", created.task_id]);
    const entityPath = path.join(bucket, "entities", "worker.md");
    fs.writeFileSync(entityPath, fs.readFileSync(entityPath, "utf8").replace(/updated_at: "[^"]+"/, 'updated_at: "2000-01-01T00:00:00Z"'));
    const args = ["watch", "--bucket", bucket, "--entity", "owner", "--owner-only", "--poll-ms", "50"];
    const stale = runWbJson(args);
    assert.equal(stale.reason, "stale");
    assert.equal(stale.stale_tasks.length, 1);
    assert.equal(stale.stale_tasks[0].id, created.task_id);
    assert.equal(stale.stale_tasks[0].heartbeat.ttl_seconds, 10);
    assert.equal(stale.stale_tasks[0].heartbeat.updated_at, "2000-01-01T00:00:00Z");
    assert.equal(runWb([...args, "--timeout", "0.1"]).status, 124);
    const entity = runWbJson(["entity", "register", "--bucket", bucket, "--entity", "owner"]);
    assert.equal(entity.stale_task_seen.length, 1);
    runWbJson(["entity", "register", "--bucket", bucket, "--entity", "worker"]);
    assert.equal(runWb([...args, "--timeout", "0.1"]).status, 124);
    fs.writeFileSync(entityPath, fs.readFileSync(entityPath, "utf8").replace(/updated_at: "[^"]+"/, 'updated_at: "2000-01-01T00:00:01Z"'));
    assert.equal(runWbJson(args).reason, "stale");
    assert.equal(runWb(["watch", "--bucket", bucket, "--entity", "other", "--owner-only", "--timeout", "0.1"]).status, 124);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("owner watch notices TTL expiry while armed, without requiring task events", async () => {
  const bucket = makeTempBucket();
  try {
    runWbJson(["entity", "register", "--bucket", bucket, "--entity", "worker"]);
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Expiry"]);
    runWbJson(["claim", "--bucket", bucket, "--entity", "worker", "--task", created.task_id]);
    const entityPath = path.join(bucket, "entities", "worker.md");
    fs.writeFileSync(entityPath, fs.readFileSync(entityPath, "utf8").replace(/ttl_seconds: \d+/, "ttl_seconds: 2"));
    const result = await runWbAsync(["watch", "--bucket", bucket, "--entity", "owner", "--owner-only", "--poll-ms", "50", "--timeout", "4", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).reason, "stale");
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("terminal outcomes are optional, validated, and preserved without redefining lifecycle status", () => {
  const bucket = makeTempBucket();
  try {
    for (const [index, outcome] of ["pass", "partial", "fail", "abandoned"].entries()) {
      const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", outcome]);
      const args = ["post", "--bucket", bucket, "--entity", "owner", "--task", created.task_id];
      assert.equal(runWb([...args, "--type", "log", "--outcome", outcome]).status, 1);
      assert.equal(runWb([...args, "--type", "complete", "--outcome", "unknown"]).status, 1);
      const type = index === 3 ? "cancelled" : "complete";
      const closed = runWbJson([...args, "--type", type, "--outcome", outcome]);
      assert.equal(closed.task.status, type);
      assert.equal(closed.task.outcome, outcome);
      const rendered = runWbJson(["render", "--bucket", bucket, "--task", created.task_id]);
      assert.equal(rendered.task.outcome, outcome);
      assert.equal(runWb([...args, "--type", "log", "--outcome", outcome]).status, 1);
    }
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("plain PAUSED blocks claims and pool delivery while owners can still review; resume is idempotent", () => {
  const bucket = makeTempBucket();
  try {
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Paused"]);
    const args = ["--bucket", bucket, "--task", created.task_id];
    const pause = runWbJson(["bucket", "pause", "--bucket", bucket, "-m", "Await decision"]);
    assert.equal(pause.paused, true);
    assert.equal(fs.readFileSync(pause.path, "utf8"), "Await decision\n");
    assert.equal(runWb(["claim", ...args, "--entity", "worker"]).status, 2);
    const watch = runWbJson(["watch", "--bucket", bucket, "--entity", "worker"]);
    assert.equal(watch.reason, "paused");
    assert.equal(watch.paused, true);
    assert.deepEqual(watch.tasks, []);
    assert.equal(runWb(["watch", "--bucket", bucket, "--entity", "owner", "--owner-only", "--timeout", "0.1"]).status, 124);
    assert.equal(runWbJson(["bucket", "resume", "--bucket", bucket]).paused, false);
    runWbJson(["bucket", "resume", "--bucket", bucket]);
    const claim = runWbJson(["claim", ...args, "--entity", "worker"]);
    fs.writeFileSync(pause.path, "Human pause\n");
    runWbJson(["post", ...args, "--entity", "worker", "--type", "review", "--status", "review"]);
    const taskUpdate = runWbJson(["watch", ...args, "--after-event", claim.last_event_seen]);
    assert.equal(taskUpdate.paused, true);
    const owner = runWbJson(["watch", "--bucket", bucket, "--entity", "owner", "--owner-only"]);
    assert.equal(owner.paused, true);
    assert.equal(owner.owner_tasks[0].id, created.task_id);
    assert.equal(runWbJson(["post", ...args, "--entity", "owner", "--type", "complete", "--outcome", "pass"]).task.status, "complete");
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("a pause during claim settle leaves the task pending and wakes an armed pool watcher", async () => {
  const bucket = makeTempBucket();
  try {
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Settle pause"]);
    setBucketConfig(bucket, { claim_settle_ms: 500 });
    const claiming = runWbAsync(["claim", "--bucket", bucket, "--entity", "worker", "--task", created.task_id, "--json"]);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const watching = runWbAsync(["watch", "--bucket", bucket, "--entity", "observer", "--owner-only", "--timeout", "0.2"]);
    runWbJson(["bucket", "pause", "--bucket", bucket]);
    const claim = await claiming;
    assert.equal(claim.status, 2, claim.stderr);
    assert.match(claim.stderr, /paused during claim/);
    assert.equal(runWbJson(["render", "--bucket", bucket, "--task", created.task_id]).task.status, "pending");
    assert.equal((await watching).status, 124);
    runWbJson(["bucket", "resume", "--bucket", bucket]);
    const poolWatch = runWbAsync(["watch", "--bucket", bucket, "--entity", "observer", "--poll-ms", "50", "--timeout", "2", "--json"]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    runWbJson(["bucket", "pause", "--bucket", bucket]);
    const result = await poolWatch;
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).reason, "paused");
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("initial and pinned reclaims both honor positive bucket settle", () => {
  const bucket = makeTempBucket();
  try {
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Pinned", "--assignee", "worker"]);
    const args = ["--bucket", bucket, "--task", created.task_id];
    const start = Date.now();
    runWbJson(["claim", ...args, "--entity", "worker"]);
    assert.ok(Date.now() - start >= 250, "Initial assigned claim must still settle");
    runWbJson(["post", ...args, "--entity", "worker", "--type", "review", "--status", "review"]);
    runWbJson(["post", ...args, "--entity", "owner", "--type", "feedback", "--status", "pending"]);
    const reclaimStart = Date.now();
    const reclaimed = runWbJson(["claim", ...args, "--entity", "worker"]);
    assert.ok(Date.now() - reclaimStart >= 250, "Pinned reclaim must still settle");
    assert.equal(reclaimed.task.claim_round, 2);
    assert.equal(reclaimed.task.claimed_by, "worker");
    assert.equal(runWbJson(["render", ...args]).claim_winner, "worker");
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("optional session nonces warn only for a different live session, preserve omissions, and allow stale transfer", () => {
  const bucket = makeTempBucket();
  const options = { env: { ...process.env, WB_SESSION_NONCE: "" } };
  try {
    const args = ["entity", "register", "--bucket", bucket, "--entity", "actor"];
    const first = runWb([...args, "--session-nonce", "session-a", "--json"], options);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).session_nonce, "session-a");
    assert.equal(first.stderr, "");
    assert.equal(runWb([...args, "--session-nonce", "session-a"], options).stderr, "");
    const other = runWb([...args, "--session-nonce", "session-b", "--json"], options);
    assert.equal(other.status, 0, other.stderr);
    assert.match(other.stderr, /different live session nonce/);
    assert.equal(other.stderr.trim().split("\n").length, 1);
    assert.equal(JSON.parse(other.stdout).session_nonce, "session-b");
    const omitted = runWb([...args, "--json"], options);
    assert.equal(omitted.status, 0, omitted.stderr);
    assert.equal(omitted.stderr, "");
    assert.equal(JSON.parse(omitted.stdout).session_nonce, "session-b");
    const override = runWb([...args, "--session-nonce", "session-b", "--json"], {
      env: { ...process.env, WB_SESSION_NONCE: "ignored-env-session" },
    });
    assert.equal(override.status, 0, override.stderr);
    assert.equal(override.stderr, "");
    assert.equal(JSON.parse(override.stdout).session_nonce, "session-b");
    const entityPath = path.join(bucket, "entities", "actor.md");
    fs.writeFileSync(entityPath, fs.readFileSync(entityPath, "utf8").replace(/updated_at: "[^"]+"/, 'updated_at: "2000-01-01T00:00:00Z"'));
    const transferred = runWb([...args, "--json"], { env: { ...process.env, WB_SESSION_NONCE: "session-c" } });
    assert.equal(transferred.status, 0, transferred.stderr);
    assert.equal(transferred.stderr, "");
    assert.equal(JSON.parse(transferred.stdout).session_nonce, "session-c");
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("all entity writers accept nonce flags and inherited nonce collision checks", () => {
  const bucket = makeTempBucket();
  try {
    const base = ["--bucket", bucket, "--entity", "actor"];
    const register = () => runWbJson(["entity", "register", ...base, "--session-nonce", "original"]);
    register();
    const created = runWb(["create", ...base, "--title", "Nonce writes", "--session-nonce", "other", "--json"]);
    assert.equal(created.status, 0, created.stderr);
    assert.match(created.stderr, /different live session nonce/);
    const id = JSON.parse(created.stdout).task_id;
    const commands = [
      ["claim", ...base, "--task", id],
      ["post", ...base, "--task", id, "--type", "log", "-m", "Checkpoint"],
      ["msg", "send", ...base, "-m", "Notice"],
      ["tag", "set", ...base, "--tag", "test", "-m", "Instructions"],
      ["watch", ...base, "--owner-only", "--timeout", "0.1"],
    ];
    for (const [index, args] of commands.entries()) {
      register();
      const result = runWb([...args, ...(index % 2 ? [] : ["--session-nonce", "other"])], {
        env: { ...process.env, WB_SESSION_NONCE: "other" },
      });
      assert.equal(result.status, args[0] === "watch" ? 124 : 0, result.stderr);
      assert.match(result.stderr, /different live session nonce/);
      const entity = runWbJson(["entity", "list", "--bucket", bucket]).entities.find((item) => item.entity_id === "actor");
      assert.equal(entity.session_nonce, "other");
    }
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

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
    assert.ok(fs.existsSync(path.join(bucket, "tasks", first.task_id, "task.md")));
    assert.ok(
      fs.existsSync(
        path.join(bucket, "tasks", first.task_id, "events", first.created_event)
      )
    );
    assert.equal(first.stage, "tasks");
    assert.equal(first.task.claim_round, 1);
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
    const tWinOrLinux = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--title",
      "Windows or Linux task",
      "--tags",
      "windows,linux",
    ]);
    const tWinSigned = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--title",
      "Windows signed task",
      "--tag",
      "windows-signing",
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

    // Worker with --tag windows matches pinned task (bypass), windows task, and OR-tagged windows,linux task
    const claimedIds = [];
    for (let i = 0; i < 3; i += 1) {
      const c = runWbJson([
        "claim",
        "--bucket",
        bucket,
        "--entity",
        "win-worker",
        "--tag",
        "windows",
      ]);
      claimedIds.push(c.task_id);
      runWbJson([
        "post",
        "--bucket",
        bucket,
        "--entity",
        "win-worker",
        "--task",
        c.task_id,
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
        c.task_id,
        "--type",
        "complete",
      ]);
    }
    assert.deepEqual(
      new Set(claimedIds),
      new Set([tWin.task_id, tWinOrLinux.task_id, tPinned.task_id])
    );

    // Now only tWinSigned and tUntagged remain; --tag windows without --include-untagged finds nothing (exit 2)
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

    // With --include-untagged, it claims tUntagged (still ignoring tWinSigned)
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

    // Worker with combined windows-signing tag claims tWinSigned
    const c4 = runWbJson([
      "claim",
      "--bucket",
      bucket,
      "--entity",
      "win-cert-worker",
      "--tag",
      "windows-signing",
    ]);
    assert.equal(c4.task_id, tWinSigned.task_id);
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
    assert.equal(claimed.task.claim_round, 1);

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

    // Owner answers, bumps revision, sets pending (stays in tasks/ with assignee=worker-b and claim_round=2)
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
    assert.equal(answered.stage, "tasks");
    assert.equal(answered.task.status, "pending");
    assert.equal(answered.task.revision, 2);
    assert.equal(answered.task.claim_round, 2);
    assert.equal(answered.task.assignee, "worker-b");

    // Worker-b re-claims
    const reclaimed = runWbJson(["claim", "--bucket", bucket, "--entity", "worker-b"]);
    assert.equal(reclaimed.task_id, id);
    assert.equal(reclaimed.task.status, "in-progress");

    // Stale reset increments claim_round and clears assignee/claimed_by
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
    assert.equal(reset.stage, "tasks");
    assert.equal(reset.task.status, "pending");
    assert.equal(reset.task.claim_round, 3);
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
    assert.equal(done.stage, "tasks");
    assert.equal(done.task.status, "complete");
    assert.equal(done.task.claimed_by, "");

    // Render returns task + sorted events
    const rendered = runWbJson(["render", "--bucket", bucket, "--task", id]);
    assert.equal(rendered.stage, "tasks");
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
    assert.equal(winData.task.claimed_by, winData.task.updated_by);
    const rendered = runWbJson(["render", "--bucket", bucket, "--task", created.task_id]);
    assert.equal(rendered.claim_winner, winData.task.claimed_by);
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
    fs.mkdirSync(path.join(bucket, "tasks", ".hidden-dir"), { recursive: true });
    fs.mkdirSync(path.join(bucket, "tasks", "incomplete-no-task"), { recursive: true });

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
    assert.equal(parked.task.claim_round, 2);
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

    // Resume parent
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
    assert.equal(fb.task.claim_round, 3);

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
      path.join(bucket, "tasks", parent.task_id, "events", ".tmp-event.tmp"),
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

test("post auto-pins assignee on feedback/answer from pool-claimed task and --check-ac checks boxes", () => {
  const bucket = makeTempBucket();
  try {
    const created = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--title",
      "Pool task rework",
      "--ac",
      "First check",
      "--ac",
      "Second check",
    ]);
    assert.equal(created.task.assignee, "");

    const claimed = runWbJson([
      "claim",
      "--bucket",
      bucket,
      "--entity",
      "worker-1",
    ]);
    assert.equal(claimed.task.claimed_by, "worker-1");
    assert.equal(claimed.task.assignee, "");

    // Worker submits review with --check-ac
    const reviewed = runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "worker-1",
      "--task",
      created.task_id,
      "--type",
      "review",
      "--status",
      "review",
      "--check-ac",
    ]);
    assert.equal(reviewed.task.status, "review");

    const renderedReview = runWbJson([
      "render",
      "--bucket",
      bucket,
      "--task",
      created.task_id,
    ]);
    assert.match(renderedReview.body, /- \[x\] #1 First check/);
    assert.match(renderedReview.body, /- \[x\] #2 Second check/);

    // Owner sends feedback without --assignee: should auto-pin assignee=worker-1 and clear claimed_by
    const fb = runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      created.task_id,
      "--type",
      "feedback",
      "-m",
      "Needs adjustment",
      "--status",
      "pending",
      "--bump-revision",
    ]);
    assert.equal(fb.stage, "tasks");
    assert.equal(fb.task.status, "pending");
    assert.equal(fb.task.assignee, "worker-1");
    assert.equal(fb.task.claimed_by, "");
    assert.equal(fb.task.claim_round, 2);
    assert.equal(fb.task.revision, 2);

    // Another worker cannot claim worker-1's pinned task
    const otherBlocked = runWb([
      "claim",
      "--bucket",
      bucket,
      "--entity",
      "worker-2",
    ]);
    assert.equal(otherBlocked.status, 2);

    // worker-1 automatically picks it back up
    const reclaimed = runWbJson([
      "claim",
      "--bucket",
      bucket,
      "--entity",
      "worker-1",
    ]);
    assert.equal(reclaimed.task_id, created.task_id);
    assert.equal(reclaimed.task.status, "in-progress");

    // Reopening to general pool clears assignee and increments claim_round
    runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "worker-1",
      "--task",
      created.task_id,
      "--type",
      "question",
      "--status",
      "blocked",
      "-m",
      "Need pool handoff",
    ]);
    const reopened = runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      created.task_id,
      "--type",
      "answer",
      "-m",
      "Opening to pool",
      "--reopen",
    ]);
    assert.equal(reopened.stage, "tasks");
    assert.equal(reopened.task.status, "pending");
    assert.equal(reopened.task.assignee, "");
    assert.equal(reopened.task.claimed_by, "");
    assert.equal(reopened.task.claim_round, 3);

    // Now worker-2 can claim it
    const claimedBy2 = runWbJson([
      "claim",
      "--bucket",
      bucket,
      "--entity",
      "worker-2",
    ]);
    assert.equal(claimedBy2.task_id, created.task_id);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("human-created minimal/malformed tasks do not crash watch/render or deadlock completion", () => {
  const bucket = makeTempBucket();
  try {
    // 1) Malformed task.md folders must not crash watch on valid tasks
    fs.mkdirSync(path.join(bucket, "tasks", "bad-no-frontmatter"), { recursive: true });
    fs.writeFileSync(path.join(bucket, "tasks", "bad-no-frontmatter", "task.md"), "# Raw note\nno yaml");
    fs.mkdirSync(path.join(bucket, "tasks", "bad-unclosed"), { recursive: true });
    fs.writeFileSync(path.join(bucket, "tasks", "bad-unclosed", "task.md"), "---\ntitle: broken\n");

    // 2) Minimal human task omitting id/owner/events/ and using scalar tags & depends_on
    const blocker = runWbJson(["create", "--bucket", bucket, "--entity", "human", "--title", "Blocker"]);
    fs.mkdirSync(path.join(bucket, "tasks", "human-minimal"), { recursive: true });
    fs.writeFileSync(
      path.join(bucket, "tasks", "human-minimal", "task.md"),
      `---\ntitle: Human minimal\nstatus: pending\ntags: linux\ndepends_on: ${blocker.task_id}\n---\nDo it\n`
    );

    // Scalar depends_on must keep human-minimal blocked until blocker is complete
    const watchBlocked = runWb(["watch", "--bucket", bucket, "--entity", "exec-1", "--tag", "linux", "--timeout", "1", "--json"]);
    assert.equal(watchBlocked.status, 124);

    // Complete blocker
    runWbJson(["claim", "--bucket", bucket, "--entity", "exec-2", "--include-untagged", "--task", blocker.task_id]);
    runWbJson(["post", "--bucket", bucket, "--entity", "exec-2", "--task", blocker.task_id, "--type", "review", "--status", "review"]);
    runWbJson(["post", "--bucket", bucket, "--entity", "human", "--task", blocker.task_id, "--type", "complete"]);

    // Scalar tag "linux" must now surface human-minimal via watch despite broken neighbors
    const ready = runWbJson(["watch", "--bucket", bucket, "--entity", "exec-1", "--tag", "linux", "--timeout", "2"]);
    assert.equal(ready.count, 1);
    assert.equal(ready.tasks[0].id, "human-minimal");

    // Claiming must populate task_id from folder name and allow completion when owner is omitted
    const claimed = runWbJson(["claim", "--bucket", bucket, "--entity", "exec-1", "--tag", "linux", "--task", "human-minimal"]);
    assert.equal(claimed.task_id, "human-minimal");
    assert.equal(claimed.task.id, "human-minimal");

    // Plain-text note in events/ must not crash render
    fs.writeFileSync(path.join(bucket, "tasks", "human-minimal", "events", "human-note.md"), "Remember edge cases");
    const rendered = runWbJson(["render", "--bucket", bucket, "--task", "human-minimal"]);
    assert.equal(rendered.events.some((e) => e.type === "note" && e.body === "Remember edge cases"), true);

    runWbJson(["post", "--bucket", bucket, "--entity", "exec-1", "--task", "human-minimal", "--type", "review", "--status", "review"]);
    const completed = runWbJson(["post", "--bucket", bucket, "--entity", "reviewer-1", "--task", "human-minimal", "--type", "complete"]);
    assert.equal(completed.stage, "tasks");
    assert.equal(completed.task.status, "complete");
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("backlog draft/ready lifecycle prevents premature claims and promotes/demotes cleanly", () => {
  const bucket = makeTempBucket();
  try {
    const draftTask = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--title",
      "Backlog draft item",
      "--backlog",
    ]);
    assert.equal(draftTask.stage, "tasks");
    assert.equal(draftTask.task.status, "draft");
    assert.ok(fs.existsSync(path.join(bucket, "tasks", draftTask.task_id, "task.md")));

    // Worker cannot claim draft task
    assert.equal(runWb(["claim", "--bucket", bucket, "--entity", "w-1"]).status, 2);

    // Mark ready (still held back from workers)
    const markedReady = runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      draftTask.task_id,
      "--type",
      "log",
      "-m",
      "Refined and ready",
      "--status",
      "ready",
    ]);
    assert.equal(markedReady.stage, "tasks");
    assert.equal(markedReady.task.status, "ready");
    assert.equal(runWb(["claim", "--bucket", bucket, "--entity", "w-1"]).status, 2);

    // Another draft task also remains unclaimable until promoted
    const cancelledDraft = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--title",
      "Draft to cancel",
      "--status",
      "draft",
    ]);
    assert.equal(runWb(["claim", "--bucket", bucket, "--entity", "w-1"]).status, 2);

    // Promote draftTask to pending -> now claimable
    const promoted = runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      draftTask.task_id,
      "--type",
      "log",
      "-m",
      "Promoting to pending",
      "--status",
      "pending",
    ]);
    assert.equal(promoted.stage, "tasks");
    assert.equal(promoted.task.status, "pending");

    // Pull back to ready, then re-promote and claim
    const pulledBack = runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      draftTask.task_id,
      "--type",
      "log",
      "-m",
      "Holding back briefly",
      "--status",
      "ready",
    ]);
    assert.equal(pulledBack.stage, "tasks");
    assert.equal(pulledBack.task.status, "ready");
    assert.equal(runWb(["claim", "--bucket", bucket, "--entity", "w-1"]).status, 2);

    runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      draftTask.task_id,
      "--type",
      "log",
      "-m",
      "Ready for work",
      "--status",
      "pending",
    ]);
    const claimed = runWbJson(["claim", "--bucket", bucket, "--entity", "w-1"]);
    assert.equal(claimed.task_id, draftTask.task_id);

    // Cancel draft task directly
    const cancelled = runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      cancelledDraft.task_id,
      "--type",
      "cancelled",
      "-m",
      "Not needed",
    ]);
    assert.equal(cancelled.stage, "tasks");
    assert.equal(cancelled.task.status, "cancelled");
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("public messages filter by recipient/tags, coalesce bursts, and track last_msg_seen", async () => {
  const bucket = makeTempBucket();
  try {
    // Numeric slug ordering check
    const msgFiles = [
      "20261115T042310Z-bob-fix-phase-2-10.md",
      "20261115T042310Z-bob-fix-phase-2-2.md",
      "20261115T042310Z-bob-fix-phase-2.md",
    ];
    assert.deepEqual([...msgFiles].sort(compareMessageFilenames), [
      "20261115T042310Z-bob-fix-phase-2.md",
      "20261115T042310Z-bob-fix-phase-2-2.md",
      "20261115T042310Z-bob-fix-phase-2-10.md",
    ]);

    // Pre-existing message before bob registers should not flood initial watch
    const pre = runWbJson([
      "msg",
      "send",
      "--bucket",
      bucket,
      "--entity",
      "alice",
      "-m",
      "Old announcement",
    ]);
    assert.deepEqual(pre.to, ["*"]);

    // Register bob -> initializes last_msg_seen to pre.filename
    const regBob = runWbJson([
      "entity",
      "register",
      "--bucket",
      bucket,
      "--entity",
      "bob",
      "--tag",
      "bob-tasks",
    ]);
    assert.equal(regBob.last_msg_seen, pre.filename);

    // Start bob watcher; send unrelated message for joe + self-message from bob (neither should wake bob)
    const watchPromise = runWbAsync([
      "watch",
      "--bucket",
      bucket,
      "--entity",
      "bob",
      "--tag",
      "bob-tasks",
      "--poll-ms",
      "100",
      "--timeout",
      "4",
      "--json",
    ]);

    await new Promise((r) => setTimeout(r, 120));
    runWbJson([
      "msg",
      "send",
      "--bucket",
      bucket,
      "--entity",
      "alice",
      "--to",
      "joe",
      "-m",
      "For joe only",
    ]);
    runWbJson([
      "msg",
      "send",
      "--bucket",
      bucket,
      "--entity",
      "bob",
      "-m",
      "Self broadcast should not wake bob",
    ]);

    // Now send a rapid burst of two relevant messages (broadcast + tag-targeted)
    const m1 = runWbJson([
      "msg",
      "send",
      "--bucket",
      bucket,
      "--entity",
      "alice",
      "--tag",
      "bob-tasks",
      "-m",
      "First update",
    ]);
    assert.deepEqual(m1.to, []);
    const m2 = runWbJson([
      "msg",
      "send",
      "--bucket",
      bucket,
      "--entity",
      "alice",
      "-m",
      "Second broadcast",
    ]);

    const watchRes = await watchPromise;
    assert.equal(watchRes.status, 0, watchRes.stderr);
    const payload = JSON.parse(watchRes.stdout);
    assert.equal(payload.mode, "ready");
    assert.equal(payload.tasks.length, 0);
    assert.deepEqual(
      payload.messages.map((m) => m.filename),
      [m1.filename, m2.filename]
    );
    assert.equal(payload.last_msg_seen, m2.filename);

    // Re-arming watch must NOT loop on already-delivered messages
    const secondWatch = runWb([
      "watch",
      "--bucket",
      bucket,
      "--entity",
      "bob",
      "--tag",
      "bob-tasks",
      "--poll-ms",
      "100",
      "--timeout",
      "1",
      "--json",
    ]);
    assert.equal(secondWatch.status, 124);

    // Public list --all shows every message including joe-targeted and old ones
    const allMsgs = runWbJson(["msg", "list", "--bucket", bucket, "--all"]);
    assert.equal(allMsgs.count, 5);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("entities, tags registry, and owner-only watch mode", async () => {
  const bucket = makeTempBucket();
  try {
    runWbJson([
      "tag",
      "set",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--tag",
      "macos",
      "-m",
      "Entities running on macOS hosts",
    ]);
    runWbJson([
      "entity",
      "register",
      "--bucket",
      bucket,
      "--entity",
      "mac-1",
      "--tag",
      "macos",
      "--mode",
      "continuous",
      "--ttl",
      "300",
    ]);

    // Simulate a stale entity by setting updated_at in the past
    runWbJson([
      "entity",
      "register",
      "--bucket",
      bucket,
      "--entity",
      "stale-1",
      "--tag",
      "linux",
      "--ttl",
      "60",
    ]);
    const stalePath = path.join(bucket, "entities", "stale-1.md");
    const staleRaw = fs.readFileSync(stalePath, "utf8").replace(
      /updated_at: "[^"]+"/,
      'updated_at: "2020-01-01T00:00:00Z"'
    );
    fs.writeFileSync(stalePath, staleRaw);

    const entities = runWbJson(["entity", "list", "--bucket", bucket, "--all"]);
    assert.equal(entities.count, 2);
    const macEnt = entities.entities.find((e) => e.entity_id === "mac-1");
    const staleEnt = entities.entities.find((e) => e.entity_id === "stale-1");
    assert.equal(macEnt.online, true);
    assert.equal(staleEnt.online, false);
    assert.equal(staleEnt.state, "stale");

    const tagsRes = runWbJson(["tag", "list", "--bucket", bucket]);
    const macTag = tagsRes.tags.find((t) => t.tag === "macos");
    assert.equal(macTag.documented, true);
    assert.equal(macTag.description, "Entities running on macOS hosts");
    assert.deepEqual(macTag.online_entities, ["mac-1"]);

    // Owner-only mode must ignore unclaimed pending/ tasks and intermediate log events, waking only on review/blocked or relevant messages
    const tOwned = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--title",
      "Owned task",
    ]);
    runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "other-owner",
      "--title",
      "Unclaimed pool task",
    ]);
    runWbJson([
      "claim",
      "--bucket",
      bucket,
      "--entity",
      "worker-1",
      "--task",
      tOwned.task_id,
    ]);

    const ownerWatch = runWbAsync([
      "watch",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--owner-only",
      "--poll-ms",
      "100",
      "--timeout",
      "4",
      "--json",
    ]);

    await new Promise((r) => setTimeout(r, 120));
    // Intermediate log event should NOT wake owner
    runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "worker-1",
      "--task",
      tOwned.task_id,
      "--type",
      "log",
      "-m",
      "Working on it",
    ]);

    await new Promise((r) => setTimeout(r, 150));
    // Transition to review SHOULD wake owner
    runWbJson([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "worker-1",
      "--task",
      tOwned.task_id,
      "--type",
      "review",
      "--status",
      "review",
      "-m",
      "Ready for review",
    ]);

    const ownerRes = await ownerWatch;
    assert.equal(ownerRes.status, 0, ownerRes.stderr);
    const ownerPayload = JSON.parse(ownerRes.stdout);
    assert.equal(ownerPayload.mode, "owner");
    assert.equal(ownerPayload.tasks.length, 0);
    assert.equal(ownerPayload.owner_tasks.length, 1);
    assert.equal(ownerPayload.owner_tasks[0].id, tOwned.task_id);
    assert.equal(ownerPayload.owner_tasks[0].status, "review");
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("lockless claim election tie-breaks deterministically, rejects split-brain post, and ignores sync-conflict files", () => {
  const bucket = makeTempBucket();
  try {
    assert.equal(isSyncConflictFilename("task.sync-conflict-20261115-120000-ABCD.md"), true);
    assert.equal(isSyncConflictFilename("note (alice's conflicted copy 2026-11-15).md"), true);
    assert.equal(isSyncConflictFilename("task.md"), false);

    const created = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--title",
      "Tie-break & conflict resilience",
    ]);
    const taskDir = path.join(bucket, "tasks", created.task_id);
    const eventsDir = path.join(taskDir, "events");

    // Simulate two late-synced same-second claims for round 1 where "bob" > "alice" lexicographically,
    // even if "bob" mistakenly wrote task.md first before "alice"'s claim arrived.
    fs.writeFileSync(
      path.join(eventsDir, "20261115T120000Z-bob-claimed.md"),
      "---\ntype: claimed\nentity_id: bob\ntimestamp: \"2026-11-15T12:00:00Z\"\nround: 1\n---\n\nClaimed by bob\n"
    );
    fs.writeFileSync(
      path.join(eventsDir, "20261115T120000Z-alice-claimed.md"),
      "---\ntype: claimed\nentity_id: alice\ntimestamp: \"2026-11-15T12:00:00Z\"\nround: 1\n---\n\nClaimed by alice\n"
    );

    const election = getRoundClaims(eventsDir, 1);
    assert.equal(election.claims.length, 2);
    assert.equal(election.winner.entityId, "alice");

    // Update task.md to simulate bob having temporarily thought he won before sync settled
    const rawTask = fs.readFileSync(path.join(taskDir, "task.md"), "utf8");
    fs.writeFileSync(
      path.join(taskDir, "task.md"),
      rawTask
        .replace('status: "pending"', 'status: "in-progress"')
        .replace('claimed_by: ""', 'claimed_by: "bob"')
    );

    // Add Syncthing & Dropbox conflict artifacts across task dir, events/, and messages/
    fs.writeFileSync(path.join(taskDir, "task.sync-conflict-20261115-120001-HOST1.md"), "conflict");
    fs.writeFileSync(
      path.join(eventsDir, "20261115T120000Z-bob-claimed.sync-conflict-20261115-120001.md"),
      "conflict event"
    );
    fs.writeFileSync(
      path.join(bucket, "messages", "20261115T120000Z-owner-hi (alice's conflicted copy 2026-11-15).md"),
      "conflict msg"
    );

    // Render reports claim_winner === "alice", ignores conflict event file, and warns to stderr on conflict artifact
    const renderedRes = runWb(["render", "--bucket", bucket, "--task", created.task_id, "--json"]);
    assert.equal(renderedRes.status, 0, renderedRes.stderr);
    assert.match(renderedRes.stderr, /sync conflict copy detected/i);
    const rendered = JSON.parse(renderedRes.stdout);
    assert.equal(rendered.claim_winner, "alice");
    assert.equal(rendered.events.some((e) => isSyncConflictFilename(e.filename)), false);

    // Bob's mutating post (in-progress) fails split-brain guard (exit 2)
    const splitRes = runWb([
      "post",
      "--bucket",
      bucket,
      "--entity",
      "bob",
      "--task",
      created.task_id,
      "--type",
      "review",
      "--status",
      "review",
    ]);
    assert.equal(splitRes.status, 2);
    assert.match(splitRes.stderr, /Split-brain claim conflict/);

    // Public message list ignores conflict message file
    const msgs = runWbJson(["msg", "list", "--bucket", bucket, "--all"]);
    assert.equal(msgs.count, 0);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

function createReplicaSyncer(replicaA, replicaB) {
  // Bidirectional eventual-consistency folder syncer:
  // - Unique append-only files (events/, messages/, tags/, entities/) are union-copied.
  // - Mutable task.md propagates newer mtime, emitting a .sync-conflict- copy if both changed since last sync.
  const lastSyncState = new Map();

  function syncDirTree(dirA, dirB, rel = "") {
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const entriesA = fs.readdirSync(dirA, { withFileTypes: true });
    const entriesB = fs.readdirSync(dirB, { withFileTypes: true });
    const mapA = new Map(entriesA.filter((e) => !e.name.startsWith(".")).map((e) => [e.name, e]));
    const mapB = new Map(entriesB.filter((e) => !e.name.startsWith(".")).map((e) => [e.name, e]));
    const allNames = new Set([...mapA.keys(), ...mapB.keys()]);

    for (const name of allNames) {
      const pA = path.join(dirA, name);
      const pB = path.join(dirB, name);
      const key = rel ? `${rel}/${name}` : name;
      const eA = mapA.get(name);
      const eB = mapB.get(name);
      if ((eA && eA.isDirectory()) || (eB && eB.isDirectory())) {
        syncDirTree(pA, pB, key);
        continue;
      }
      if (eA && !eB) {
        const buf = fs.readFileSync(pA);
        fs.writeFileSync(pB, buf);
        lastSyncState.set(key, buf.toString("utf8"));
      } else if (!eA && eB) {
        const buf = fs.readFileSync(pB);
        fs.writeFileSync(pA, buf);
        lastSyncState.set(key, buf.toString("utf8"));
      } else if (eA && eB) {
        const strA = fs.readFileSync(pA, "utf8");
        const strB = fs.readFileSync(pB, "utf8");
        if (strA === strB) {
          lastSyncState.set(key, strA);
          continue;
        }
        const prev = lastSyncState.get(key);
        const statA = fs.statSync(pA);
        const statB = fs.statSync(pB);
        if (prev !== undefined && strA !== prev && strB !== prev && name === "task.md") {
          const loserBuf = statA.mtimeMs >= statB.mtimeMs ? strB : strA;
          const winnerBuf = statA.mtimeMs >= statB.mtimeMs ? strA : strB;
          const conflictName = `task.sync-conflict-20261115-sim-${Date.now()}.md`;
          fs.writeFileSync(path.join(dirA, conflictName), loserBuf);
          fs.writeFileSync(path.join(dirB, conflictName), loserBuf);
          fs.writeFileSync(pA, winnerBuf);
          fs.writeFileSync(pB, winnerBuf);
          lastSyncState.set(key, winnerBuf);
        } else if (statA.mtimeMs >= statB.mtimeMs) {
          fs.writeFileSync(pB, strA);
          lastSyncState.set(key, strA);
        } else {
          fs.writeFileSync(pA, strB);
          lastSyncState.set(key, strB);
        }
      }
    }
  }

  return () => syncDirTree(replicaA, replicaB);
}

test("two-replica async-sync simulator executes concurrent claims without double-claim or corruption", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-cloud-sim-"));
  const replicaA = path.join(root, "replica-a");
  const replicaB = path.join(root, "replica-b");
  const syncOnce = createReplicaSyncer(replicaA, replicaB);

  let syncStopped = false;
  const syncTimer = setInterval(() => {
    if (!syncStopped) syncOnce();
  }, 40);

  try {
    setBucketConfig(replicaA, { sync: "cloud", claim_settle_ms: 300 });
    const t1 = runWbJson(["create", "--bucket", replicaA, "--entity", "owner-a", "--title", "Sim task 1"]);
    const t2 = runWbJson(["create", "--bucket", replicaA, "--entity", "owner-a", "--title", "Sim task 2"]);
    await new Promise((r) => setTimeout(r, 120));

    // Both replicas race to claim from their local directories while async sync runs every 40ms
    const [resA, resB] = await Promise.all([
      runWbAsync(["claim", "--bucket", replicaA, "--entity", "worker-a", "--json"]),
      runWbAsync(["claim", "--bucket", replicaB, "--entity", "worker-b", "--json"]),
    ]);

    assert.equal(resA.status, 0, `worker-a failed: ${resA.stderr}`);
    assert.equal(resB.status, 0, `worker-b failed: ${resB.stderr}`);
    const claimA = JSON.parse(resA.stdout);
    const claimB = JSON.parse(resB.stdout);

    // Wait for async replication to settle
    await new Promise((r) => setTimeout(r, 150));

    // Each task must be exclusively claimed (one by worker-a, the other by worker-b, since worker-a loses round 1 on t1 or gets t2)
    assert.notEqual(claimA.task_id, claimB.task_id);
    assert.deepEqual(new Set([claimA.task_id, claimB.task_id]), new Set([t1.task_id, t2.task_id]));

    // Both workers finish their tasks on their respective replicas and owner completes them
    runWbJson(["post", "--bucket", replicaA, "--entity", "worker-a", "--task", claimA.task_id, "--type", "review", "--status", "review"]);
    runWbJson(["post", "--bucket", replicaB, "--entity", "worker-b", "--task", claimB.task_id, "--type", "review", "--status", "review"]);
    await new Promise((r) => setTimeout(r, 150));

    runWbJson(["post", "--bucket", replicaA, "--entity", "owner-a", "--task", t1.task_id, "--type", "complete"]);
    runWbJson(["post", "--bucket", replicaA, "--entity", "owner-a", "--task", t2.task_id, "--type", "complete"]);
    await new Promise((r) => setTimeout(r, 120));

    const r1B = runWbJson(["render", "--bucket", replicaB, "--task", t1.task_id]);
    const r2B = runWbJson(["render", "--bucket", replicaB, "--task", t2.task_id]);
    assert.equal(r1B.task.status, "complete");
    assert.equal(r2B.task.status, "complete");
  } finally {
    syncStopped = true;
    clearInterval(syncTimer);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("slow-sync simulator recovers when sync delay exceeds bucket settle and LWW loser overwrites task.md", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-slow-sim-"));
  const replicaA = path.join(root, "replica-a");
  const replicaB = path.join(root, "replica-b");
  const syncOnce = createReplicaSyncer(replicaA, replicaB);

  try {
    setBucketConfig(replicaA, { sync: "cloud", claim_settle_ms: 50 });
    const t1 = runWbJson(["create", "--bucket", replicaA, "--entity", "owner-a", "--title", "Slow sync race"]);
    syncOnce();

    // Simulate slow cloud sync paused across claims (claimSettleMs=50ms < sync delay).
    // Start "alpha" first, then "zeta" slightly later so "zeta" loses the election ("alpha" < "zeta")
    // yet writes a newer LWW task.md mtime!
    const resAlpha = await runWbAsync(["claim", "--bucket", replicaA, "--entity", "alpha", "--json"]);
    await new Promise((r) => setTimeout(r, 30));
    const resZeta = await runWbAsync(["claim", "--bucket", replicaB, "--entity", "zeta", "--json"]);
    assert.equal(resAlpha.status, 0, resAlpha.stderr);
    assert.equal(resZeta.status, 0, resZeta.stderr);

    // Delayed sync now delivers both events and creates a real .sync-conflict- copy,
    // with LWW task.md temporarily showing claimed_by: "zeta" on both replicas.
    syncOnce();
    const taskFiles = fs.readdirSync(path.join(replicaA, "tasks", t1.task_id));
    assert.ok(taskFiles.some((f) => isSyncConflictFilename(f)));

    // Both replicas deterministically agree on claim_winner === "alpha"
    const rA = runWb(["render", "--bucket", replicaA, "--task", t1.task_id, "--json"]);
    const rB = runWb(["render", "--bucket", replicaB, "--task", t1.task_id, "--json"]);
    assert.equal(JSON.parse(rA.stdout).claim_winner, "alpha");
    assert.equal(JSON.parse(rB.stdout).claim_winner, "alpha");

    // Loser "zeta" is rejected at post even though LWW task.md temporarily had claimed_by="zeta"
    const zetaPost = runWb([
      "post",
      "--bucket",
      replicaB,
      "--entity",
      "zeta",
      "--task",
      t1.task_id,
      "--type",
      "review",
      "--status",
      "review",
    ]);
    assert.equal(zetaPost.status, 2);
    assert.match(zetaPost.stderr, /Split-brain claim conflict/);

    // Winner "alpha" heals task.md and completes full feedback rework across delayed syncs
    const rev1 = runWbJson([
      "post",
      "--bucket",
      replicaA,
      "--entity",
      "alpha",
      "--task",
      t1.task_id,
      "--type",
      "review",
      "--status",
      "review",
      "-m",
      "Round 1 work",
    ]);
    assert.equal(rev1.task.claimed_by, "alpha");
    syncOnce();

    const fb = runWbJson([
      "post",
      "--bucket",
      replicaB,
      "--entity",
      "owner-a",
      "--task",
      t1.task_id,
      "--type",
      "feedback",
      "-m",
      "Polish",
      "--status",
      "pending",
      "--bump-revision",
    ]);
    assert.equal(fb.task.claim_round, 2);
    assert.equal(fb.task.assignee, "alpha");
    syncOnce();

    runWbJson(["claim", "--bucket", replicaA, "--entity", "alpha"]);
    runWbJson(["post", "--bucket", replicaA, "--entity", "alpha", "--task", t1.task_id, "--type", "review", "--status", "review"]);
    syncOnce();

    const done = runWbJson(["post", "--bucket", replicaB, "--entity", "owner-a", "--task", t1.task_id, "--type", "complete"]);
    assert.equal(done.task.status, "complete");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
