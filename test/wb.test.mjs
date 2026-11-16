import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  TRANSITIONS,
} from "../scripts/wb.mjs";
import { COMMANDS, parseCommand } from "../scripts/commands.mjs";

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

test("delivery declarations refuse non-polling direct recipients before publication", () => {
  const bucket = makeTempBucket();
  try {
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Delivery"]);
    const args = ["--bucket", bucket, "--task", task.id];
    const claim = runWbJson(["claim", ...args, "--entity", "child", "--dispatcher", "dispatcher"]);
    const childPath = path.join(bucket, "entities", "child.md");
    assert.equal(parseFrontmatter(fs.readFileSync(childPath, "utf8")).data.delivery, "none");
    const sender = runWbJson(["entity", "register", "--bucket", bucket, "--entity", "sender", "--mode", "owner"]);
    assert.equal(sender.delivery, "watch");
    const beforeSender = fs.readFileSync(sender.path, "utf8");
    const send = ["msg", "send", "--bucket", bucket, "--entity", "sender", "-m", "Correction"];
    for (const to of ["child", "sender,child", "*,child"]) {
      const result = runWb([...send, "--to", to]);
      assert.equal(result.status, 2, result.stderr);
      assert.ok(result.stderr.includes(`amend --task ${task.id}`));
      assert.equal(result.stderr.trim().split("\n").length, 1);
      assert.deepEqual(fs.readdirSync(path.join(bucket, "messages")), []);
      assert.equal(fs.readFileSync(sender.path, "utf8"), beforeSender);
    }
    const forced = runWbJson([...send, "--to", "child", "--force"]);
    assert.equal(forced.forced, true);
    assert.equal(parseFrontmatter(fs.readFileSync(forced.path, "utf8")).data.forced, true);
    assert.equal(runWbJson(["msg", "list", "--bucket", bucket, "--all"]).messages[0].forced, true);
    runWbJson([...send, "--to", "unknown"]);
    runWbJson([...send, "--tag", "linux"]);
    assert.equal(runWbJson(["msg", "list", "--bucket", bucket, "--entity", "child", "--unread"]).count, 1);
    runWbJson(["watch", ...args, "--entity", "child", "--after-event", claim.claimed_event]);
    assert.equal(parseFrontmatter(fs.readFileSync(childPath, "utf8")).data.delivery, "none");
    runWbJson(["entity", "register", "--bucket", bucket, "--entity", "child", "--ttl", "60"]);
    assert.equal(parseFrontmatter(fs.readFileSync(childPath, "utf8")).data.delivery, "none");
    assert.equal(runWb(["entity", "register", "--bucket", bucket, "--entity", "child", "--delivery", "email"]).status, 1);
    for (const mode of ["once", "one-shot"]) {
      assert.equal(runWbJson(["entity", "register", "--bucket", bucket, "--entity", mode, "--mode", mode]).delivery, "none");
    }
    assert.equal(runWbJson(["entity", "register", "--bucket", bucket, "--entity", "child", "--delivery", "watch"]).delivery, "watch");
    assert.equal(runWbJson(["entity", "end", "--bucket", bucket, "--entity", "child"]).delivery, "none");
    assert.equal(runWb(["watch", "--bucket", bucket, "--entity", "poller", "--owner-only", "--timeout", "0.1"]).status, 124);
    assert.equal(parseFrontmatter(fs.readFileSync(path.join(bucket, "entities", "poller.md"), "utf8")).data.delivery, "watch");
    fs.writeFileSync(path.join(bucket, "entities", "legacy-once.md"), '---\nmode: "once"\n---\n');
    fs.writeFileSync(path.join(bucket, "entities", "legacy-continuous.md"), '---\nmode: "continuous"\n---\n');
    const entities = runWbJson(["entity", "list", "--bucket", bucket, "--all"]).entities;
    assert.equal(entities.find((entity) => entity.entity_id === "legacy-once").delivery, "none");
    assert.equal(entities.find((entity) => entity.entity_id === "legacy-continuous").delivery, "watch");
    assert.equal(runWb([...send, "--to", "legacy-once"]).status, 2);
  } finally { fs.rmSync(bucket, { recursive: true, force: true }); }
});

test("instruction versions hash selected normalized bodies and ack prints a durable diff", () => {
  const bucket = makeTempBucket();
  try {
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Versions", "--tag", "z,a"]);
    const args = ["--bucket", bucket, "--task", task.id];
    const rules = path.join(bucket, "INSTRUCTIONS.md");
    fs.writeFileSync(rules, "---\nupdated_at: old\n---\nCommon\nOld rule\nEnd\n");
    runWbJson(["tag", "set", "--bucket", bucket, "--entity", "owner", "--tag", "a", "-m", "A rule"]);
    runWbJson(["tag", "set", "--bucket", bucket, "--entity", "owner", "--tag", "z", "-m", "Z rule"]);
    const claim = runWbJson(["claim", ...args, "--entity", "executor"]);
    assert.match(claim.instructions_seen, /^[a-f0-9]{64}$/);
    assert.equal(claim.instructions_seen, createHash("sha256")
      .update(JSON.stringify(["Common\nOld rule\nEnd", "A rule", "Z rule"])).digest("hex"));
    assert.deepEqual(claim.instructions.map((item) => item.file), ["INSTRUCTIONS.md", "tags/a.md", "tags/z.md"]);
    const committed = parseFrontmatter(fs.readFileSync(path.join(task.path, "events", claim.last_event_seen), "utf8")).data;
    assert.equal(committed.instructions_hash, claim.instructions_seen);
    assert.deepEqual(committed.instruction_content, {
      "INSTRUCTIONS.md": "Common\nOld rule\nEnd", "tags/a.md": "A rule", "tags/z.md": "Z rule",
    });
    fs.writeFileSync(rules, "---\nupdated_at: new\n---\r\n Common\r\nOld rule\r\nEnd\r\n\r\n");
    fs.writeFileSync(path.join(bucket, "tags", "a.md"), "---\nupdated_at: new\n---\r\nA rule\r\n");
    runWbJson(["tag", "set", "--bucket", bucket, "--entity", "owner", "--tag", "irrelevant", "-m", "Not selected"]);
    const unchanged = runWbJson(["ack-instructions", ...args, "--entity", "executor"]);
    assert.equal(unchanged.task_updated, false);
    assert.equal(unchanged.state_seq, claim.state_seq);
    assert.equal(unchanged.instruction_diff, "");
    const ordered = fs.readFileSync(task.task_path, "utf8");
    const reversed = parseFrontmatter(ordered);
    fs.writeFileSync(task.task_path, `${serializeFrontmatter({ ...reversed.data, tags: ["a", "z"] })}\n${reversed.body}`);
    assert.equal(runWbJson(["ack-instructions", ...args, "--entity", "executor"]).instructions_seen, claim.instructions_seen);
    fs.writeFileSync(task.task_path, ordered);
    fs.writeFileSync(rules, "---\nupdated_at: new\n---\nCommon\nNew rule\nEnd\n");
    const before = fs.readFileSync(task.task_path, "utf8");
    const eventsBefore = fs.readdirSync(path.join(task.path, "events"));
    for (const command of [
      ["question"], ["review", "--ac", "1=pass", "--proposed-outcome", "pass"],
      ["run", "--", process.execPath, "-e", "process.exit(0)"],
    ]) {
      const [name, ...flags] = command;
      const result = runWb([name, ...args, "--entity", "executor", ...flags]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /ack-instructions/);
      assert.equal(fs.readFileSync(task.task_path, "utf8"), before);
      assert.deepEqual(fs.readdirSync(path.join(task.path, "events")), eventsBefore);
    }
    const ack = runWbJson(["ack-instructions", ...args, "--entity", "executor"]);
    assert.notEqual(ack.instructions_seen, claim.instructions_seen);
    assert.equal(ack.revision, claim.revision);
    assert.equal(ack.claim_round, claim.claim_round);
    assert.equal(ack.state_seq, claim.state_seq + 1);
    assert.equal(ack.instruction_diff, "--- INSTRUCTIONS.md\n+++ INSTRUCTIONS.md\n@@ line 2 @@\n-Old rule\n+New rule");
    assert.equal(parseFrontmatter(fs.readFileSync(task.task_path, "utf8")).body, parseFrontmatter(before).body);
    const receipt = parseFrontmatter(fs.readFileSync(path.join(task.path, "events", ack.event), "utf8")).data;
    assert.equal(receipt.instruction_content["INSTRUCTIONS.md"], "Common\nNew rule\nEnd");
    fs.unlinkSync(path.join(bucket, "tags", "z.md"));
    const second = runWbJson(["ack-instructions", ...args, "--entity", "executor"]);
    assert.match(second.instruction_diff, /-Z rule/);
    assert.doesNotMatch(second.instruction_diff, /Old rule/);
    const materialized = parseFrontmatter(fs.readFileSync(task.task_path, "utf8"));
    fs.writeFileSync(task.task_path, `${serializeFrontmatter({ ...materialized.data, instructions_seen: "drift" })}\n${materialized.body}`);
    runWbJson(["fsck", "--bucket", bucket, "--repair"]);
    assert.equal(runWbJson(["render", ...args]).instructions_seen, second.instructions_seen);
    assert.equal(runWbJson(["question", ...args, "--entity", "executor"]).status, "blocked");
    assert.equal(runWbJson(["fsck", "--bucket", bucket]).unresolved, 0);
  } finally { fs.rmSync(bucket, { recursive: true, force: true }); }
});

test("run checks instruction versions outside in-progress work before opening logs or spawning", () => {
  const bucket = makeTempBucket();
  try {
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "All run guards"]);
    const args = ["--bucket", bucket, "--task", task.id];
    const marker = path.join(bucket, "spawned");
    const log = path.join(bucket, "command.log");
    const cmd = ["--log", log, "--", process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned")`];
    assert.equal(runWb(["run", ...args, "--entity", "owner", ...cmd]).status, 0);
    assert.equal(fs.readFileSync(marker, "utf8"), "spawned");
    fs.unlinkSync(marker);
    fs.unlinkSync(log);
    fs.writeFileSync(path.join(bucket, "INSTRUCTIONS.md"), "Initial standing rule\n");
    assert.equal(runWb(["run", ...args, "--entity", "owner", ...cmd]).status, 1);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(log), false);
    for (const status of ["draft", "ready"]) {
      const held = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", status, "--status", status]);
      const result = runWb(["run", "--bucket", bucket, "--task", held.id, "--entity", "owner", ...cmd]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /promote to pending, then claim/);
    }
    runWbJson(["claim", ...args, "--entity", "executor"]);
    runWbJson(["review", ...args, "--entity", "executor", "--ac", "1=pass", "--proposed-outcome", "pass"]);
    fs.writeFileSync(path.join(bucket, "INSTRUCTIONS.md"), "Changed after review\n");
    const before = fs.readFileSync(task.task_path, "utf8");
    for (const entity of ["owner", "executor"]) {
      const result = runWb(["run", ...args, "--entity", entity, ...cmd]);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /use owner feedback, then claim/);
      assert.equal(fs.existsSync(marker), false);
      assert.equal(fs.existsSync(log), false);
      assert.equal(fs.readFileSync(task.task_path, "utf8"), before);
    }
    runWbJson(["feedback", ...args, "--entity", "owner"]);
    runWbJson(["claim", ...args, "--entity", "executor"]);
    const result = runWb(["run", ...args, "--entity", "executor", ...cmd]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(marker, "utf8"), "spawned");
    assert.equal(runWbJson(["fsck", "--bucket", bucket]).unresolved, 0);
  } finally { fs.rmSync(bucket, { recursive: true, force: true }); }
});

test("legacy claimants acknowledge rules without granting receipt authority to owner or dispatcher", () => {
  const bucket = makeTempBucket();
  try {
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Legacy receipt"]);
    const args = ["--bucket", bucket, "--task", task.id];
    runWbJson(["claim", ...args, "--entity", "executor", "--dispatcher", "dispatcher"]);
    const parsed = parseFrontmatter(fs.readFileSync(task.task_path, "utf8"));
    fs.writeFileSync(task.task_path, `${serializeFrontmatter({ ...parsed.data, instructions_seen: "" })}\n${parsed.body}`);
    fs.writeFileSync(path.join(bucket, "INSTRUCTIONS.md"), "Acknowledge this rule.\n");
    fs.writeFileSync(path.join(task.path, "events", "human-note.md"), "Plain historical note\n");
    const before = fs.readFileSync(task.task_path, "utf8");
    for (const actor of ["owner", "dispatcher", "stranger"]) {
      assert.equal(runWb(["ack-instructions", ...args, "--entity", actor]).status, 3);
      assert.equal(fs.readFileSync(task.task_path, "utf8"), before);
    }
    assert.equal(runWb(["question", ...args, "--entity", "executor"]).status, 1);
    const acknowledged = runWb(["ack-instructions", ...args, "--entity", "executor"]);
    assert.equal(acknowledged.status, 0, acknowledged.stderr);
    assert.match(acknowledged.stdout, /\+Acknowledge this rule\./);
    assert.equal(runWbJson(["render", ...args]).revision, parsed.data.revision);
    const unknown = parseFrontmatter(fs.readFileSync(task.task_path, "utf8"));
    fs.writeFileSync(task.task_path, `${serializeFrontmatter({ ...unknown.data, instructions_seen: "missing-version" })}\n${unknown.body}`);
    const recovered = runWbJson(["ack-instructions", ...args, "--entity", "executor"]);
    assert.match(recovered.instruction_diff, /Previous instruction content unavailable/);
    runWbJson(["question", ...args, "--entity", "executor"]);
    assert.equal(runWb(["ack-instructions", ...args, "--entity", "executor"]).status, 1);
  } finally { fs.rmSync(bucket, { recursive: true, force: true }); }
});

test("a rule change during a running command does not kill it but gates subsequent reporting", async () => {
  const bucket = makeTempBucket();
  let wrapper;
  try {
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Mid-command rules"]);
    const args = ["--bucket", bucket, "--task", task.id, "--entity", "executor"];
    runWbJson(["claim", ...args]);
    wrapper = spawn(process.execPath, [WB_PATH, "run", ...args, "--", process.execPath, "-e",
      "console.log('ready'); setTimeout(() => process.exit(0), 500)"], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise((resolve) => wrapper.once("close", (code) => resolve(code)));
    await new Promise((resolve, reject) => {
      wrapper.stdout.once("data", resolve);
      wrapper.once("error", reject);
    });
    fs.writeFileSync(path.join(bucket, "INSTRUCTIONS.md"), "New standing rule.\n");
    assert.equal(await exited, 0);
    assert.equal(runWb(["question", ...args]).status, 1);
    runWbJson(["ack-instructions", ...args]);
    assert.equal(runWbJson(["review", ...args, "--ac", "1=pass", "--proposed-outcome", "pass"]).status, "review");
  } finally {
    if (wrapper && wrapper.exitCode === null) wrapper.kill("SIGTERM");
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("amend receipts cover every outstanding file and log explicit ignores without bypassing rules", () => {
  const bucket = makeTempBucket();
  try {
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Receipts"]);
    const args = ["--bucket", bucket, "--task", task.id];
    const first = runWbJson(["amend", ...args, "--entity", "owner", "-m", "First correction"]);
    runWbJson(["claim", ...args, "--entity", "executor"]);
    const second = runWbJson(["amend", ...args, "--entity", "owner", "-m", "Ignored correction"]);
    const before = fs.readFileSync(task.task_path, "utf8");
    const eventsBefore = fs.readdirSync(path.join(task.path, "events"));
    for (const flags of [
      ["--ignore-amend", second.event], ["--ignore-amend", second.event, "--reason", " "],
      ["--ignore-amend", "../foreign.md", "--reason", "No"], ["--reason", "No file"],
    ]) {
      const result = runWb(["accept-amends", ...args, "--entity", "executor", ...flags]);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(fs.readFileSync(task.task_path, "utf8"), before);
      assert.deepEqual(fs.readdirSync(path.join(task.path, "events")), eventsBefore);
    }
    for (const command of [["question"], ["review", "--ac", "1=pass", "--proposed-outcome", "pass"]]) {
      assert.equal(runWb([command[0], ...args, "--entity", "executor", ...command.slice(1)]).status, 1);
    }
    const receipt = runWbJson(["accept-amends", ...args, "--entity", "executor",
      "--ignore-amend", second.event, "--reason", "Superseded"]);
    assert.equal(receipt.last_amend_seen, second.event);
    assert.equal(receipt.revision, 2);
    const rendered = runWbJson(["render", ...args]);
    assert.match(rendered.body, /First correction/);
    assert.doesNotMatch(rendered.body, /Ignored correction/);
    const event = parseFrontmatter(fs.readFileSync(path.join(task.path, "events", receipt.event), "utf8"));
    assert.deepEqual(event.data.accepted_amends, [first.event]);
    assert.deepEqual(event.data.ignored_amends, [second.event]);
    assert.equal(event.data.ignore_reason, "Superseded");
    assert.equal(event.data.last_amend_seen, second.event);
    assert.match(event.body, /ignored \(Superseded\)/);
    assert.equal(runWb(["accept-amends", ...args, "--entity", "executor", "--ignore-amend", first.event, "--reason", "Old"]).status, 1);
    const third = runWbJson(["amend", ...args, "--entity", "owner", "-m", "Also ignored"]);
    const fourth = runWbJson(["amend", ...args, "--entity", "owner", "-m", "Also ignored again"]);
    const bodyBefore = runWbJson(["render", ...args]).body;
    fs.writeFileSync(path.join(bucket, "INSTRUCTIONS.md"), "Rules changed independently\n");
    const ignored = runWbJson(["accept-amends", ...args, "--entity", "executor",
      "--ignore-amend", `${third.event},${fourth.event}`, "--reason", "Not applicable"]);
    assert.equal(ignored.last_amend_seen, fourth.event);
    assert.equal(ignored.revision, receipt.revision);
    assert.equal(runWbJson(["render", ...args]).body, bodyBefore);
    assert.equal(runWb(["question", ...args, "--entity", "executor"]).status, 1);
    runWbJson(["ack-instructions", ...args, "--entity", "executor"]);
    assert.equal(runWbJson(["question", ...args, "--entity", "executor"]).status, "blocked");
    assert.equal(runWbJson(["fsck", "--bucket", bucket]).unresolved, 0);
  } finally { fs.rmSync(bucket, { recursive: true, force: true }); }
});

test("bulk amendments select only caller-owned in-progress tasks and retain independent receipts", () => {
  const bucket = makeTempBucket();
  try {
    const tasks = [];
    for (const [owner, tag, state] of [
      ["owner", "linux", "in-progress"], ["owner", "macos", "in-progress"],
      ["other", "linux", "in-progress"], ["owner", "linux", "pending"],
      ["owner", "linux", "review"], ["owner", "linux", "blocked"], ["owner", "linux", "complete"],
    ]) {
      const task = runWbJson(["create", "--bucket", bucket, "--entity", owner, "--title", state, "--tag", tag]);
      const executor = `executor-${tasks.length}`;
      const args = ["--bucket", bucket, "--task", task.id];
      if (["in-progress", "review", "blocked"].includes(state)) runWbJson(["claim", ...args, "--entity", executor]);
      if (state === "review") runWbJson(["review", ...args, "--entity", executor, "--ac", "1=pass", "--proposed-outcome", "pass"]);
      if (state === "blocked") runWbJson(["question", ...args, "--entity", executor]);
      if (state === "complete") runWbJson(["complete", ...args, "--entity", owner]);
      tasks.push({ ...task, executor });
    }
    const before = tasks.map((task) => ({
      body: fs.readFileSync(task.task_path, "utf8"), events: fs.readdirSync(path.join(task.path, "events")),
    }));
    const bulk = ["amend", "--bucket", bucket, "--entity", "owner", "--all-in-progress"];
    for (const flags of [
      ["--task", tasks[0].id], ["--assignee", ""], ["--ttl-seconds", "60"],
      ["--add-depends-on", tasks[3].id], ["--remove-depends-on", tasks[3].id], ["--owner", "other"],
    ]) assert.notEqual(runWb([...bulk, ...flags, "-m", "No publication"]).status, 0);
    assert.equal(runWb(["amend", "--bucket", bucket, "--entity", "owner", "--task", tasks[0].id, "--tag", "linux"]).status, 1);
    for (const [index, task] of tasks.entries()) {
      assert.equal(fs.readFileSync(task.task_path, "utf8"), before[index].body);
      assert.deepEqual(fs.readdirSync(path.join(task.path, "events")), before[index].events);
    }
    const filtered = runWbJson([...bulk, "--owner", "owner", "--tag", "linux", "-m", "Urgent Linux correction"]);
    assert.deepEqual(filtered.tasks.map((task) => task.id), [tasks[0].id]);
    const sent = runWb([...bulk, "--tag", "linux,macos", "--stdin", "--json"], { input: "All-platform correction\nliteral `$(text)`" });
    assert.equal(sent.status, 0, sent.stderr);
    const all = JSON.parse(sent.stdout);
    assert.equal(all.count, 2);
    assert.deepEqual(new Set(all.tasks.map((task) => task.id)), new Set(tasks.slice(0, 2).map((task) => task.id)));
    for (const task of tasks.slice(0, 2)) {
      assert.equal(runWb(["question", "--bucket", bucket, "--task", task.id, "--entity", task.executor]).status, 1);
      const accepted = runWbJson(["accept-amends", "--bucket", bucket, "--task", task.id, "--entity", task.executor]);
      assert.equal(accepted.last_amend_seen, all.tasks.find((result) => result.id === task.id).event);
      assert.match(runWbJson(["render", "--bucket", bucket, "--task", task.id]).body, /literal `\$\(text\)`/);
    }
    for (let i = 2; i < tasks.length; i += 1) {
      assert.equal(fs.readFileSync(tasks[i].task_path, "utf8"), before[i].body);
      assert.deepEqual(fs.readdirSync(path.join(tasks[i].path, "events")), before[i].events);
    }
    assert.equal(runWbJson([...bulk, "--tag", "no-match", "-m", "No work"]).count, 0);
    assert.equal(runWbJson(["fsck", "--bucket", bucket]).unresolved, 0);
  } finally { fs.rmSync(bucket, { recursive: true, force: true }); }
});

test("bulk amendment failures retain earlier publications and identify the stopped task", () => {
  const bucket = makeTempBucket();
  try {
    const first = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "First bulk target"]);
    const second = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Second bulk target"]);
    for (const [i, task] of [first, second].entries()) {
      runWbJson(["claim", "--bucket", bucket, "--entity", `executor-${i}`, "--task", task.id]);
    }
    const inject = `import fs from "node:fs";
      const original = fs.linkSync;
      fs.linkSync = (from, to) => {
        if (to.includes(${JSON.stringify(`${second.id}/events/`)}) && to.endsWith("-amend.md")) {
          const error = new Error("Injected publication failure"); error.code = "ENOSPC"; throw error;
        }
        return original(from, to);
      };`;
    const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(inject)}`,
      WB_PATH, "amend", "--bucket", bucket, "--entity", "owner", "--all-in-progress", "-m", "Correction", "--json"], { encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stderr.includes(`stopped at task "${second.id}"`));
    assert.ok(result.stderr.includes(`completed task IDs: ${first.id}`));
    assert.match(result.stderr, /Inspect the stopped task's events/);
    assert.equal(runWbJson(["render", "--bucket", bucket, "--task", first.id]).events.filter((event) => event.type === "amend").length, 1);
    assert.equal(runWbJson(["render", "--bucket", bucket, "--task", second.id]).events.filter((event) => event.type === "amend").length, 0);
    assert.equal(runWb(["question", "--bucket", bucket, "--task", first.id, "--entity", "executor-0"]).status, 1);
    assert.equal(runWbJson(["question", "--bucket", bucket, "--task", second.id, "--entity", "executor-1"]).status, "blocked");
    assert.equal(runWbJson(["fsck", "--bucket", bucket]).unresolved, 0);
  } finally { fs.rmSync(bucket, { recursive: true, force: true }); }
});

test("owner AC acceptance rejects a late-sync losing claimant's review", () => {
  const bucket = makeTempBucket();
  try {
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Losing review"]);
    const args = ["--bucket", bucket, "--task", task.id];
    runWbJson(["claim", ...args, "--entity", "zeta"]);
    runWbJson(["review", ...args, "--entity", "zeta", "--ac", "1=pass", "--proposed-outcome", "pass"]);
    writeUniqueEvent(path.join(task.path, "events"), "alpha", "claimed", "Late sync, earlier claim",
      new Date("2000-01-01T00:00:00Z"), { round: 1 });
    const before = fs.readFileSync(task.task_path, "utf8");
    const events = fs.readdirSync(path.join(task.path, "events"));
    assert.equal(runWb(["complete", ...args, "--entity", "owner", "--accept-ac"]).status, 1);
    assert.equal(fs.readFileSync(task.task_path, "utf8"), before);
    assert.deepEqual(fs.readdirSync(path.join(task.path, "events")), events);
  } finally { fs.rmSync(bucket, { recursive: true, force: true }); }
});

test("review requires exact numbered verdict coverage and preserves the brief", () => {
  const bucket = makeTempBucket();
  try {
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Verdicts",
      "--message=- [x] #1 First\n- [ ] #2 Second\n- [ ] #3 Third"]);
    const args = ["--bucket", bucket, "--task", task.id];
    const claim = runWbJson(["claim", ...args, "--entity", "executor"]);
    const before = fs.readFileSync(task.task_path, "utf8");
    const eventsDir = path.join(task.path, "events");
    const beforeEvents = fs.readdirSync(eventsDir);
    const valid = ["--ac", "1=pass,2=fail,3=not-run", "--proposed-outcome", "partial"];
    for (const flags of [
      [], ["--ac", "1=pass,2=fail,3=not-run"],
      ["--proposed-outcome", "partial"],
      ["--ac", "1=pass,2=fail", "--proposed-outcome", "partial"],
      ["--ac", "1=pass,2=fail,3=not-run,4=pass", "--proposed-outcome", "partial"],
      [...valid, "--ac", "1=pass"], [...valid, "--ac", "1=fail"],
      ["--ac", "1:pass,2=fail,3=not-run", "--proposed-outcome", "partial"],
      ["--ac", "1=yes,2=fail,3=not-run", "--proposed-outcome", "partial"],
      ["--ac", "1=pass,2=fail,3=not-run", "--proposed-outcome", "unknown"],
    ]) {
      const result = runWb(["review", ...args, "--entity", "executor", ...flags]);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(fs.readFileSync(task.task_path, "utf8"), before);
      assert.deepEqual(fs.readdirSync(eventsDir), beforeEvents);
    }
    const reviewed = runWbJson(["review", ...args, "--entity", "executor", ...valid, "-m", "Evidence"]);
    const rendered = runWbJson(["render", ...args]);
    assert.equal(rendered.body, parseFrontmatter(before).body.trim());
    const eventPath = path.join(eventsDir, reviewed.event);
    const eventBefore = fs.readFileSync(eventPath, "utf8");
    const verdicts = ["1:pass", "2:fail", "3:not-run"];
    assert.deepEqual(rendered.latest_event.ac, verdicts);
    assert.equal(rendered.latest_event.proposed_outcome, "partial");
    assert.deepEqual(runWbJson(["watch", "--bucket", bucket, "--entity", "owner", "--owner-only"]).owner_tasks[0].latest_event.ac, verdicts);
    assert.deepEqual(runWbJson(["watch", ...args, "--after-event", claim.last_event_seen]).events[0].ac, verdicts);
    const completed = runWbJson(["complete", ...args, "--entity", "owner", "--accept-ac"]);
    assert.equal(completed.outcome, "partial");
    assert.equal(runWbJson(["render", ...args]).body, "- [x] #1 First\n- [ ] #2 Second (fail)\n- [ ] #3 Third (not-run)");
    assert.equal(fs.readFileSync(eventPath, "utf8"), eventBefore);
    assert.equal(runWbJson(["fsck", "--bucket", bucket]).unresolved, 0);
  } finally { fs.rmSync(bucket, { recursive: true, force: true }); }
});

test("review rejects unnumbered, duplicate and invalid criterion numbers", () => {
  const bucket = makeTempBucket();
  try {
    for (const body of ["- [ ] Unnumbered", "- [ ] #1 One\n- [x] #1 Duplicate",
      "- [ ] #0 Zero", "- [ ] #9007199254740992 Unsafe"]) {
      const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Invalid brief", `--message=${body}`]);
      const args = ["--bucket", bucket, "--task", task.id];
      runWbJson(["claim", ...args, "--entity", "executor"]);
      const before = fs.readFileSync(task.task_path, "utf8");
      assert.equal(runWb(["review", ...args, "--entity", "executor", "--ac", "1=pass", "--proposed-outcome", "pass"]).status, 1);
      assert.equal(fs.readFileSync(task.task_path, "utf8"), before);
      runWbJson(["cancel", ...args, "--entity", "owner"]);
    }
  } finally { fs.rmSync(bucket, { recursive: true, force: true }); }
});

test("owner AC acceptance derives outcomes, requires mismatch confirmation and ignores old rounds", () => {
  const bucket = makeTempBucket();
  try {
    for (const [vector, derived, proposal, override] of [
      ["pass,pass", "pass", "pass"], ["fail,fail", "fail", "fail"],
      ["not-run,not-run", "partial", "partial"], ["fail,not-run", "partial", "partial"],
      ["pass,fail", "partial", "pass", "partial"], ["pass,pass", "pass", "partial", "abandoned"],
    ]) {
      const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", vector,
        "--message=- [ ] #1 One\n- [x] #2 Two"]);
      const args = ["--bucket", bucket, "--task", task.id];
      runWbJson(["claim", ...args, "--entity", "executor"]);
      runWbJson(["review", ...args, "--entity", "executor", "--ac",
        vector.split(",").map((v, i) => `${i + 1}=${v}`).join(","), "--proposed-outcome", proposal]);
      if (proposal !== derived) {
        const before = fs.readFileSync(task.task_path, "utf8");
        assert.equal(runWb(["complete", ...args, "--entity", "owner", "--accept-ac"]).status, 1);
        assert.equal(fs.readFileSync(task.task_path, "utf8"), before);
      }
      const done = runWbJson(["complete", ...args, "--entity", "owner", "--accept-ac",
        ...(override ? ["--outcome", override] : [])]);
      assert.equal(done.outcome, override || derived);
    }
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Rounds"]);
    const args = ["--bucket", bucket, "--task", task.id];
    runWbJson(["claim", ...args, "--entity", "executor"]);
    const old = runWbJson(["review", ...args, "--entity", "executor", "--ac", "1=fail", "--proposed-outcome", "fail"]);
    runWbJson(["feedback", ...args, "--entity", "owner"]);
    runWbJson(["claim", ...args, "--entity", "executor"]);
    assert.equal(runWb(["complete", ...args, "--entity", "owner", "--accept-ac"]).status, 1);
    runWbJson(["review", ...args, "--entity", "executor", "--ac", "1=pass", "--proposed-outcome", "pass"]);
    fs.renameSync(path.join(task.path, "events", old.event),
      path.join(task.path, "events", "20990101T000000000Z-executor-review.md"));
    assert.equal(runWbJson(["complete", ...args, "--entity", "owner", "--accept-ac"]).outcome, "pass");
    const plain = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "No review", "--message=- [ ] Unnumbered"]);
    assert.equal(runWbJson(["complete", "--bucket", bucket, "--task", plain.id, "--entity", "owner"]).outcome, "");
    assert.equal(runWbJson(["fsck", "--bucket", bucket]).unresolved, 0);
  } finally { fs.rmSync(bucket, { recursive: true, force: true }); }
});

test("recorded dispatcher routing survives rework with fresh children and refuses prefix or child pins", () => {
  const bucket = makeTempBucket();
  try {
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Routed", "--assignee", "dispatcher"]);
    const args = ["--bucket", bucket, "--task", task.id];
    assert.equal(runWb(["claim", ...args, "--entity", "dispatcher-spoof"]).status, 2);
    const child = runWbJson(["claim", ...args, "--entity", "child-1", "--dispatcher", "dispatcher"]);
    const entityPath = path.join(bucket, "entities", "child-1.md");
    const entity = parseFrontmatter(fs.readFileSync(entityPath, "utf8")).data;
    assert.equal(entity.dispatcher, "dispatcher");
    assert.equal(entity.mode, "once");
    assert.equal(entity.host, os.hostname());
    assert.equal(entity.claimed_task, task.id);
    assert.equal(entity.ttl_seconds, 300);
    runWbJson(["review", ...args, "--entity", "child-1", "--ac", "1=pass", "--proposed-outcome", "pass"]);
    const feedback = runWbJson(["feedback", ...args, "--entity", "owner"]);
    assert.equal(feedback.assignee, "dispatcher");
    assert.equal(feedback.affinity, "child-1");
    const wake = runWbJson(["watch", "--bucket", bucket, "--entity", "dispatcher"]);
    assert.equal(wake.tasks[0].affinity, "child-1");
    assert.equal(runWb(["claim", ...args, "--entity", "dispatcher-prefix"]).status, 2);
    const next = runWb(["claim", ...args, "--entity", "child-2", "--json"], {
      env: { ...process.env, WB_DISPATCHER: "dispatcher" },
    });
    assert.equal(next.status, 0, next.stderr);
    assert.equal(JSON.parse(next.stdout).claim_round, child.claim_round + 1);
    runWbJson(["question", ...args, "--entity", "child-2"]);
    const answer = runWbJson(["answer", ...args, "--entity", "owner"]);
    assert.equal(answer.assignee, "dispatcher");
    assert.equal(answer.affinity, "child-2");
    for (const command of [
      ["create", "--title", "Bad pin"], ["amend", "--task", task.id],
    ]) {
      const refusal = runWb([...command, "--bucket", bucket, "--entity", "owner", "--assignee", "child-1"]);
      assert.equal(refusal.status, 1);
      assert.match(refusal.stderr, /assign to dispatcher "dispatcher"/);
    }
    const before = fs.readFileSync(entityPath, "utf8");
    assert.equal(runWb(["claim", ...args, "--entity", "child-1", "--dispatcher", "different"]).status, 3);
    assert.equal(fs.readFileSync(entityPath, "utf8"), before);
    runWbJson(["claim", ...args, "--entity", "child-3", "--dispatcher", "dispatcher"]);
    runWbJson(["review", ...args, "--entity", "child-3", "--ac", "1=pass", "--proposed-outcome", "pass"]);
    const reopened = runWbJson(["feedback", ...args, "--entity", "owner", "--reopen"]);
    assert.equal(reopened.assignee, "");
    assert.equal(reopened.affinity, "");
    assert.equal(runWbJson(["fsck", "--bucket", bucket]).unresolved, 0);
  } finally { fs.rmSync(bucket, { recursive: true, force: true }); }
});

test("release requires a structured checkpoint and only the elected claimant or recorded dispatcher", () => {
  const bucket = makeTempBucket();
  try {
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Release"]);
    const args = ["--bucket", bucket, "--task", task.id];
    runWbJson(["claim", ...args, "--entity", "child", "--dispatcher", "dispatcher"]);
    const before = fs.readFileSync(task.task_path, "utf8");
    const eventsDir = path.join(task.path, "events");
    const events = fs.readdirSync(eventsDir);
    for (const actor of ["owner", "stranger", "dispatcher-fake"]) {
      assert.equal(runWb(["release", ...args, "--entity", actor, "--notes", "Done"]).status, 3);
    }
    for (const flags of [[], ["-m", "Unstructured"], ["--notes", " "], ["--notes", "State", "--pid", "0"]]) {
      assert.equal(runWb(["release", ...args, "--entity", "child", ...flags]).status, 1);
    }
    assert.equal(fs.readFileSync(task.task_path, "utf8"), before);
    assert.deepEqual(fs.readdirSync(eventsDir), events);
    const checkpoint = runWbJson(["checkpoint", ...args, "--entity", "child",
      "--files-touched", "a,b", "--files-touched", "c", "--resources", "helper,tempdir",
      "--pid", String(process.pid), "--host", os.hostname(), "--notes", "Stop helper before resuming"]);
    assert.equal(checkpoint.task_updated, false);
    const manifest = parseFrontmatter(fs.readFileSync(path.join(eventsDir, checkpoint.event), "utf8")).data;
    assert.deepEqual(manifest.files_touched, ["a", "b", "c"]);
    assert.deepEqual(manifest.resources, ["helper", "tempdir"]);
    assert.equal(manifest.pid, process.pid);
    assert.equal(manifest.host, os.hostname());
    assert.equal(manifest.notes, "Stop helper before resuming");
    const rendered = runWbJson(["render", ...args, "--latest-event"]);
    assert.deepEqual(rendered.events[0].resources, manifest.resources);
    assert.equal(rendered.latest_event.notes, manifest.notes);
    assert.match(runWb(["render", ...args, "--latest-event"]).stdout, /Stop helper before resuming/);
    const released = runWbJson(["release", ...args, "--entity", "dispatcher", "--notes", "No live resources"]);
    assert.equal(released.status, "pending");
    assert.equal(released.assignee, "dispatcher");
    assert.equal(released.affinity, "child");
    assert.equal(released.claimed_by, "");
    assert.equal(released.claim_round, 2);
    const state = parseFrontmatter(fs.readFileSync(path.join(eventsDir, released.event), "utf8")).data;
    assert.equal(state.snapshot_version, 1);
    assert.equal(state.notes, "No live resources");
    assert.equal(runWbJson(["entity", "register", "--bucket", bucket, "--entity", "child"]).claimed_task, "");
    runWbJson(["claim", ...args, "--entity", "replacement", "--dispatcher", "dispatcher"]);
    runWbJson(["reset", ...args, "--entity", "owner"]);
    const standalone = runWbJson(["claim", ...args, "--entity", "standalone"]);
    const selfRelease = runWbJson(["release", ...args, "--entity", "standalone", "--notes", "Clean"]);
    assert.equal(selfRelease.assignee, "standalone");
    assert.equal(selfRelease.affinity, "");
    assert.equal(selfRelease.claim_round, standalone.claim_round + 1);
    assert.equal(runWbJson(["fsck", "--bucket", bucket]).unresolved, 0);
  } finally { fs.rmSync(bucket, { recursive: true, force: true }); }
});

test("claim rechecks the recorded dispatcher relationship after settle", async () => {
  const bucket = makeTempBucket();
  let claiming;
  try {
    setBucketConfig(bucket, { claim_settle_ms: 1000 });
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Relationship settle", "--assignee", "dispatcher"]);
    claiming = runWbAsync(["claim", "--bucket", bucket, "--entity", "child", "--dispatcher", "dispatcher", "--task", task.id]);
    const eventsDir = path.join(task.path, "events");
    const deadline = Date.now() + 2000;
    while (!fs.readdirSync(eventsDir).some((name) => name.endsWith("-child-claimed.md"))) {
      assert.ok(Date.now() < deadline, "claim intent did not appear");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const entityPath = path.join(bucket, "entities", "child.md");
    const { data } = parseFrontmatter(fs.readFileSync(entityPath, "utf8"));
    fs.writeFileSync(entityPath, `${serializeFrontmatter({ ...data, dispatcher: "different" })}\n`);
    const result = await claiming;
    assert.equal(result.status, 2, result.stderr);
    assert.equal(runWbJson(["render", "--bucket", bucket, "--task", task.id]).status, "pending");
    assert.equal(fs.readdirSync(eventsDir).some((name) => name.endsWith("-claim-committed.md")), false);
  } finally {
    if (claiming) await claiming;
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("run preserves argv, logs output, checkpoints success/failure and clears runtime without ending the identity", async () => {
  const bucket = makeTempBucket();
  try {
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Run"]);
    const args = ["--bucket", bucket, "--task", task.id, "--entity", "executor"];
    runWbJson(["claim", ...args]);
    const logfile = path.join(bucket, "output.log");
    const code = 'console.log(JSON.stringify(process.argv.slice(1))); console.error("stderr"); process.exit(7)';
    const result = await runWbAsync(["run", ...args, "--log", logfile, "--", process.execPath, "-e", code, "--", "a b", "--json", "*"]);
    assert.equal(result.status, 7, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(fs.readFileSync(logfile, "utf8"), '["a b","--json","*"]\nstderr\n');
    const checkpoints = fs.readdirSync(path.join(task.path, "events")).filter((name) => name.includes("-checkpoint"))
      .map((name) => parseFrontmatter(fs.readFileSync(path.join(task.path, "events", name), "utf8")).data);
    assert.deepEqual(checkpoints.map((event) => event.phase), ["start", "exit"]);
    assert.equal(checkpoints[1].exit_code, 7);
    assert.equal(checkpoints[1].log, logfile);
    assert.equal(checkpoints[1].cmd.at(-2), "--json");
    assert.ok(checkpoints[1].child_pid > 0);
    assert.deepEqual(checkpoints[0].resources, []);
    const entity = runWbJson(["entity", "list", "--bucket", bucket, "--all"]).entities.find((entry) => entry.entity_id === "executor");
    assert.equal(entity.running, null);
    assert.equal(entity.ended_at, "");
    assert.equal(entity.claimed_task, task.id);
    assert.equal((await runWbAsync(["run", ...args, "--", "work-bucket-nonexistent-executable"])).status, 127);
    assert.equal((await runWbAsync(["run", ...args, "--", process.execPath, "-e", "process.exit(0)"])).status, 0);
    assert.equal(runWb(["run", ...args]).status, 1);
    assert.equal(runWb(["run", "--bucket", bucket, "--task", task.id, "--entity", "stranger", "--", process.execPath]).status, 3);
    runWbJson(["review", ...args, "--ac", "1=pass", "--proposed-outcome", "pass"]);
    assert.equal(runWbJson(["fsck", "--bucket", bucket]).unresolved, 0);
  } finally { fs.rmSync(bucket, { recursive: true, force: true }); }
});

test("run heartbeats beyond TTL, exposes canonical status and propagates child signals", async () => {
  const bucket = makeTempBucket();
  try {
    setBucketConfig(bucket, { default_ttl_seconds: 1 });
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Heartbeat"]);
    const args = ["--bucket", bucket, "--task", task.id, "--entity", "executor"];
    runWbJson(["claim", ...args]);
    const running = runWbAsync(["run", ...args, "--", process.execPath, "-e", "setTimeout(() => process.exit(0), 2400)"]);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1400));
      const status = runWbJson(["status", "--bucket", bucket, "--owner", "owner"]);
      assert.equal(status.tasks[0].status, "in-progress");
      assert.equal(status.tasks[0].running.host, os.hostname());
      assert.ok(status.tasks[0].running.pid > 0);
      assert.deepEqual(status.tasks[0].running.cmd.slice(0, 2), [process.execPath, "-e"]);
      assert.ok(status.tasks[0].running.age_seconds >= 1);
      assert.ok(status.tasks[0].heartbeat_age_seconds < 1);
      assert.deepEqual(status.tasks[0].alerts, []);
      assert.deepEqual(status.tasks[0].waiting_on, { role: "executor", entity_id: "executor" });
      const refreshed = runWbJson(["entity", "register", "--bucket", bucket, "--entity", "executor"]);
      assert.equal(refreshed.running.pid, status.tasks[0].running.pid);
      assert.equal(refreshed.claimed_task, task.id);
      const watch = await runWbAsync(["watch", "--bucket", bucket, "--entity", "owner", "--owner-only", "--timeout", "0.4", "--poll-ms", "20"]);
      assert.equal(watch.status, 124, watch.stderr);
    } finally { assert.equal((await running).status, 0); }
    const signal = await runWbAsync(["run", ...args, "--", process.execPath, "-e", 'process.kill(process.pid, "SIGTERM")']);
    assert.equal(signal.status, 143);
    const checks = fs.readdirSync(path.join(task.path, "events")).filter((name) => name.includes("-checkpoint"));
    const last = parseFrontmatter(fs.readFileSync(path.join(task.path, "events", checks.at(-1)), "utf8")).data;
    assert.equal(last.signal, "SIGTERM");
    assert.equal(last.exit_code, 143);
  } finally { fs.rmSync(bucket, { recursive: true, force: true }); }
});

test("run forwards wrapper termination, refuses overlapping wrappers and cleans up its child", async () => {
  const bucket = makeTempBucket();
  let wrapper;
  let finished;
  try {
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Signal"]);
    const args = ["--bucket", bucket, "--task", task.id, "--entity", "executor"];
    runWbJson(["claim", ...args]);
    wrapper = spawn(process.execPath, [WB_PATH, "run", ...args, "--", process.execPath, "-e",
      'console.log(process.pid); setInterval(() => {}, 1000)'], { stdio: ["ignore", "pipe", "pipe"] });
    finished = new Promise((resolve) => wrapper.once("close", resolve));
    const childPid = Number(await new Promise((resolve) => wrapper.stdout.once("data", (data) => resolve(String(data).trim()))));
    assert.equal(runWb(["run", ...args, "--", process.execPath, "-e", "process.exit(99)"]).status, 3);
    wrapper.kill("SIGTERM");
    assert.equal(await finished, 143);
    assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
    const entity = parseFrontmatter(fs.readFileSync(path.join(bucket, "entities", "executor.md"), "utf8")).data;
    assert.equal(entity.running, "");
  } finally {
    wrapper?.kill("SIGTERM");
    if (finished) await finished;
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("a crashed run wrapper becomes abandoned immediately and preserves its start checkpoint", async () => {
  const bucket = makeTempBucket();
  try {
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Crash"]);
    const args = ["--bucket", bucket, "--task", task.id, "--entity", "executor"];
    runWbJson(["claim", ...args]);
    const result = await runWbAsync(["run", ...args, "--", process.execPath, "-e",
      'process.kill(process.ppid, "SIGKILL"); process.exit(0)']);
    assert.equal(result.status, null);
    const status = runWbJson(["status", "--bucket", bucket]);
    assert.equal(status.tasks[0].alerts[0].type, "abandoned");
    assert.equal(status.tasks[0].alerts[0].reason, "wrapper_pid_gone");
    assert.equal(status.tasks[0].status, "in-progress");
    const checkpoint = runWbJson(["render", "--bucket", bucket, "--task", task.id, "--latest-event"]).events[0];
    assert.equal(checkpoint.phase, "start");
    assert.ok(status.tasks[0].running.child_pid > 0);
    assert.deepEqual(checkpoint.resources, []);
    const wake = runWbJson(["watch", "--bucket", bucket, "--entity", "owner", "--owner-only"]);
    assert.equal(wake.reason, "abandoned");
    runWbJson(["reset", "--bucket", bucket, "--task", task.id, "--entity", "owner"]);
    runWbJson(["claim", ...args]);
    assert.deepEqual(runWbJson(["status", "--bucket", bucket]).tasks[0].alerts, []);
  } finally { fs.rmSync(bucket, { recursive: true, force: true }); }
});

test("owner advisories escalate stale to abandoned once per level without task mutation", async () => {
  const bucket = makeTempBucket();
  try {
    setBucketConfig(bucket, { default_ttl_seconds: 1 });
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Escalate"]);
    runWbJson(["claim", "--bucket", bucket, "--task", task.id, "--entity", "executor"]);
    const entityPath = path.join(bucket, "entities", "executor.md");
    const { data } = parseFrontmatter(fs.readFileSync(entityPath, "utf8"));
    data.updated_at = new Date(Date.now() - 1500).toISOString();
    fs.writeFileSync(entityPath, `${serializeFrontmatter(data)}\n`);
    const before = fs.readFileSync(task.task_path, "utf8");
    const args = ["watch", "--bucket", bucket, "--entity", "owner", "--owner-only", "--poll-ms", "20", "--json"];
    const stale = JSON.parse(runWb(args).stdout);
    assert.equal(stale.reason, "stale");
    assert.equal(stale.stale_tasks.length, 1);
    const escalation = await runWbAsync([...args, "--timeout", "3"]);
    assert.equal(escalation.status, 0, escalation.stderr);
    assert.equal(JSON.parse(escalation.stdout).reason, "abandoned");
    assert.equal(runWb([...args, "--timeout", "0.1"]).status, 124);
    assert.equal(fs.readFileSync(task.task_path, "utf8"), before);
    const status = runWbJson(["status", "--bucket", bucket]);
    assert.equal(status.tasks[0].alerts[0].type, "abandoned");
    const ownerPath = path.join(bucket, "entities", "owner.md");
    assert.equal(parseFrontmatter(fs.readFileSync(ownerPath, "utf8")).data.stale_task_seen.length, 1);
    runWbJson(["cancel", "--bucket", bucket, "--task", task.id, "--entity", "owner"]);
    assert.deepEqual(parseFrontmatter(fs.readFileSync(ownerPath, "utf8")).data.stale_task_seen, []);
  } finally { fs.rmSync(bucket, { recursive: true, force: true }); }
});

test("pool and registered task watches heartbeat at TTL/4 without dropping runtime or relationships", async () => {
  const bucket = makeTempBucket();
  let runningWatch;
  try {
    setBucketConfig(bucket, { default_ttl_seconds: 1 });
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Task watch"]);
    runWbJson(["claim", "--bucket", bucket, "--entity", "executor", "--dispatcher", "dispatcher", "--task", task.id]);
    runningWatch = runWbAsync(["watch", "--bucket", bucket, "--entity", "executor", "--task", task.id, "--timeout", "2"]);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1300));
      const status = runWbJson(["status", "--bucket", bucket]).tasks[0];
      assert.deepEqual(status.alerts, []);
      assert.ok(status.heartbeat_age_seconds < 1);
      const entity = parseFrontmatter(fs.readFileSync(path.join(bucket, "entities", "executor.md"), "utf8")).data;
      assert.equal(entity.dispatcher, "dispatcher");
      assert.equal(entity.claimed_task, task.id);
    } finally { assert.equal((await runningWatch).status, 124); }
    const entityPath = path.join(bucket, "entities", "dispatcher.md");
    const registered = runWbJson(["entity", "register", "--bucket", bucket, "--entity", "dispatcher", "--ttl", "1"]);
    fs.writeFileSync(entityPath, `${serializeFrontmatter({
      ...registered, running: { pid: process.pid, host: os.hostname(), cmd: ["fixture"], started_at: new Date().toISOString() },
    })}\n`);
    runningWatch = runWbAsync(["watch", "--bucket", bucket, "--entity", "dispatcher", "--timeout", "2"]);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1300));
      const entity = parseFrontmatter(fs.readFileSync(entityPath, "utf8")).data;
      assert.ok(Date.now() - Date.parse(entity.updated_at) < 1000);
      assert.equal(entity.running.pid, process.pid);
      assert.equal(entity.ttl_seconds, 1);
    } finally { assert.equal((await runningWatch).status, 124); }
  } finally {
    if (runningWatch) await runningWatch;
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("liveness covers missing, ended, same-host dead pid and remote pid fallback with per-task TTL", () => {
  const bucket = makeTempBucket();
  try {
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Liveness", "--ttl-seconds", "20"]);
    const args = ["--bucket", bucket, "--task", task.id];
    runWbJson(["claim", ...args, "--entity", "executor"]);
    const entityPath = path.join(bucket, "entities", "executor.md");
    const { data } = parseFrontmatter(fs.readFileSync(entityPath, "utf8"));
    const alert = (updates) => {
      fs.writeFileSync(entityPath, `${serializeFrontmatter({ ...data, ...updates })}\n`);
      return runWbJson(["status", "--bucket", bucket]).tasks[0].alerts;
    };
    assert.deepEqual(alert({ updated_at: new Date(Date.now() - 10_000).toISOString(), ttl_seconds: 1 }), []);
    assert.equal(alert({ updated_at: new Date(Date.now() - 21_000).toISOString() })[0].type, "stale");
    assert.equal(alert({ updated_at: new Date(Date.now() - 61_000).toISOString() })[0].type, "abandoned");
    assert.equal(alert({ ended_at: new Date().toISOString() })[0].reason, "entity_ended");
    // A reaped local fixture PID is known dead without probing unrelated processes.
    const fixture = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.equal(alert({ running: { pid: fixture.pid, host: os.hostname() } })[0].reason, "wrapper_pid_gone");
    assert.deepEqual(alert({ running: { pid: fixture.pid, host: "remote-fixture" } }), []);
    assert.deepEqual(alert({ running: { pid: process.pid, host: os.hostname() } }), []);
    const saved = fs.readFileSync(entityPath, "utf8");
    fs.unlinkSync(entityPath);
    const { data: taskData, body } = parseFrontmatter(fs.readFileSync(task.task_path, "utf8"));
    taskData.updated_at = new Date(Date.now() - 21_000).toISOString();
    fs.writeFileSync(task.task_path, `${serializeFrontmatter(taskData)}\n${body}`);
    const missing = runWbJson(["status", "--bucket", bucket]).tasks[0].alerts[0];
    assert.equal(missing.type, "stale");
    assert.equal(missing.heartbeat.missing, true);
    fs.writeFileSync(entityPath, saved);
    runWbJson(["reset", ...args, "--entity", "owner"]);
    const amended = runWbJson(["amend", ...args, "--entity", "owner", "--ttl-seconds", "40"]);
    assert.equal(parseFrontmatter(fs.readFileSync(amended.task_path, "utf8")).data.ttl_seconds, 40);
    for (const ttl of ["0", "-1", "1.5", "bad"]) {
      assert.equal(runWb(["create", "--bucket", bucket, "--entity", "owner", "--title", "Bad TTL", "--ttl-seconds", ttl]).status, 1);
      assert.equal(runWb(["amend", ...args, "--entity", "owner", "--ttl-seconds", ttl]).status, 1);
    }
  } finally { fs.rmSync(bucket, { recursive: true, force: true }); }
});

test("pending alerts use pending residence, dependency eligibility, pin health, exclusions and pause", async () => {
  const bucket = makeTempBucket();
  try {
    setBucketConfig(bucket, { pinned_idle_seconds: 1, unclaimed_seconds: 1 });
    const pin = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Missing pin", "--assignee", "dispatcher"]);
    const open = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Unclaimed"]);
    const dep = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Dependency", "--draft"]);
    const blocked = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Dependency wait", "--depends-on", dep.id]);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    runWbJson(["amend", "--bucket", bucket, "--task", open.id, "--entity", "owner", "--ttl-seconds", "60"]);
    const status = runWbJson(["status", "--bucket", bucket]);
    assert.equal(status.tasks.find((task) => task.id === open.id).alerts[0].type, "unclaimed");
    assert.equal(status.tasks.find((task) => task.id === pin.id).alerts[0].type, "pinned_idle");
    assert.deepEqual(status.tasks.find((task) => task.id === blocked.id).alerts, []);
    const args = ["watch", "--bucket", bucket, "--entity", "owner", "--owner-only", "--json"];
    const wake = JSON.parse(runWb(args).stdout);
    assert.equal(wake.unclaimed_tasks[0].id, open.id);
    assert.equal(wake.pinned_idle_tasks[0].id, pin.id);
    assert.equal(runWb([...args, "--timeout", "0.1"]).status, 124);
    const late = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Later"]);
    const timed = await runWbAsync([...args, "--timeout", "3", "--poll-ms", "20"]);
    assert.equal(timed.status, 0, timed.stderr);
    assert.equal(JSON.parse(timed.stdout).unclaimed_tasks[0].id, late.id);
    runWbJson(["entity", "register", "--bucket", bucket, "--entity", "dispatcher"]);
    assert.deepEqual(runWbJson(["status", "--bucket", bucket]).tasks.find((task) => task.id === pin.id).alerts, []);
    const dispatcherPath = path.join(bucket, "entities", "dispatcher.md");
    const { data } = parseFrontmatter(fs.readFileSync(dispatcherPath, "utf8"));
    fs.writeFileSync(dispatcherPath, `${serializeFrontmatter({ ...data, updated_at: new Date(Date.now() - 601_000).toISOString() })}\n`);
    assert.equal(runWbJson(["status", "--bucket", bucket]).tasks.find((task) => task.id === pin.id).alerts[0].type, "pinned_idle");
    const fresh = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Paused"]);
    runWbJson(["bucket", "pause", "--bucket", bucket]);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.deepEqual(runWbJson(["status", "--bucket", bucket]).tasks.find((task) => task.id === fresh.id).alerts, []);
    assert.equal(runWb([...args, "--exclude-task", `${pin.id},${open.id},${late.id}`, "--timeout", "0.1"]).status, 124);
  } finally { fs.rmSync(bucket, { recursive: true, force: true }); }
});

test("status is read-only, normalized, owner-filtered and warns about local sync artifacts", () => {
  const bucket = makeTempBucket();
  const absent = path.join(bucket, "absent");
  try {
    assert.deepEqual(runWbJson(["status", "--bucket", absent]).tasks, []);
    assert.equal(fs.existsSync(absent), false);
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Visible"]);
    runWbJson(["create", "--bucket", bucket, "--entity", "other", "--title", "Other"]);
    const done = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Done"]);
    runWbJson(["complete", "--bucket", bucket, "--entity", "owner", "--task", done.id]);
    fs.writeFileSync(path.join(bucket, "messages", "notice.sync-conflict-fixture.md"), "conflict");
    const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(path.join(dir, entry.name)) : [[path.join(dir, entry.name), fs.readFileSync(path.join(dir, entry.name), "utf8")]]);
    const before = files(bucket);
    const status = runWbJson(["status", "--bucket", bucket, "--owner", "owner"]);
    assert.equal(status.count, 1);
    for (const [key, value] of Object.entries(task)) {
      if (key !== "created_event") assert.deepEqual(status.tasks[0][key], value, key);
    }
    assert.deepEqual(status.tasks[0].waiting_on, { role: "executor", entity_id: "" });
    assert.equal(status.warnings.length, 1);
    assert.equal(status.sync_conflicts.length, 1);
    assert.match(runWb(["status", "--bucket", bucket]).stdout, /waiting_on=executor:pool/);
    assert.deepEqual(files(bucket), before);
    const args = ["--bucket", bucket, "--task", task.id, "--entity", "executor"];
    runWbJson(["claim", ...args]);
    runWbJson(["question", ...args]);
    assert.deepEqual(runWbJson(["status", "--bucket", bucket, "--owner", "owner"]).tasks[0].waiting_on,
      { role: "owner", entity_id: "owner" });
  } finally { fs.rmSync(bucket, { recursive: true, force: true }); }
});

test("transition authority covers every intent, lifecycle state and participant role", () => {
  const bucket = makeTempBucket();
  const states = ["draft", "ready", "pending", "in-progress", "blocked", "review", "complete", "cancelled"];
  const active = ["in-progress", "blocked", "review"];
  const nonterminal = states.slice(0, 6);
  const rules = {
    promote: { from: ["draft", "ready"], actor: "owner", to: "pending" },
    demote: { from: ["ready", "pending"], actor: "owner", to: "draft", flags: ["--status", "draft"] },
    claim: { from: ["pending"], actor: "eligible", to: "in-progress" },
    amend: { from: nonterminal, actor: "owner" },
    review: { from: ["in-progress"], actor: "executor", to: "review", flags: ["--ac", "1=pass", "--proposed-outcome", "pass"] },
    question: { from: ["in-progress"], actor: "executor", to: "blocked" },
    feedback: { from: ["review"], actor: "owner", to: "pending" },
    answer: { from: ["blocked"], actor: "owner", to: "pending" },
    reset: { from: ["in-progress"], actor: "owner", to: "pending" },
    release: { from: ["in-progress"], actor: "execution", to: "pending", flags: ["--notes", "Safe to resume"] },
    checkpoint: { from: nonterminal, actor: "participant", flags: ["--notes", "State inspected"] },
    complete: { from: nonterminal, actor: "owner", to: "complete" },
    cancel: { from: nonterminal, actor: "owner", to: "cancelled" },
    log: { from: nonterminal, actor: "participant" },
    note: { from: nonterminal, actor: "participant" },
    "accept-amends": { from: ["in-progress"], actor: "executor" },
    "ack-instructions": { from: ["in-progress"], actor: "executor" },
  };
  try {
    assert.deepEqual(Object.keys(TRANSITIONS).sort(), ["create", ...Object.keys(rules)].sort());
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Authority matrix"]);
    runWbJson(["claim", "--bucket", bucket, "--entity", "executor", "--task", created.id]);
    const { data, body } = parseFrontmatter(fs.readFileSync(created.task_path, "utf8"));
    const eventsDir = path.join(created.path, "events");
    fs.writeFileSync(path.join(bucket, "entities", "executor.md"),
      `${serializeFrontmatter({ entity_id: "executor", dispatcher: "dispatcher" })}\n`);
    for (const [intent, rule] of Object.entries(rules)) {
      for (const state of states) {
        for (const actor of ["owner", "executor", "dispatcher", "stranger"]) {
          const claimed = active.includes(state);
          const before = `${serializeFrontmatter({
            ...data, status: state, claimed_by: claimed ? "executor" : "",
          })}\n${body}`;
          fs.writeFileSync(created.task_path, before);
          fs.rmSync(eventsDir, { recursive: true });
          fs.mkdirSync(eventsDir);
          if (intent === "accept-amends") writeUniqueEvent(eventsDir, "owner", "amend", "Correction", new Date("2000-01-01T00:00:00Z"));
          const beforeEvents = fs.readdirSync(eventsDir);
          const command = intent === "note" ? ["post", "--type", "note"] : [intent];
          const result = runWb([...command, "--bucket", bucket, "--task", created.id,
            "--entity", actor, ...(rule.flags || []), "--json"]);
          const permitted = rule.actor === "eligible" || actor === rule.actor ||
            (rule.actor === "execution" && claimed && ["executor", "dispatcher"].includes(actor)) ||
            (rule.actor === "participant" && (actor === "owner" || (claimed && ["executor", "dispatcher"].includes(actor))));
          const allowed = rule.from.includes(state) && permitted;
          const label = `${intent}/${state}/${actor}: ${result.stderr}`;
          assert.equal(result.status, allowed ? 0 : !rule.from.includes(state) ? (intent === "claim" ? 2 : 1) : 3, label);
          if (!allowed) {
            assert.equal(fs.readFileSync(created.task_path, "utf8"), before, label);
            assert.deepEqual(fs.readdirSync(eventsDir), beforeEvents, label);
          } else {
            const output = JSON.parse(result.stdout);
            assert.equal(output.status, rule.to || state, label);
            assert.equal(output.owner, "owner", label);
            if (["complete", "cancel", "reset", "feedback", "answer", "release"].includes(intent)) {
              assert.equal(output.claimed_by, "", label);
            }
            if (["log", "note", "amend", "checkpoint"].includes(intent)) {
              assert.equal(output.task_updated, false, label);
              assert.equal(fs.readFileSync(created.task_path, "utf8"), before, label);
            }
          }
        }
      }
    }
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("self-owned executors can close, cancel and recover their own work", () => {
  const bucket = makeTempBucket();
  try {
    for (const command of ["complete", "cancel", "reset"]) {
      const task = runWbJson(["create", "--bucket", bucket, "--entity", "executor", "--title", command]);
      const args = ["--bucket", bucket, "--entity", "executor", "--task", task.id];
      runWbJson(["claim", ...args]);
      const result = runWbJson([command, ...args]);
      assert.equal(result.status, command === "complete" ? "complete" : command === "cancel" ? "cancelled" : "pending");
      assert.equal(result.claimed_by, "");
      assert.equal(result.owner, "executor");
    }
    assert.equal(runWbJson(["fsck", "--bucket", bucket]).unresolved, 0);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("post cannot forge lifecycle events or mutate the brief, claim or metadata", () => {
  const bucket = makeTempBucket();
  try {
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "No generic mutation"]);
    const args = ["--bucket", bucket, "--entity", "owner", "--task", task.id];
    const before = fs.readFileSync(task.task_path, "utf8");
    const beforeEvents = fs.readdirSync(path.join(task.path, "events"));
    for (const type of ["created", "claimed", "claim-committed", "review", "question", "complete",
      "cancelled", "reset", "amend", "promote", "demote", "feedback", "answer", "unknown"]) {
      assert.equal(runWb(["post", ...args, "--type", type]).status, 1, type);
    }
    for (const flags of [
      ["--status", "complete"], ["--assignee", "executor"], ["--claimed-by", "executor"],
      ["--bump-revision"], ["--check-ac"], ["--reopen"], ["--accept-amends"],
      ["--add-depends-on", "dependency"], ["--remove-depends-on", "dependency"],
    ]) {
      assert.equal(runWb(["post", ...args, "--type", "log", ...flags]).status, 1, flags.join(" "));
      assert.equal(runWb(["log", ...args, ...flags]).status, 1, flags.join(" "));
    }
    assert.equal(fs.readFileSync(task.task_path, "utf8"), before);
    assert.deepEqual(fs.readdirSync(path.join(task.path, "events")), beforeEvents);
    for (const flags of [[], ["--type", "log"], ["--type", "note"]]) {
      const posted = runWbJson(["post", ...args, ...flags, "-m", "Observation"]);
      assert.equal(posted.task_updated, false);
      assert.equal(fs.readFileSync(task.task_path, "utf8"), before);
    }
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("promote/demote targets and metadata amendments have no state or authority bypass", () => {
  const bucket = makeTempBucket();
  try {
    for (const state of ["draft", "ready", "pending"]) {
      const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", state, "--status", state]);
      const args = ["--bucket", bucket, "--entity", "owner", "--task", task.id];
      for (const command of ["promote", "demote"]) {
        for (const target of ["in-progress", "review", "blocked", "complete", "cancelled", "unknown", state]) {
          assert.equal(runWb([command, ...args, "--status", target]).status, 1, `${command}/${state}/${target}`);
        }
      }
      const amended = runWbJson(["amend", ...args, "--assignee", "executor", "--add-depends-on", "one,two", "--add-depends-on", "three"]);
      assert.deepEqual(amended.depends_on, ["one", "two", "three"]);
      assert.equal(amended.assignee, "executor");
      assert.equal(amended.revision, 2);
      const removed = runWbJson(["amend", ...args, "--assignee", "", "--remove-depends-on", "one,two"]);
      assert.deepEqual(removed.depends_on, ["three"]);
      assert.equal(removed.assignee, "");
      assert.equal(removed.revision, 3);
    }
    for (const state of ["in-progress", "review", "blocked", "complete", "cancelled"]) {
      const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", state]);
      const args = ["--bucket", bucket, "--task", task.id];
      const executor = `executor-${state}`;
      runWbJson(["claim", ...args, "--entity", executor]);
      if (state === "review" || state === "blocked") {
        if (state === "review") runWbJson(["review", ...args, "--entity", executor, "--ac", "1=pass", "--proposed-outcome", "pass"]);
        else runWbJson(["question", ...args, "--entity", executor]);
      } else if (state === "complete" || state === "cancelled") {
        runWbJson([state === "complete" ? "complete" : "cancel", ...args, "--entity", "owner"]);
      }
      const before = fs.readFileSync(task.task_path, "utf8");
      for (const flags of [["--assignee", ""], ["--add-depends-on", "one"], ["--remove-depends-on", "one"]]) {
        assert.equal(runWb(["amend", ...args, "--entity", "owner", ...flags]).status, 1);
      }
      assert.equal(fs.readFileSync(task.task_path, "utf8"), before);
    }
    for (const state of ["in-progress", "review", "complete", "cancelled"]) {
      assert.equal(runWb(["create", "--bucket", bucket, "--entity", "owner", "--title", "Invalid", "--status", state]).status, 1);
    }
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("every command's unknown flags are clean one-line usage errors, and help matches its option table", () => {
  for (const [name, definition] of Object.entries(COMMANDS)) {
    const args = name.split(" ");
    for (const invalid of [["--unknown-option"], ["unexpected-positional"]]) {
      const result = runWb([...args, ...invalid]);
      assert.equal(result.status, 1, name);
      assert.equal(result.stdout, "", name);
      assert.equal(result.stderr.trim().split("\n").length, 1, result.stderr);
      assert.ok(result.stderr.includes(`Run "wb.mjs ${name} --help".`), result.stderr);
      assert.doesNotMatch(result.stderr, /\bat .+:\d|ERR_PARSE_ARGS|node:internal/);
    }
    const help = runWb([...args, "--help"]);
    assert.equal(help.status, 0, name);
    assert.equal(help.stderr, "", name);
    const documented = [...help.stdout.matchAll(/^\s+(?:-\w, )?--([\w-]+)/gm)].map((match) => match[1]).sort();
    assert.deepEqual(documented, [...Object.keys(definition.options), "json", "help"].sort(), name);
    assert.match(help.stdout, /Exit codes: 0 ok; 1 usage\/validation\/not-found; 2 no work\/not eligible; 3 conflict\/race\/permission; 4 paused; 124 timeout; 130 signal\./);
    assert.match(help.stdout, new RegExp(`Example: wb\\.mjs ${name} `));
    assert.ok(definition.example.length, name);
    assert.doesNotThrow(() => parseCommand(name, definition.example));
  }
  for (const name of ["bucket", "entity", "tag", "msg"]) {
    assert.equal(runWb([name, "unknown"]).status, 1);
    assert.equal(runWb([name, "--help"]).status, 0);
  }
  assert.equal(runWb(["unknown"]).status, 1);
});

test("help examples execute using their documented flags in appropriate task states", () => {
  for (const [name, definition] of Object.entries(COMMANDS)) {
    const bucket = makeTempBucket();
    try {
      const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Example fixture",
        ...(name === "promote" ? ["--draft"] : [])]);
      const args = ["--bucket", bucket, "--task", task.id];
      if (["review", "question", "feedback", "answer", "reset", "release", "checkpoint", "run", "accept-amends", "ack-instructions"].includes(name)) {
        runWbJson(["claim", ...args, "--entity", "executor"]);
      }
      if (name === "feedback") runWbJson(["review", ...args, "--entity", "executor", "--ac", "1=pass", "--proposed-outcome", "pass"]);
      if (name === "answer") runWbJson(["question", ...args, "--entity", "executor"]);
      if (name === "accept-amends") runWbJson(["amend", ...args, "--entity", "owner", "-m", "Correction"]);
      if (name === "entity end") runWbJson(["entity", "register", "--bucket", bucket, "--entity", "executor"]);
      const example = definition.example.map((arg) => arg === "<bucket>" ? bucket : arg === "<task>" ? task.id : arg);
      const result = runWb([...name.split(" "), ...example]);
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    } finally {
      fs.rmSync(bucket, { recursive: true, force: true });
    }
  }
});

test("every body-writing command shares literal message/file/stdin flags and rejects aliases or combined sources", () => {
  const bucket = makeTempBucket();
  const body = "Literal `$(no-substitution)`\nsecond line";
  const bodyPath = path.join(bucket, "body.md");
  fs.writeFileSync(bodyPath, body);
  try {
    for (const [name, definition] of Object.entries(COMMANDS).filter(([, command]) => command.options.message)) {
      const args = definition.example.map((arg) => arg === "<bucket>" ? bucket : arg);
      for (const spelling of ["-m", "--message", "--body-file", "--stdin"]) {
        const { values } = parseCommand(name, [spelling, ...(spelling === "--stdin" ? [] : [spelling === "--body-file" ? bodyPath : body])]);
        assert.equal(values[spelling === "-m" ? "message" : spelling.slice(2)], spelling === "--stdin" ? true : spelling === "--body-file" ? bodyPath : body, name);
      }
      for (const flags of [
        ["--body", body], ["-m", body, "--stdin"], ["--body-file", bodyPath, "--stdin"],
        ["-m", body, "--body-file", bodyPath],
      ]) {
        const result = runWb([...name.split(" "), ...args.filter((arg, index) => args[index - 1] !== "-m" && arg !== "-m"), ...flags], { input: body });
        assert.equal(result.status, 1, `${name}: ${flags}`);
        assert.equal(result.stderr.trim().split("\n").length, 1);
      }
    }
    for (const [index, flags] of [["-m", body], ["--message", body], ["--body-file", bodyPath], ["--stdin"]].entries()) {
      const created = runWb(["create", "--bucket", bucket, "--entity", "owner", "--title", `Body ${index}`, ...flags, "--json"], { input: body });
      assert.equal(created.status, 0, created.stderr);
      const task = JSON.parse(created.stdout);
      assert.equal(runWbJson(["render", "--bucket", bucket, "--task", task.id]).body, body);
      for (const [name, extra] of [["log", ["--task", task.id]], ["msg send", []], ["tag set", ["--tag", "linux"]], ["entity register", []]]) {
        const written = runWb([...name.split(" "), "--bucket", bucket, "--entity", "owner", ...extra, ...flags, "--json"], { input: body });
        assert.equal(written.status, 0, written.stderr);
        if (name === "log") assert.equal(runWbJson(["render", "--bucket", bucket, "--task", task.id, "--latest-event"]).events[0].body, body);
        else assert.ok(fs.readFileSync(JSON.parse(written.stdout).path, "utf8").includes(body), name);
      }
      const paused = runWb(["bucket", "pause", "--bucket", bucket, ...flags, "--json"], { input: body });
      assert.equal(paused.status, 0, paused.stderr);
      assert.equal(fs.readFileSync(JSON.parse(paused.stdout).path, "utf8"), `${body}\n`);
    }
    for (const [name, definition] of Object.entries(COMMANDS).filter(([, command]) => command.options.tag)) {
      assert.equal(definition.options.tag.multiple, true, name);
      assert.equal(runWb([...name.split(" "), "--tags", "linux"]).status, 1, name);
    }
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("TaskSummary fields match exactly across create/list/watch/claim/transition/render, including legacy defaults", () => {
  const bucket = makeTempBucket();
  const fields = [
    "id", "title", "stage", "status", "priority", "tags", "owner", "assignee", "affinity", "claimed_by",
    "parent", "depends_on", "revision", "claim_round", "outcome", "last_amend_seen", "instructions_seen",
    "ttl_seconds", "state_seq", "updated_by", "updated_at", "path", "task_path", "latest_event",
  ].sort();
  const pick = (summary) => {
    for (const field of fields) assert.ok(Object.hasOwn(summary, field), field);
    assert.equal(Object.hasOwn(summary, "task"), false);
    assert.equal(Object.hasOwn(summary, "task_id"), false);
    return Object.fromEntries(fields.map((field) => [field, summary[field]]));
  };
  try {
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Schema"]);
    const args = ["--bucket", bucket, "--task", created.id];
    const listed = () => runWbJson(["list", "--bucket", bucket]).tasks[0];
    assert.deepEqual(Object.keys(listed()).sort(), fields);
    assert.deepEqual(pick(created), pick(listed()));
    assert.deepEqual(runWbJson(["watch", "--bucket", bucket, "--entity", "executor"]).tasks[0], listed());
    const claimed = runWbJson(["claim", ...args, "--entity", "executor"]);
    assert.deepEqual(pick(claimed), listed());
    assert.deepEqual(pick(runWbJson(["render", ...args])), listed());
    const reviewed = runWbJson(["review", ...args, "--entity", "executor", "--ac", "1=pass", "--proposed-outcome", "pass"]);
    assert.deepEqual(pick(reviewed), listed());
    assert.deepEqual(runWbJson(["watch", "--bucket", bucket, "--entity", "owner", "--owner-only"]).owner_tasks[0], listed());
    assert.deepEqual(pick(runWbJson(["watch", ...args, "--after-event", claimed.last_event_seen])), listed());
    const legacyDir = path.join(bucket, "tasks", "minimal");
    fs.mkdirSync(legacyDir);
    fs.writeFileSync(path.join(legacyDir, "task.md"), "---\nstatus: draft\n---\nBrief\n");
    const legacy = runWbJson(["list", "--bucket", bucket, "--status", "draft"]).tasks[0];
    assert.deepEqual(Object.keys(legacy).sort(), fields);
    assert.equal(legacy.latest_event, null);
    assert.equal(legacy.affinity, "");
    assert.equal(legacy.outcome, "");
    assert.equal(legacy.state_seq, 0);
    assert.deepEqual(pick(runWbJson(["render", "--bucket", bucket, "--task", "minimal"])), legacy);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("list combines assignee/claimant filters with existing filters, including empty values", () => {
  const bucket = makeTempBucket();
  try {
    const first = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Assigned", "--tag", "LINUX,gpu", "--tag", "linux", "--assignee", "executor"]);
    const second = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Unassigned", "--tag", "gpu"]);
    const args = ["list", "--bucket", bucket];
    assert.deepEqual(first.tags, ["linux", "gpu"]);
    assert.deepEqual(runWbJson([...args, "--assignee", "executor", "--claimed-by", ""]).tasks.map((task) => task.id), [first.id]);
    runWbJson(["claim", "--bucket", bucket, "--entity", "executor", "--task", first.id]);
    assert.equal(runWbJson([...args, "--claimed-by", ""]).count, 1);
    assert.equal(runWbJson([...args, "--assignee", ""]).tasks[0].id, second.id);
    const filtered = runWbJson([...args, "--assignee", "executor", "--claimed-by", "executor", "--owner", "owner", "--tag", "linux", "--status", "pending,in-progress"]);
    assert.equal(filtered.count, 1);
    assert.equal(filtered.tasks[0].id, first.id);
    assert.equal(runWbJson([...args, "--claimed-by", "other"]).count, 0);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("validation/not-found/no-work/permission/paused/timeout exit codes are consistent", () => {
  const bucket = makeTempBucket();
  try {
    for (const command of ["claim", "render", "watch", "review", "complete", "cancel", "reset", "amend"]) {
      const result = runWb([command, "--bucket", bucket, "--entity", "executor", "--task", "missing"]);
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stderr.trim().split("\n").length, 1);
    }
    assert.equal(runWb(["claim", "--bucket", bucket, "--entity", "executor"]).status, 2);
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Codes", "--draft"]);
    const args = ["--bucket", bucket, "--task", task.id];
    assert.equal(runWb(["claim", ...args, "--entity", "executor"]).status, 2);
    assert.equal(runWb(["complete", ...args, "--entity", "executor"]).status, 3);
    runWbJson(["bucket", "pause", "--bucket", bucket]);
    assert.equal(runWb(["claim", ...args, "--entity", "executor"]).status, 4);
    assert.equal(runWb(["watch", "--bucket", bucket, "--entity", "owner", "--owner-only", "--timeout", "0.05"]).status, 124);
    for (const flags of [["--poll-ms", "0"], ["--poll-ms", "1ms"], ["--timeout", "-1"], ["--timeout", "never"]]) {
      assert.equal(runWb(["watch", "--bucket", bucket, "--entity", "owner", ...flags]).status, 1);
    }
    for (const ttl of ["0", "-1", "1.5", "10s"]) {
      assert.equal(runWb(["entity", "register", "--bucket", bucket, "--entity", "executor", "--ttl", ttl]).status, 1);
    }
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("watch handles SIGINT and SIGTERM as exit 130 and closes its watchers", async () => {
  const bucket = makeTempBucket();
  try {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const child = spawn(process.execPath, [WB_PATH, "watch", "--bucket", bucket, "--entity", signal, "--owner-only"]);
      const closed = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, receivedSignal) => resolve({ code, receivedSignal }));
      });
      try {
        const entityPath = path.join(bucket, "entities", `${signal}.md`);
        const deadline = Date.now() + 2000;
        while (!fs.existsSync(entityPath) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(fs.existsSync(entityPath));
        await new Promise((resolve) => setTimeout(resolve, 50));
        child.kill(signal);
        const result = await closed;
        assert.deepEqual(result, { code: 130, receivedSignal: null });
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
        await closed;
      }
    }
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("all list-valued options accept repeated comma-separated values", () => {
  const bucket = makeTempBucket();
  try {
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Lists",
      "--tag", "linux,gpu", "--tag", "macos", "--depends-on", "one,two", "--depends-on", "three",
      "--files", "one.rs,two.rs", "--files", "three.rs", "--ac", "First,Second", "--ac", "Third"]);
    assert.deepEqual(task.tags, ["linux", "gpu", "macos"]);
    assert.deepEqual(task.depends_on, ["one", "two", "three"]);
    const rendered = runWbJson(["render", "--bucket", bucket, "--task", task.id]);
    assert.match(rendered.body, /`one.rs`, `two.rs`, `three.rs`/);
    assert.match(rendered.body, /- \[ \] #1 First\n- \[ \] #2 Second\n- \[ \] #3 Third/);
    const notice = runWbJson(["msg", "send", "--bucket", bucket, "--entity", "owner",
      "--to", "one,two", "--to", "three", "--tag", "linux,gpu", "-m", "Notice"]);
    assert.deepEqual(notice.to, ["one", "two", "three"]);
    assert.deepEqual(notice.tags, ["linux", "gpu"]);
    const entity = runWbJson(["entity", "register", "--bucket", bucket, "--entity", "executor",
      "--tag", "linux,gpu", "--tag", "macos"]);
    assert.deepEqual(entity.tags, task.tags);
    assert.equal(runWb(["tag", "set", "--bucket", bucket, "--entity", "owner", "--tag", "linux,gpu"]).status, 1);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("claim revalidates routing, dependencies and lifecycle after settling", async () => {
  const bucket = makeTempBucket();
  let claiming;
  try {
    setBucketConfig(bucket, { claim_settle_ms: 500 });
    for (const mutation of [["amend", "--assignee", "other"], ["amend", "--add-depends-on", "missing"], ["demote"]]) {
      const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", mutation.join(" ")]);
      const args = ["--bucket", bucket, "--task", task.id];
      const eventsDir = path.join(task.path, "events");
      claiming = runWbAsync(["claim", ...args, "--entity", "executor", "--json"]);
      const deadline = Date.now() + 2000;
      while (!fs.readdirSync(eventsDir).some((file) => file.endsWith("-claimed.md")) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(fs.readdirSync(eventsDir).some((file) => file.endsWith("-claimed.md")));
      const [command, ...flags] = mutation;
      const changed = runWbJson([command, ...args, "--entity", "owner", ...flags]);
      const result = await claiming;
      assert.equal(result.status, command === "demote" ? 3 : 2, result.stderr);
      const rendered = runWbJson(["render", ...args]);
      assert.equal(rendered.claimed_by, "");
      assert.equal(rendered.status, changed.status);
      assert.equal(rendered.state_seq, changed.state_seq);
      assert.equal(rendered.events.some((event) => event.type === "claim-committed"), false);
    }
    assert.equal(runWbJson(["fsck", "--bucket", bucket]).unresolved, 0);
  } finally {
    if (claiming) await claiming;
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("split-brain append authority follows the elected claimant and their recorded dispatcher", () => {
  const bucket = makeTempBucket();
  try {
    const task = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Split-brain participants"]);
    const args = ["--bucket", bucket, "--task", task.id];
    runWbJson(["claim", ...args, "--entity", "winner"]);
    for (const [entity_id, dispatcher] of [["winner", "winner-dispatcher"], ["loser", "loser-dispatcher"]]) {
      fs.writeFileSync(path.join(bucket, "entities", `${entity_id}.md`), `${serializeFrontmatter({ entity_id, dispatcher })}\n`);
    }
    fs.writeFileSync(task.task_path, fs.readFileSync(task.task_path, "utf8").replace('claimed_by: "winner"', 'claimed_by: "loser"'));
    const before = fs.readFileSync(task.task_path, "utf8");
    for (const entity of ["loser", "loser-dispatcher", "stranger"]) {
      assert.equal(runWb(["log", ...args, "--entity", entity, "-m", "Forbidden"]).status, 3);
    }
    for (const entity of ["winner", "winner-dispatcher", "owner"]) {
      assert.equal(runWbJson(["log", ...args, "--entity", entity, "-m", "Observation"]).task_updated, false);
    }
    assert.equal(fs.readFileSync(task.task_path, "utf8"), before);
    const closed = runWbJson(["cancel", ...args, "--entity", "owner"]);
    assert.equal(closed.status, "cancelled");
    assert.equal(closed.claimed_by, "");
    assert.equal(runWbJson(["fsck", "--bucket", bucket]).unresolved, 0);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("bucket config chooses deployment defaults and rejects zero/invalid settings before writes", () => {
  const bucket = makeTempBucket();
  try {
    fs.unlinkSync(path.join(bucket, "bucket.md"));
    assert.deepEqual(readBucketConfig(bucket), {
      sync: "shared", claim_settle_ms: 2000, default_ttl_seconds: 300, msg_coalesce_ms: 500,
      abandoned_ttl_multiplier: 3, pinned_idle_seconds: 600, unclaimed_seconds: 600,
    });
    for (const [sync, settle] of [["local", 250], ["shared", 2000], ["cloud", 2000]]) {
      fs.writeFileSync(path.join(bucket, "bucket.md"), `${serializeFrontmatter({ sync })}\n`);
      assert.equal(readBucketConfig(bucket).claim_settle_ms, settle);
    }
    for (const data of [
      { sync: "invalid" }, { claim_settle_ms: 0 }, { claim_settle_ms: -1 },
      { claim_settle_ms: "1ms" }, { default_ttl_seconds: 0 }, { msg_coalesce_ms: -1 },
      { abandoned_ttl_multiplier: 1 }, { abandoned_ttl_multiplier: "bad" },
      { pinned_idle_seconds: 0 }, { unclaimed_seconds: -1 },
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
    const rendered = runWbJson(["render", "--bucket", bucket, "--task", created.id,
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
    const args = ["--bucket", bucket, "--task", created.id];
    const eventsDir = path.join(created.path, "events");
    claiming = runWbAsync(["claim", ...args, "--entity", "executor", "--json"]);
    const deadline = Date.now() + 2000;
    while (!fs.readdirSync(eventsDir).some((file) => file.endsWith("-claimed.md")) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(fs.readdirSync(eventsDir).some((file) => file.endsWith("-claimed.md")));
    const mutated = runWbJson(["amend", ...args, "--entity", "owner", "--assignee", ""]);
    const claimed = await claiming;
    assert.equal(claimed.status, 0, claimed.stderr);
    assert.equal(mutated.state_seq, 2);
    assert.equal(JSON.parse(claimed.stdout).state_seq, 3);
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
    const args = ["--bucket", bucket, "--task", created.id];
    const claimed = runWbJson(["claim", ...args, "--entity", "executor"]);
    runWbJson(["amend", ...args, "--entity", "owner", "-m", "Correction"]);
    runWbJson(["accept-amends", ...args, "--entity", "executor"]);
    runWbJson(["review", ...args, "--entity", "executor", "--ac", "1=pass", "--proposed-outcome", "pass"]);
    const feedback = runWbJson(["feedback", ...args, "--entity", "owner"]);
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
    assert.equal(feedback.state_seq, 5);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("fsck uses state sequence rather than filenames or mtimes and refuses ambiguous repair", () => {
  const bucket = makeTempBucket();
  try {
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Sequence"]);
    const args = ["--bucket", bucket, "--task", created.id];
    const updated = runWbJson(["amend", ...args, "--entity", "owner", "--assignee", ""]);
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
    const args = ["--bucket", bucket, "--task", created.id];
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
        type: "log", snapshot_version: 1, state_keys: ["id"], id: created.id,
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
    runWbJson(["complete", "--bucket", bucket, "--entity", "owner", "--task", created.id]);
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
    runWbJson(["complete", "--bucket", bucket, "--entity", "owner", "--task", done.id]);
    const entity = runWbJson(["entity", "register", "--bucket", bucket, "--entity", "owner"]);
    const data = parseFrontmatter(fs.readFileSync(entity.path, "utf8")).data;
    fs.mkdirSync(path.join(bucket, "tasks", "partly-synced"));
    fs.writeFileSync(path.join(bucket, "tasks", "partly-synced", "task.md"), "---\n");
    data.owner_task_seen = [`${active.id}/live.md`, `${done.id}/old.md`, "not-synced-yet/old.md", "partly-synced/old.md"];
    data.stale_task_seen = [`${active.id}/1/child/old`, `${done.id}/1/child/old`];
    fs.writeFileSync(entity.path, `${serializeFrontmatter(data)}\n`);
    const saved = runWbJson(["entity", "register", "--bucket", bucket, "--entity", "owner"]);
    assert.deepEqual(saved.owner_task_seen, [`${active.id}/live.md`, "not-synced-yet/old.md", "partly-synced/old.md"]);
    assert.deepEqual(saved.stale_task_seen, [`${active.id}/1/child/old`]);
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
    assert.deepEqual(findEligibleTasks(bucket, "executor", new Set(), false).map((item) => item.task.id), [pending.id]);
    assert.equal(terminalEventReads, 0);
    const entity = runWbJson(["entity", "register", "--bucket", bucket, "--entity", "owner"]);
    const data = parseFrontmatter(fs.readFileSync(entity.path, "utf8")).data;
    data.owner_task_seen = Array.from({ length: 1000 }, (_, index) => `terminal-${index}/old.md`);
    data.stale_task_seen = Array.from({ length: 1000 }, (_, index) => `terminal-${index}/1/child/old`);
    data.owner_task_seen.push(`${pending.id}/live.md`);
    fs.writeFileSync(entity.path, `${serializeFrontmatter(data)}\n`);
    const saved = runWbJson(["entity", "register", "--bucket", bucket, "--entity", "owner"]);
    assert.deepEqual(saved.owner_task_seen, [`${pending.id}/live.md`]);
    assert.deepEqual(saved.stale_task_seen, []);
  } finally {
    t.mock.restoreAll();
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("rework auto-bumps revision once, warns on actionable amends, and reports transitions", () => {
  const bucket = makeTempBucket();
  try {
    const { id } = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Revisions"]);
    for (const [index, status] of ["review", "blocked"].entries()) {
      runWbJson(["claim", "--bucket", bucket, "--entity", "worker", "--task", id]);
      if (index) runWbJson(["accept-amends", "--bucket", bucket, "--entity", "worker", "--task", id]);
      if (status === "review") runWbJson(["review", "--bucket", bucket, "--entity", "worker", "--task", id, "--ac", "1=pass", "--proposed-outcome", "pass"]);
      else runWbJson(["question", "--bucket", bucket, "--entity", "worker", "--task", id]);
      const amend = runWb(["amend", "--bucket", bucket, "--entity", "owner", "--task", id, "-m", "Correction", "--json"]);
      assert.equal(amend.status, 0, amend.stderr);
      assert.match(amend.stderr, /amend does not reopen/);
      assert.equal(JSON.parse(amend.stdout).status, status);
      const res = runWbJson([status === "review" ? "feedback" : "answer", "--bucket", bucket, "--entity", "owner", "--task", id]);
      assert.equal(res.revision, index + 2 + (index ? 1 : 0));
      assert.equal(res.claim_round, index + 2);
      assert.equal(res.previous_revision, index + 1 + (index ? 1 : 0));
      assert.equal(res.previous_claim_round, index + 1);
      assert.equal(res.assignee, "worker");
    }
    const text = runWb(["amend", "--bucket", bucket, "--entity", "owner", "--task", id, "--assignee", ""]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /revision=4->5 claim_round=3->3/);
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
    const id = JSON.parse(created.stdout).id;
    fs.writeFileSync(path.join(bucket, "INSTRUCTIONS.md"), "No git writes.\r\n");
    runWbJson(["tag", "set", "--bucket", bucket, "--entity", "owner", "--tag", "linux", "-m", "Use the toolchain."]);
    const claim = runWbJson(["claim", "--bucket", bucket, "--entity", "worker", "--task", id]);
    assert.deepEqual(claim.instructions, [
      { file: "INSTRUCTIONS.md", body: "No git writes." },
      { file: "tags/linux.md", body: "Use the toolchain." },
    ]);
    const reviewPath = path.join(bucket, "review-body.md");
    fs.writeFileSync(reviewPath, body);
    runWbJson(["review", "--bucket", bucket, "--entity", "worker", "--task", id, "--body-file", reviewPath, "--ac", "1=pass", "--proposed-outcome", "pass"]);
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
    const ready = runWbJson(["watch", "--bucket", bucket, "--entity", "worker", "--exclude-task", second.id, "--timeout", "1"]);
    assert.deepEqual(ready.tasks.map((t) => t.id), [third.id]);
    assert.equal(runWb(["watch", "--bucket", bucket, "--entity", "dispatcher", "--exclude-task", second.id, "--exclude-task", third.id, "--timeout", "0.1"]).status, 124);
    assert.equal(runWb(["watch", "--bucket", bucket, "--entity", "dispatcher", "--exclude-task", `${second.id},${third.id}`, "--timeout", "0.1"]).status, 124);
    const recovered = runWbJson(["claim", "--bucket", bucket, "--entity", "worker", "--task", first.id]);
    assert.equal(recovered.id, first.id);
    runWbJson(["review", "--bucket", bucket, "--entity", "worker", "--task", first.id, "--ac", "1=pass", "--proposed-outcome", "pass"]);
    runWbJson(["feedback", "--bucket", bucket, "--entity", "owner", "--task", first.id, "--reopen"]);
    const nextRound = runWbJson(["watch", "--bucket", bucket, "--entity", "dispatcher", "--exclude-task", second.id, "--exclude-task", third.id, "--timeout", "1"]);
    assert.equal(nextRound.tasks[0].id, first.id);
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
      runWbJson(["claim", "--bucket", bucket, "--entity", "worker", "--task", task.id]);
      runWbJson(["review", "--bucket", bucket, "--entity", "worker", "--task", task.id, "-m", "Evidence", "--ac", "1=pass", "--proposed-outcome", "pass"]);
    }
    const watchArgs = ["watch", "--bucket", bucket, "--entity", "owner", "--owner-only"];
    const firstEdge = runWbJson([...watchArgs, "--exclude-task", second.id]);
    assert.deepEqual(firstEdge.owner_tasks.map((t) => t.id), [first.id]);
    const secondEdge = runWbJson(watchArgs);
    assert.deepEqual(secondEdge.owner_tasks.map((t) => t.id), [second.id]);
    const registered = runWbJson(["entity", "register", "--bucket", bucket, "--entity", "owner"]);
    assert.equal(registered.owner_task_seen.length, 2);
    assert.equal(runWb([...watchArgs, "--timeout", "0.1"]).status, 124);
    const note = runWbJson(["post", "--bucket", bucket, "--entity", "owner", "--task", first.id, "--type", "log", "-m", "Additional evidence"]);
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
    const claimed = runWbJson(["claim", "--bucket", bucket, "--entity", "worker", "--task", created.id]);
    const body = "one\ntwo\nthree\nfour\nfive\nsix";
    const review = runWbJson(["review", "--bucket", bucket, "--entity", "worker", "--task", created.id, "-m", body, "--ac", "1=pass", "--proposed-outcome", "pass"]);
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
    const taskArgs = ["watch", "--bucket", bucket, "--task", created.id, "--after-event", claimed.last_event_seen];
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

test("render bounds history after the cursor and exposes top-level task fields", () => {
  const bucket = makeTempBucket();
  try {
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "History"]);
    const args = ["--bucket", bucket, "--task", created.id];
    const first = runWbJson(["post", ...args, "--entity", "owner", "--type", "log", "-m", "First"]);
    const second = runWbJson(["post", ...args, "--entity", "owner", "--type", "log", "-m", "Second"]);
    const rendered = runWbJson(["render", ...args, "--tail-events", "2"]);
    assert.deepEqual(rendered.events.map((event) => event.filename), [first.event, second.event]);
    assert.equal(rendered.status, "pending");
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
    assert.match(runWb(["render", "--help"]).stdout, /task summary, body and event history/);
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
    const selected = runWbJson([...args, "--status", "pending,ready", "--tag", "LINUX,macos", "--owner", "owner"]);
    assert.equal(selected.count, 1);
    assert.equal(selected.tasks[0].id, first.id);
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
    const args = ["--bucket", bucket, "--task", created.id];
    const pre = runWbJson(["amend", ...args, "--entity", "owner", "-m", "Pre-claim correction"]);
    const claim = runWbJson(["claim", ...args, "--entity", "worker"]);
    assert.deepEqual(claim.unread_events.map((event) => event.filename), [pre.event]);
    assert.equal(claim.unread_events[0].body, "Pre-claim correction");
    const mid = runWbJson(["amend", ...args, "--entity", "owner", "-m", "Mid-flight correction"]);
    assert.equal(runWb(["accept-amends", ...args, "--entity", "other"]).status, 3);
    assert.equal(runWb(["amend", ...args, "--entity", "worker", "--accept-amends"]).status, 1);
    const accepted = runWbJson(["accept-amends", ...args, "--entity", "worker", "-m", "Applied"]);
    assert.equal(accepted.revision, 2);
    assert.equal(accepted.claim_round, 1);
    assert.equal(accepted.status, "in-progress");
    assert.equal(accepted.last_amend_seen, mid.event);
    const render = runWbJson(["render", ...args]);
    assert.ok(render.body.includes(`## Amendment: ${pre.event}\n\nPre-claim correction`));
    assert.ok(render.body.includes(`## Amendment: ${mid.event}\n\nMid-flight correction`));
    assert.match(render.body, /## Acceptance Criteria/);
    assert.ok(render.events.at(-1).body.includes(pre.event));
    assert.ok(render.events.at(-1).body.includes(mid.event));
    assert.equal(runWb(["accept-amends", ...args, "--entity", "worker"]).status, 1);
    assert.equal(runWbJson(["render", ...args]).events.length, render.events.length);
    runWbJson(["review", ...args, "--entity", "worker", "--ac", "1=pass", "--proposed-outcome", "pass"]);
    const feedback = runWbJson(["feedback", ...args, "--entity", "owner", "-m", "Fix the test"]);
    const rework = runWbJson(["claim", ...args, "--entity", "worker"]);
    assert.deepEqual(rework.unread_events.map((event) => event.filename), [feedback.event]);
    const later = runWbJson(["amend", ...args, "--entity", "owner", "-m", "Still unaccepted"]);
    assert.equal(runWb(["review", ...args, "--entity", "worker", "--ac", "1=pass", "--proposed-outcome", "pass"]).status, 1);
    runWbJson(["reset", ...args, "--entity", "owner", "-m", "Recover before receipt"]);
    const nextClaim = runWbJson(["claim", ...args, "--entity", "worker"]);
    assert.deepEqual(nextClaim.unread_events.map((event) => event.filename), [later.event]);
    runWbJson(["accept-amends", ...args, "--entity", "worker"]);
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
    setBucketConfig(bucket, { default_ttl_seconds: 10 });
    runWbJson(["entity", "register", "--bucket", bucket, "--entity", "worker", "--ttl", "10"]);
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Stalled"]);
    runWbJson(["claim", "--bucket", bucket, "--entity", "worker", "--task", created.id]);
    const entityPath = path.join(bucket, "entities", "worker.md");
    const firstStall = new Date(Date.now() - 20_000).toISOString();
    fs.writeFileSync(entityPath, fs.readFileSync(entityPath, "utf8").replace(/updated_at: "[^"]+"/, `updated_at: "${firstStall}"`));
    const args = ["watch", "--bucket", bucket, "--entity", "owner", "--owner-only", "--poll-ms", "50"];
    const stale = runWbJson(args);
    assert.equal(stale.reason, "stale");
    assert.equal(stale.stale_tasks.length, 1);
    assert.equal(stale.stale_tasks[0].id, created.id);
    assert.equal(stale.stale_tasks[0].heartbeat.ttl_seconds, 10);
    assert.equal(stale.stale_tasks[0].heartbeat.updated_at, firstStall);
    assert.equal(runWb([...args, "--timeout", "0.1"]).status, 124);
    const entity = runWbJson(["entity", "register", "--bucket", bucket, "--entity", "owner"]);
    assert.equal(entity.stale_task_seen.length, 1);
    runWbJson(["entity", "register", "--bucket", bucket, "--entity", "worker"]);
    assert.equal(runWb([...args, "--timeout", "0.1"]).status, 124);
    fs.writeFileSync(entityPath, fs.readFileSync(entityPath, "utf8").replace(/updated_at: "[^"]+"/, `updated_at: "${new Date(Date.now() - 20_000).toISOString()}"`));
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
    runWbJson(["claim", "--bucket", bucket, "--entity", "worker", "--task", created.id]);
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
      const args = ["--bucket", bucket, "--entity", "owner", "--task", created.id];
      assert.equal(runWb(["log", ...args, "--outcome", outcome]).status, 1);
      assert.equal(runWb(["complete", ...args, "--outcome", "unknown"]).status, 1);
      const command = index === 3 ? "cancel" : "complete";
      const closed = runWbJson([command, ...args, "--outcome", outcome]);
      assert.equal(closed.status, index === 3 ? "cancelled" : "complete");
      assert.equal(closed.outcome, outcome);
      const rendered = runWbJson(["render", "--bucket", bucket, "--task", created.id]);
      assert.equal(rendered.outcome, outcome);
      assert.equal(runWb(["log", ...args, "--outcome", outcome]).status, 1);
    }
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("plain PAUSED blocks claims and pool delivery while owners can still review; resume is idempotent", () => {
  const bucket = makeTempBucket();
  try {
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Paused"]);
    const args = ["--bucket", bucket, "--task", created.id];
    const pause = runWbJson(["bucket", "pause", "--bucket", bucket, "-m", "Await decision"]);
    assert.equal(pause.paused, true);
    assert.equal(fs.readFileSync(pause.path, "utf8"), "Await decision\n");
    assert.equal(runWb(["claim", ...args, "--entity", "worker"]).status, 4);
    const watch = runWbJson(["watch", "--bucket", bucket, "--entity", "worker"]);
    assert.equal(watch.reason, "paused");
    assert.equal(watch.paused, true);
    assert.deepEqual(watch.tasks, []);
    assert.equal(runWb(["watch", "--bucket", bucket, "--entity", "owner", "--owner-only", "--timeout", "0.1"]).status, 124);
    assert.equal(runWbJson(["bucket", "resume", "--bucket", bucket]).paused, false);
    runWbJson(["bucket", "resume", "--bucket", bucket]);
    const claim = runWbJson(["claim", ...args, "--entity", "worker"]);
    fs.writeFileSync(pause.path, "Human pause\n");
    runWbJson(["review", ...args, "--entity", "worker", "--ac", "1=pass", "--proposed-outcome", "pass"]);
    const taskUpdate = runWbJson(["watch", ...args, "--after-event", claim.last_event_seen]);
    assert.equal(taskUpdate.paused, true);
    const owner = runWbJson(["watch", "--bucket", bucket, "--entity", "owner", "--owner-only"]);
    assert.equal(owner.paused, true);
    assert.equal(owner.owner_tasks[0].id, created.id);
    assert.equal(runWbJson(["complete", ...args, "--entity", "owner", "--outcome", "pass"]).status, "complete");
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("a pause during claim settle leaves the task pending and wakes an armed pool watcher", async () => {
  const bucket = makeTempBucket();
  try {
    const created = runWbJson(["create", "--bucket", bucket, "--entity", "owner", "--title", "Settle pause"]);
    setBucketConfig(bucket, { claim_settle_ms: 500 });
    const claiming = runWbAsync(["claim", "--bucket", bucket, "--entity", "worker", "--task", created.id, "--json"]);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const watching = runWbAsync(["watch", "--bucket", bucket, "--entity", "observer", "--owner-only", "--timeout", "0.2"]);
    runWbJson(["bucket", "pause", "--bucket", bucket]);
    const claim = await claiming;
    assert.equal(claim.status, 4, claim.stderr);
    assert.match(claim.stderr, /paused during claim/);
    assert.equal(runWbJson(["render", "--bucket", bucket, "--task", created.id]).status, "pending");
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
    const args = ["--bucket", bucket, "--task", created.id];
    const start = Date.now();
    runWbJson(["claim", ...args, "--entity", "worker"]);
    assert.ok(Date.now() - start >= 250, "Initial assigned claim must still settle");
    runWbJson(["review", ...args, "--entity", "worker", "--ac", "1=pass", "--proposed-outcome", "pass"]);
    runWbJson(["feedback", ...args, "--entity", "owner"]);
    const reclaimStart = Date.now();
    const reclaimed = runWbJson(["claim", ...args, "--entity", "worker"]);
    assert.ok(Date.now() - reclaimStart >= 250, "Pinned reclaim must still settle");
    assert.equal(reclaimed.claim_round, 2);
    assert.equal(reclaimed.claimed_by, "worker");
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
    const id = JSON.parse(created.stdout).id;
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

    assert.notEqual(first.id, second.id);
    assert.ok(fs.existsSync(path.join(bucket, "tasks", first.id, "task.md")));
    assert.ok(
      fs.existsSync(
        path.join(bucket, "tasks", first.id, "events", first.created_event)
      )
    );
    assert.equal(first.stage, "tasks");
    assert.equal(first.claim_round, 1);
    assert.deepEqual(first.tags, ["linux", "gpu"]);
    assert.equal(first.priority, "high");
    assert.equal(first.status, "pending");
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
      "--tag",
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
      claimedIds.push(c.id);
      runWbJson([
        "review",
        "--bucket",
        bucket,
        "--entity",
        "win-worker",
        "--task",
        c.id,
        "--ac",
        "1=pass",
        "--proposed-outcome",
        "pass",
      ]);
      runWbJson([
        "complete",
        "--bucket",
        bucket,
        "--entity",
        "owner-1",
        "--task",
        c.id,
      ]);
    }
    assert.deepEqual(
      new Set(claimedIds),
      new Set([tWin.id, tWinOrLinux.id, tPinned.id])
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
    assert.equal(c3.id, tUntagged.id);

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
    assert.equal(c4.id, tWinSigned.id);
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
      dep.id,
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
      cancelledUpstream.id,
    ]);

    // Cancel cancelledUpstream
    runWbJson([
      "cancel",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      cancelledUpstream.id,
    ]);

    // Next claimable must be `dep` (because downstream & blockedByCancel have unmet deps)
    const c1 = runWbJson(["claim", "--bucket", bucket, "--entity", "exec-1"]);
    assert.equal(c1.id, dep.id);

    // WIP limit prevents exec-1 from claiming anything else while in-progress
    const wipErr = runWb(["claim", "--bucket", bucket, "--entity", "exec-1"]);
    assert.equal(wipErr.status, 2);

    // Complete dep
    runWbJson([
      "review",
      "--bucket",
      bucket,
      "--entity",
      "exec-1",
      "--task",
      dep.id,
      "--ac",
      "1=pass",
      "--proposed-outcome",
      "pass",
    ]);
    runWbJson([
      "complete",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      dep.id,
    ]);

    // Now downstream is claimable, while blockedByCancel remains blocked
    const c2 = runWbJson(["claim", "--bucket", bucket, "--entity", "exec-1"]);
    assert.equal(c2.id, downstream.id);

    const noneLeft = runWb(["claim", "--bucket", bucket, "--entity", "exec-2"]);
    assert.equal(noneLeft.status, 2);

    // Removing cancelled dep makes blockedByCancel claimable
    runWbJson([
      "amend",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      blockedByCancel.id,
      "--remove-depends-on",
      cancelledUpstream.id,
    ]);
    const c3 = runWbJson(["claim", "--bucket", bucket, "--entity", "exec-2"]);
    assert.equal(c3.id, blockedByCancel.id);
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
    const id = created.id;

    // Claim
    const claimed = runWbJson(["claim", "--bucket", bucket, "--entity", "worker-b"]);
    assert.equal(claimed.id, id);
    assert.equal(claimed.status, "in-progress");
    assert.equal(claimed.claimed_by, "worker-b");
    assert.equal(claimed.claim_round, 1);

    // Owner posts mid-flight amend without mutating task.md
    const amend1 = runWbJson([
      "amend",
      "--bucket",
      bucket,
      "--entity",
      "owner-a",
      "--task",
      id,
      "-m",
      "First amendment",
    ]);
    assert.equal(amend1.task_updated, false);
    runWbJson(["accept-amends", "--bucket", bucket, "--entity", "worker-b", "--task", id]);

    // Owner attempting to mutate status while in-progress fails single-writer check
    const illegal = runWb([
      "amend",
      "--bucket",
      bucket,
      "--entity",
      "owner-a",
      "--task",
      id,
      "--assignee",
      "worker-c",
    ]);
    assert.notEqual(illegal.status, 0);

    // Worker posts second same-second log and blocks with question
    runWbJson([
      "question",
      "--bucket",
      bucket,
      "--entity",
      "worker-b",
      "--task",
      id,
      "-m",
      "Which Redis key prefix?",
    ]);

    // Owner answers, bumps revision, sets pending (stays in tasks/ with assignee=worker-b and claim_round=2)
    const answered = runWbJson([
      "answer",
      "--bucket",
      bucket,
      "--entity",
      "owner-a",
      "--task",
      id,
      "-m",
      "Use rl:",
    ]);
    assert.equal(answered.stage, "tasks");
    assert.equal(answered.status, "pending");
    assert.equal(answered.revision, 3);
    assert.equal(answered.claim_round, 2);
    assert.equal(answered.assignee, "worker-b");

    // Worker-b re-claims
    const reclaimed = runWbJson(["claim", "--bucket", bucket, "--entity", "worker-b"]);
    assert.equal(reclaimed.id, id);
    assert.equal(reclaimed.status, "in-progress");

    // Stale reset increments claim_round and clears assignee/claimed_by
    const reset = runWbJson([
      "reset",
      "--bucket",
      bucket,
      "--entity",
      "owner-a",
      "--task",
      id,
      "-m",
      "Timed out",
    ]);
    assert.equal(reset.stage, "tasks");
    assert.equal(reset.status, "pending");
    assert.equal(reset.claim_round, 3);
    assert.equal(reset.claimed_by, "");
    assert.equal(reset.assignee, "");

    // Another worker can now claim and complete
    runWbJson(["claim", "--bucket", bucket, "--entity", "worker-c"]);
    runWbJson([
      "review",
      "--bucket",
      bucket,
      "--entity",
      "worker-c",
      "--task",
      id,
      "-m",
      "All tests passed",
      "--ac",
      "1=pass",
      "--proposed-outcome",
      "pass",
    ]);
    const done = runWbJson([
      "complete",
      "--bucket",
      bucket,
      "--entity",
      "owner-a",
      "--task",
      id,
      "-m",
      "Approved",
    ]);
    assert.equal(done.stage, "tasks");
    assert.equal(done.status, "complete");
    assert.equal(done.claimed_by, "");

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
    const losers = racers.filter((r) => r.status === 2 || r.status === 3);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 2);

    const winData = JSON.parse(winners[0].stdout);
    assert.equal(winData.id, created.id);
    assert.equal(winData.claimed_by, winData.updated_by);
    const rendered = runWbJson(["render", "--bucket", bucket, "--task", created.id]);
    assert.equal(rendered.claim_winner, winData.claimed_by);
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
    assert.equal(readyPayload.tasks[0].id, winTask.id);

    // Claim it and watch for new events on this specific task
    const claimed = runWbJson([
      "claim",
      "--bucket",
      bucket,
      "--entity",
      "win-1",
      "--task",
      winTask.id,
    ]);

    const watchTaskPromise = runWbAsync([
      "watch",
      "--bucket",
      bucket,
      "--task",
      winTask.id,
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
      "amend",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      winTask.id,
      "-m",
      "Also sign binary",
    ]);

    const watchTaskRes = await watchTaskPromise;
    assert.equal(watchTaskRes.status, 0, watchTaskRes.stderr);
    const taskPayload = JSON.parse(watchTaskRes.stdout);
    assert.equal(taskPayload.mode, "task");
    assert.equal(taskPayload.id, winTask.id);
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
    assert.equal(cParent.id, parent.id);

    // The executor owns its child; only the parent owner can change parent metadata.
    const child = runWbJson([
      "create",
      "--bucket",
      bucket,
      "--entity",
      "exec-1",
      "--title",
      "Child subtask",
      "--parent",
      parent.id,
    ]);
    assert.equal(child.parent, parent.id);

    const parked = runWbJson([
      "reset",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      parent.id,
      "-m",
      "Decomposed into child",
    ]);
    runWbJson([
      "amend", "--bucket", bucket, "--entity", "owner-1", "--task", parent.id,
      "--add-depends-on",
      child.id,
      "--assignee",
      "exec-1",
    ]);
    assert.equal(parked.status, "pending");
    assert.equal(parked.claimed_by, "");
    assert.equal(parked.assignee, "");
    assert.equal(parked.claim_round, 2);
    assert.deepEqual(runWbJson(["render", "--bucket", bucket, "--task", parent.id]).depends_on, [child.id]);

    // exec-1 can now claim child because parent WIP was freed (and parent is blocked by child)
    const cChild = runWbJson(["claim", "--bucket", bucket, "--entity", "exec-1"]);
    assert.equal(cChild.id, child.id);

    // Complete child
    runWbJson([
      "review",
      "--bucket",
      bucket,
      "--entity",
      "exec-1",
      "--task",
      child.id,
      "--ac",
      "1=pass",
      "--proposed-outcome",
      "pass",
    ]);
    runWbJson([
      "complete",
      "--bucket",
      bucket,
      "--entity",
      "exec-1",
      "--task",
      child.id,
    ]);

    // Resume parent
    const resumed = runWbJson(["claim", "--bucket", bucket, "--entity", "exec-1"]);
    assert.equal(resumed.id, parent.id);
    runWbJson(["accept-amends", "--bucket", bucket, "--entity", "exec-1", "--task", parent.id]);

    // Submit review -> owner sends feedback -> exec-1 re-claims -> review -> complete
    runWbJson([
      "review",
      "--bucket",
      bucket,
      "--entity",
      "exec-1",
      "--task",
      parent.id,
      "-m",
      "Initial submission",
      "--ac",
      "1=pass",
      "--proposed-outcome",
      "pass",
    ]);
    const fb = runWbJson([
      "feedback",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      parent.id,
      "-m",
      "Please add edge-case test",
    ]);
    assert.equal(fb.revision, 4);
    assert.equal(fb.claim_round, 3);

    //watch --after-event on an amend emitted BEFORE watch starts must exit immediately
    const preAmend = runWbJson([
      "amend",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      parent.id,
      "-m",
      "Before watch started",
    ]);
    const immediateWatch = runWbJson([
      "watch",
      "--bucket",
      bucket,
      "--task",
      parent.id,
      "--after-event",
      fb.event,
      "--timeout",
      "2",
    ]);
    assert.deepEqual(immediateWatch.new_events, [preAmend.event]);

    // Write a dotfile inside events/ and ensure render ignores it
    fs.writeFileSync(
      path.join(bucket, "tasks", parent.id, "events", ".tmp-event.tmp"),
      "junk"
    );
    const mdRender = runWb(["render", "--bucket", bucket, "--task", parent.id]);
    assert.equal(mdRender.status, 0);
    assert.ok(!mdRender.stdout.includes(".tmp-event.tmp"));
    assert.match(mdRender.stdout, /## Event Stream/);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("feedback/answer auto-pin pool claimants, reopen clears pins, and reviews cannot tick ACs", () => {
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
    assert.equal(created.assignee, "");

    const claimed = runWbJson([
      "claim",
      "--bucket",
      bucket,
      "--entity",
      "worker-1",
    ]);
    assert.equal(claimed.claimed_by, "worker-1");
    assert.equal(claimed.assignee, "");

    assert.equal(runWb(["review", "--bucket", bucket, "--entity", "worker-1", "--task", created.id, "--check-ac"]).status, 1);
    const reviewed = runWbJson([
      "review",
      "--bucket",
      bucket,
      "--entity",
      "worker-1",
      "--task",
      created.id,
      "--ac",
      "1=pass",
      "--ac",
      "2=fail",
      "--proposed-outcome",
      "partial",
    ]);
    assert.equal(reviewed.status, "review");

    const renderedReview = runWbJson([
      "render",
      "--bucket",
      bucket,
      "--task",
      created.id,
    ]);
    assert.match(renderedReview.body, /- \[ \] #1 First check/);
    assert.match(renderedReview.body, /- \[ \] #2 Second check/);

    // Owner sends feedback without --assignee: should auto-pin assignee=worker-1 and clear claimed_by
    const fb = runWbJson([
      "feedback",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      created.id,
      "-m",
      "Needs adjustment",
    ]);
    assert.equal(fb.stage, "tasks");
    assert.equal(fb.status, "pending");
    assert.equal(fb.assignee, "worker-1");
    assert.equal(fb.claimed_by, "");
    assert.equal(fb.claim_round, 2);
    assert.equal(fb.revision, 2);

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
    assert.equal(reclaimed.id, created.id);
    assert.equal(reclaimed.status, "in-progress");

    // Reopening to general pool clears assignee and increments claim_round
    runWbJson([
      "question",
      "--bucket",
      bucket,
      "--entity",
      "worker-1",
      "--task",
      created.id,
      "-m",
      "Need pool handoff",
    ]);
    const reopened = runWbJson([
      "answer",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      created.id,
      "-m",
      "Opening to pool",
      "--reopen",
    ]);
    assert.equal(reopened.stage, "tasks");
    assert.equal(reopened.status, "pending");
    assert.equal(reopened.assignee, "");
    assert.equal(reopened.claimed_by, "");
    assert.equal(reopened.claim_round, 3);

    // Now worker-2 can claim it
    const claimedBy2 = runWbJson([
      "claim",
      "--bucket",
      bucket,
      "--entity",
      "worker-2",
    ]);
    assert.equal(claimedBy2.id, created.id);
  } finally {
    fs.rmSync(bucket, { recursive: true, force: true });
  }
});

test("human-created minimal/malformed tasks remain readable but ownerless closure is refused", () => {
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
      `---\ntitle: Human minimal\nstatus: pending\ntags: linux\ndepends_on: ${blocker.id}\n---\nDo it\n- [ ] #1 Verified\n`
    );

    // Scalar depends_on must keep human-minimal blocked until blocker is complete
    const watchBlocked = runWb(["watch", "--bucket", bucket, "--entity", "exec-1", "--tag", "linux", "--timeout", "1", "--json"]);
    assert.equal(watchBlocked.status, 124);

    // Complete blocker
    runWbJson(["claim", "--bucket", bucket, "--entity", "exec-2", "--include-untagged", "--task", blocker.id]);
    runWbJson(["review", "--bucket", bucket, "--entity", "exec-2", "--task", blocker.id, "--ac", "1=pass", "--proposed-outcome", "pass"]);
    runWbJson(["complete", "--bucket", bucket, "--entity", "human", "--task", blocker.id]);

    // Scalar tag "linux" must now surface human-minimal via watch despite broken neighbors
    const ready = runWbJson(["watch", "--bucket", bucket, "--entity", "exec-1", "--tag", "linux", "--timeout", "2"]);
    assert.equal(ready.count, 1);
    assert.equal(ready.tasks[0].id, "human-minimal");

    // Claiming populates id from the folder but cannot invent owner authority.
    const claimed = runWbJson(["claim", "--bucket", bucket, "--entity", "exec-1", "--tag", "linux", "--task", "human-minimal"]);
    assert.equal(claimed.id, "human-minimal");
    assert.equal(claimed.owner, "");

    // Plain-text note in events/ must not crash render
    fs.writeFileSync(path.join(bucket, "tasks", "human-minimal", "events", "human-note.md"), "Remember edge cases");
    const rendered = runWbJson(["render", "--bucket", bucket, "--task", "human-minimal"]);
    assert.equal(rendered.events.some((e) => e.type === "note" && e.body === "Remember edge cases"), true);

    runWbJson(["review", "--bucket", bucket, "--entity", "exec-1", "--task", "human-minimal", "--ac", "1=pass", "--proposed-outcome", "pass"]);
    for (const entity of ["exec-1", "reviewer-1"]) {
      assert.equal(runWb(["complete", "--bucket", bucket, "--entity", entity, "--task", "human-minimal"]).status, 3);
    }
    assert.equal(runWbJson(["render", "--bucket", bucket, "--task", "human-minimal"]).status, "review");
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
    assert.equal(draftTask.status, "draft");
    assert.ok(fs.existsSync(path.join(bucket, "tasks", draftTask.id, "task.md")));

    // Worker cannot claim draft task
    assert.equal(runWb(["claim", "--bucket", bucket, "--entity", "w-1"]).status, 2);

    // Mark ready (still held back from workers)
    const markedReady = runWbJson([
      "promote",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      draftTask.id,
      "-m",
      "Refined and ready",
      "--status",
      "ready",
    ]);
    assert.equal(markedReady.stage, "tasks");
    assert.equal(markedReady.status, "ready");
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
      "promote",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      draftTask.id,
      "-m",
      "Promoting to pending",
      "--status",
      "pending",
    ]);
    assert.equal(promoted.stage, "tasks");
    assert.equal(promoted.status, "pending");

    // Pull back to ready, then re-promote and claim
    const pulledBack = runWbJson([
      "demote",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      draftTask.id,
      "-m",
      "Holding back briefly",
      "--status",
      "ready",
    ]);
    assert.equal(pulledBack.stage, "tasks");
    assert.equal(pulledBack.status, "ready");
    assert.equal(runWb(["claim", "--bucket", bucket, "--entity", "w-1"]).status, 2);

    runWbJson([
      "promote",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      draftTask.id,
      "-m",
      "Ready for work",
      "--status",
      "pending",
    ]);
    const claimed = runWbJson(["claim", "--bucket", bucket, "--entity", "w-1"]);
    assert.equal(claimed.id, draftTask.id);

    // Cancel draft task directly
    const cancelled = runWbJson([
      "cancel",
      "--bucket",
      bucket,
      "--entity",
      "owner-1",
      "--task",
      cancelledDraft.id,
      "-m",
      "Not needed",
    ]);
    assert.equal(cancelled.stage, "tasks");
    assert.equal(cancelled.status, "cancelled");
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
      tOwned.id,
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
      tOwned.id,
      "--type",
      "log",
      "-m",
      "Working on it",
    ]);

    await new Promise((r) => setTimeout(r, 150));
    // Transition to review SHOULD wake owner
    runWbJson([
      "review",
      "--bucket",
      bucket,
      "--entity",
      "worker-1",
      "--task",
      tOwned.id,
      "-m",
      "Ready for review",
      "--ac",
      "1=pass",
      "--proposed-outcome",
      "pass",
    ]);

    const ownerRes = await ownerWatch;
    assert.equal(ownerRes.status, 0, ownerRes.stderr);
    const ownerPayload = JSON.parse(ownerRes.stdout);
    assert.equal(ownerPayload.mode, "owner");
    assert.equal(ownerPayload.tasks.length, 0);
    assert.equal(ownerPayload.owner_tasks.length, 1);
    assert.equal(ownerPayload.owner_tasks[0].id, tOwned.id);
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
    const taskDir = path.join(bucket, "tasks", created.id);
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
    const renderedRes = runWb(["render", "--bucket", bucket, "--task", created.id, "--json"]);
    assert.equal(renderedRes.status, 0, renderedRes.stderr);
    assert.match(renderedRes.stderr, /sync conflict copy detected/i);
    const rendered = JSON.parse(renderedRes.stdout);
    assert.equal(rendered.claim_winner, "alice");
    assert.equal(rendered.events.some((e) => isSyncConflictFilename(e.filename)), false);

    // Bob's review fails the split-brain guard.
    const splitRes = runWb([
      "review",
      "--bucket",
      bucket,
      "--entity",
      "bob",
      "--task",
      created.id,
      "--ac",
      "1=pass",
      "--proposed-outcome",
      "pass",
    ]);
    assert.equal(splitRes.status, 3);
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
    assert.notEqual(claimA.id, claimB.id);
    assert.deepEqual(new Set([claimA.id, claimB.id]), new Set([t1.id, t2.id]));

    // Both workers finish their tasks on their respective replicas and owner completes them
    runWbJson(["review", "--bucket", replicaA, "--entity", "worker-a", "--task", claimA.id, "--ac", "1=pass", "--proposed-outcome", "pass"]);
    runWbJson(["review", "--bucket", replicaB, "--entity", "worker-b", "--task", claimB.id, "--ac", "1=pass", "--proposed-outcome", "pass"]);
    await new Promise((r) => setTimeout(r, 150));

    runWbJson(["complete", "--bucket", replicaA, "--entity", "owner-a", "--task", t1.id]);
    runWbJson(["complete", "--bucket", replicaA, "--entity", "owner-a", "--task", t2.id]);
    await new Promise((r) => setTimeout(r, 120));

    const r1B = runWbJson(["render", "--bucket", replicaB, "--task", t1.id]);
    const r2B = runWbJson(["render", "--bucket", replicaB, "--task", t2.id]);
    assert.equal(r1B.status, "complete");
    assert.equal(r2B.status, "complete");
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
    const taskFiles = fs.readdirSync(path.join(replicaA, "tasks", t1.id));
    assert.ok(taskFiles.some((f) => isSyncConflictFilename(f)));

    // Both replicas deterministically agree on claim_winner === "alpha"
    const rA = runWb(["render", "--bucket", replicaA, "--task", t1.id, "--json"]);
    const rB = runWb(["render", "--bucket", replicaB, "--task", t1.id, "--json"]);
    assert.equal(JSON.parse(rA.stdout).claim_winner, "alpha");
    assert.equal(JSON.parse(rB.stdout).claim_winner, "alpha");

    // Loser "zeta" is rejected at post even though LWW task.md temporarily had claimed_by="zeta"
    const zetaPost = runWb([
      "review",
      "--bucket",
      replicaB,
      "--entity",
      "zeta",
      "--task",
      t1.id,
      "--ac",
      "1=pass",
      "--proposed-outcome",
      "pass",
    ]);
    assert.equal(zetaPost.status, 3);
    assert.match(zetaPost.stderr, /Split-brain claim conflict/);

    // Winner "alpha" heals task.md and completes full feedback rework across delayed syncs
    const rev1 = runWbJson([
      "review",
      "--bucket",
      replicaA,
      "--entity",
      "alpha",
      "--task",
      t1.id,
      "-m",
      "Round 1 work",
      "--ac",
      "1=pass",
      "--proposed-outcome",
      "pass",
    ]);
    assert.equal(rev1.claimed_by, "alpha");
    syncOnce();

    const fb = runWbJson([
      "feedback",
      "--bucket",
      replicaB,
      "--entity",
      "owner-a",
      "--task",
      t1.id,
      "-m",
      "Polish",
    ]);
    assert.equal(fb.claim_round, 2);
    assert.equal(fb.assignee, "alpha");
    syncOnce();

    runWbJson(["claim", "--bucket", replicaA, "--entity", "alpha"]);
    runWbJson(["review", "--bucket", replicaA, "--entity", "alpha", "--task", t1.id, "--ac", "1=pass", "--proposed-outcome", "pass"]);
    syncOnce();

    const done = runWbJson(["complete", "--bucket", replicaB, "--entity", "owner-a", "--task", t1.id]);
    assert.equal(done.status, "complete");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
