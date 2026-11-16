#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CliError, parseCommand, printCommandHelp } from "./commands.mjs";

const VALID_STATUSES = new Set([
  "draft",
  "ready",
  "pending",
  "in-progress",
  "blocked",
  "review",
  "complete",
  "cancelled",
]);

const DEFAULT_ENTITY_TTL_SECONDS = 300;
const DEFAULT_MSG_COALESCE_MS = 500;
const MAX_MSG_COALESCE_MS = 2000;
const DEFAULT_CLAIM_SETTLE_MS = 2000;
const TERMINAL_STATUSES = new Set(["complete", "cancelled"]);
const BUCKET_SUBDIRS = [
  "tasks",
  "messages",
  "entities",
  "tags",
];

const VALID_PRIORITIES = new Set(["low", "medium", "high", "critical"]);

const PRIORITY_RANK = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const CANONICAL_TASK_KEYS = [
  "id",
  "title",
  "status",
  "priority",
  "tags",
  "owner",
  "claimed_by",
  "assignee",
  "parent",
  "depends_on",
  "revision",
  "claim_round",
  "updated_by",
  "updated_at",
];

const NON_TERMINAL_STATUSES = [...VALID_STATUSES].filter((status) => !TERMINAL_STATUSES.has(status));
const TRANSITIONS = {
  create: { from: [null], actor: "owner", to: null, event: "created" },
  promote: { from: ["draft", "ready"], actor: "owner", to: "pending", targets: ["ready", "pending"] },
  demote: { from: ["ready", "pending"], actor: "owner", to: "ready", targets: ["draft", "ready"] },
  claim: { from: ["pending"], actor: "eligible", to: "in-progress", event: "claim-committed" },
  amend: { from: NON_TERMINAL_STATUSES, actor: "owner", to: null },
  review: { from: ["in-progress"], actor: "claimant", to: "review" },
  question: { from: ["in-progress"], actor: "claimant", to: "blocked" },
  feedback: { from: ["review"], actor: "owner", to: "pending" },
  answer: { from: ["blocked"], actor: "owner", to: "pending" },
  reset: { from: ["in-progress"], actor: "owner", to: "pending" },
  release: { from: ["in-progress"], actor: "executor", to: "pending" },
  checkpoint: { from: NON_TERMINAL_STATUSES, actor: "participant", to: null },
  complete: { from: NON_TERMINAL_STATUSES, actor: "owner", to: "complete" },
  cancel: { from: NON_TERMINAL_STATUSES, actor: "owner", to: "cancelled", event: "cancelled" },
  log: { from: NON_TERMINAL_STATUSES, actor: "participant", to: null },
  note: { from: NON_TERMINAL_STATUSES, actor: "participant", to: null },
  "accept-amends": { from: ["in-progress"], actor: "claimant", to: null, event: "log" },
  "ack-instructions": { from: ["in-progress"], actor: "claimant", to: null },
};

function assertTransition(intent, item, entityId, context = {}) {
  const rule = TRANSITIONS[intent];
  const task = item?.task;
  if (!rule || !rule.from.includes(task?.status ?? null)) {
    throw new CliError(`Cannot ${intent} task in status "${task?.status ?? "missing"}".`, intent === "claim" ? 2 : 1);
  }
  if (intent === "create") return rule;
  if (rule.actor === "eligible") {
    if (!canClaim(item, entityId, context.workerTags, context.includeUntagged, context.byId, context.bucketDir)) {
      throw new CliError(`Task "${task.id}" is not eligible for "${entityId}".`, 2);
    }
    return rule;
  }
  const winner = task.status === "in-progress"
    ? getRoundClaims(item.eventsDir, task.claim_round).winner : null;
  const claimant = winner?.entityId || task.claimed_by;
  const owner = task.owner === entityId;
  const dispatcher = claimant && readEntityFile(context.bucketDir, claimant)?.dispatcher === entityId;
  if ((rule.actor === "owner" && !owner) ||
      (rule.actor === "claimant" && claimant !== entityId) ||
      (rule.actor === "executor" && claimant !== entityId && !dispatcher) ||
      (rule.actor === "participant" && !owner && claimant !== entityId && !dispatcher)) {
    throw new CliError(
      task.claimed_by === entityId && winner && winner.entityId !== entityId
        ? `Split-brain claim conflict: round ${task.claim_round} winner is "${winner.entityId}", not "${entityId}".`
        : `Permission denied: ${intent} requires ${rule.actor} authority on task "${task.id}".`,
      3
    );
  }
  const target = context.targetStatus ?? rule.to;
  if (rule.targets && (!rule.targets.includes(target) || task.status === target)) {
    throw new CliError(`Invalid ${intent} target "${target}".`);
  }
  if (context.metadataChange && (!["draft", "ready", "pending"].includes(task.status) || task.claimed_by)) {
    throw new CliError("Metadata amendments require an unclaimed draft, ready or pending task.");
  }
  return rule;
}

function canClaim(item, entityId, workerTags = new Set(), includeUntagged = false, byId = new Map(), bucketDir) {
  return item.task.status === "pending" && !item.task.claimed_by &&
    (assignedToEntity(item.task, entityId, bucketDir) || (!item.task.assignee &&
      matchesTags(item.task, entityId, workerTags, includeUntagged))) &&
    dependenciesSatisfied(item.task, byId) && !hasCompetingRoundClaim(item, entityId);
}

function assignedToEntity(task, entityId, bucketDir) {
  return Boolean(task.assignee && (task.assignee === entityId ||
    (bucketDir && readEntityFile(bucketDir, entityId)?.dispatcher === task.assignee)));
}

function validateAssignee(bucketDir, assignee) {
  if (!assignee) return;
  validateIdentifier(assignee, "--assignee");
  const dispatcher = readEntityFile(bucketDir, assignee)?.dispatcher;
  if (dispatcher) throw new CliError(`"${assignee}" is a recorded child; assign to dispatcher "${dispatcher}" instead.`);
}

function positiveSeconds(value, label) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new CliError(`${label} must be a positive integer.`);
  return number;
}

let tmpCounter = 0;
let sessionNonce = process.env.WB_SESSION_NONCE || "";
const warnedEntitySessions = new Set();

function formatIsoUtc(date = new Date()) {
  return date.toISOString();
}

function formatCompactUtc(date = new Date()) {
  return formatIsoUtc(date).replace(/[-:.]/g, "");
}

function readBucketConfig(bucketDir) {
  let data;
  try {
    ({ data } = parseFrontmatter(fs.readFileSync(path.join(bucketDir, "bucket.md"), "utf8")));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    data = {};
  }
  const sync = data.sync ?? "shared";
  if (!["local", "shared", "cloud"].includes(sync)) {
    throw new CliError('bucket.md: sync must be local|shared|cloud.');
  }
  const config = {
    sync,
    claim_settle_ms: data.claim_settle_ms ?? (sync === "local" ? 250 : DEFAULT_CLAIM_SETTLE_MS),
    default_ttl_seconds: data.default_ttl_seconds ?? DEFAULT_ENTITY_TTL_SECONDS,
    msg_coalesce_ms: data.msg_coalesce_ms ?? DEFAULT_MSG_COALESCE_MS,
    abandoned_ttl_multiplier: data.abandoned_ttl_multiplier ?? 3,
    pinned_idle_seconds: data.pinned_idle_seconds ?? 600,
    unclaimed_seconds: data.unclaimed_seconds ?? 600,
  };
  for (const key of ["claim_settle_ms", "default_ttl_seconds", "msg_coalesce_ms", "abandoned_ttl_multiplier", "pinned_idle_seconds", "unclaimed_seconds"]) {
    if (!Number.isSafeInteger(config[key]) || config[key] < (key === "msg_coalesce_ms" ? 0 : 1)) {
      throw new CliError(`bucket.md: ${key} must be ${key === "msg_coalesce_ms" ? "a non-negative" : "a positive"} integer.`);
    }
  }
  if (config.abandoned_ttl_multiplier < 2) throw new CliError("bucket.md: abandoned_ttl_multiplier must be at least 2.");
  return config;
}

function validateIdentifier(value, label) {
  if (!value || typeof value !== "string") {
    throw new CliError(`Missing required ${label}.`);
  }
  if (
    value.startsWith(".") ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("..") ||
    /[\s\x00-\x1f\x7f]/.test(value)
  ) {
    throw new CliError(
      `Invalid ${label} "${value}": must not contain whitespace, path separators, "..", or leading "."`
    );
  }
  return value;
}

function validateTaskId(value) {
  return validateIdentifier(value, "--task");
}

function slugify(text) {
  const slug = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "task";
}

function parseListFlags(values) {
  if (!values) return [];
  const arr = Array.isArray(values) ? values : [values];
  const result = [];
  for (const entry of arr) {
    for (const part of String(entry).split(",")) {
      const trimmed = part.trim();
      if (trimmed) result.push(trimmed);
    }
  }
  return result;
}

function normalizeTags(tags) {
  const seen = new Set();
  const out = [];
  for (const tag of tags) {
    const t = String(tag).trim().toLowerCase();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function ensureBucketDirs(bucketDir) {
  readBucketConfig(bucketDir);
  for (const sub of BUCKET_SUBDIRS) {
    fs.mkdirSync(path.join(bucketDir, sub), { recursive: true });
  }
}

function atomicWriteFile(filePath, content) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  tmpCounter += 1;
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${tmpCounter}.tmp`);
  try {
    fs.writeFileSync(tmpPath, content, "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

function stripInlineComment(raw) {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        if (raw[i + 1] === "'") i += 1;
        else inSingle = false;
      }
      continue;
    }
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
    else if (ch === "#" && (i === 0 || /\s/.test(raw[i - 1]))) {
      return raw.slice(0, i).trim();
    }
  }
  return raw.trim();
}

function parseScalar(raw) {
  const trimmed = stripInlineComment(raw);
  if (trimmed === "") return "";
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  return trimmed;
}

function parseInlineArray(raw) {
  const cleaned = stripInlineComment(raw);
  if (!cleaned.startsWith("[") || !cleaned.endsWith("]")) {
    return null;
  }
  const inner = cleaned.slice(1, -1).trim();
  if (!inner) return [];

  const items = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (inDouble) {
      current += ch;
      if (ch === "\\") escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      current += ch;
      if (ch === "'") {
        if (inner[i + 1] === "'") {
          current += "'";
          i += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
    } else if (ch === "'") {
      inSingle = true;
      current += ch;
    } else if (ch === ",") {
      const val = parseScalar(current);
      if (val !== "") items.push(String(val));
      current = "";
    } else {
      current += ch;
    }
  }
  const last = parseScalar(current);
  if (last !== "") items.push(String(last));
  return items;
}

function parseFrontmatter(rawText) {
  const normalized = rawText.replace(/\r/g, "");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new CliError("Invalid Markdown frontmatter: missing opening '---'.");
  }
  let endIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    throw new CliError("Invalid Markdown frontmatter: missing closing '---'.");
  }

  const data = {};
  const yamlLines = lines.slice(1, endIndex);
  let currentListKey = null;

  for (const line of yamlLines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const listItemMatch = line.match(/^\s+-\s*(.*)$/);
    if (listItemMatch && currentListKey) {
      const val = parseScalar(listItemMatch[1]);
      if (val !== "") data[currentListKey].push(String(val));
      continue;
    }

    currentListKey = null;
    const kvMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kvMatch) continue;
    const [, key, rawVal] = kvMatch;
    const stripped = stripInlineComment(rawVal);
    if (stripped === "") {
      // Could be start of a multi-line YAML array or empty value; default to [] for array keys
      if (key === "tags" || key === "depends_on" || key === "to") {
        data[key] = [];
        currentListKey = key;
      } else {
        data[key] = "";
      }
    } else if (stripped.startsWith("[")) {
      const parsedArr = parseInlineArray(stripped);
      data[key] = parsedArr ?? [];
    } else if (stripped.startsWith("{")) {
      try { data[key] = JSON.parse(stripped); }
      catch { throw new CliError(`Invalid JSON flow mapping for "${key}".`); }
    } else {
      data[key] = parseScalar(rawVal);
    }
  }

  const body = lines.slice(endIndex + 1).join("\n");
  return { data, body };
}

function serializeFrontmatter(data, canonicalKeys = null) {
  const keys = [];
  const seen = new Set();
  if (canonicalKeys) {
    for (const k of canonicalKeys) {
      if (Object.prototype.hasOwnProperty.call(data, k)) {
        keys.push(k);
        seen.add(k);
      }
    }
  }
  for (const k of Object.keys(data)) {
    if (!seen.has(k)) keys.push(k);
  }

  const lines = ["---"];
  for (const k of keys) {
    const val = data[k];
    if (Array.isArray(val)) {
      const items = val.map((item) => JSON.stringify(String(item))).join(", ");
      lines.push(`${k}: [${items}]`);
    } else if (val && typeof val === "object") {
      lines.push(`${k}: ${JSON.stringify(val)}`);
    } else if (typeof val === "number") {
      lines.push(`${k}: ${Number.isFinite(val) ? Math.trunc(val) : 1}`);
    } else if (typeof val === "boolean") {
      lines.push(`${k}: ${val}`);
    } else {
      lines.push(`${k}: ${JSON.stringify(val == null ? "" : String(val))}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function formatTaskMarkdown(data, body) {
  const fm = serializeFrontmatter(data, CANONICAL_TASK_KEYS);
  if (!body) return `${fm}\n`;
  return `${fm}\n${body}`;
}

function formatEventMarkdown(data, body) {
  const fm = serializeFrontmatter(data, ["type", "entity_id", "timestamp", "round"]);
  const trimmedBody = String(body || "").replace(/\r/g, "").trim();
  if (!trimmedBody) return `${fm}\n`;
  return `${fm}\n\n${trimmedBody}\n`;
}

const warnedMalformedTasks = new Set();
const warnedConflictFiles = new Set();

function isSyncConflictFilename(name) {
  return /(\.sync-conflict-|conflicted copy)/i.test(String(name || ""));
}

function warnIfSyncConflictPresent(dirPath) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (isSyncConflictFilename(entry.name)) {
        const full = path.join(dirPath, entry.name);
        if (!warnedConflictFiles.has(full)) {
          warnedConflictFiles.add(full);
          process.stderr.write(`Warning: cloud sync conflict copy detected at ${full}\n`);
        }
      }
    }
  } catch {
    // ignore
  }
}

function coerceStringList(val, emptySentinel = false) {
  if (Array.isArray(val)) {
    return val.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) return [];
    if (emptySentinel && trimmed.toLowerCase() === "none") return [];
    return trimmed
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function readTaskFile(taskPath) {
  const raw = fs.readFileSync(taskPath, "utf8");
  const { data, body } = parseFrontmatter(raw);
  const fallbackId = path.basename(path.dirname(taskPath));
  const task = {
    id: String(data.id || fallbackId),
    title: String(data.title ?? ""),
    status: String(data.status ?? "pending"),
    priority: String(data.priority ?? "medium"),
    tags: normalizeTags(coerceStringList(data.tags)),
    owner: String(data.owner ?? ""),
    claimed_by: String(data.claimed_by ?? ""),
    assignee: String(data.assignee ?? ""),
    parent: String(data.parent ?? ""),
    depends_on: coerceStringList(data.depends_on, true),
    revision:
      typeof data.revision === "number"
        ? data.revision
        : Number.parseInt(String(data.revision || "1"), 10) || 1,
    claim_round:
      typeof data.claim_round === "number"
        ? data.claim_round
        : Number.parseInt(String(data.claim_round || "1"), 10) || 1,
    updated_by: String(data.updated_by ?? ""),
    updated_at: String(data.updated_at ?? ""),
  };
  for (const [k, v] of Object.entries(data)) {
    if (!Object.prototype.hasOwnProperty.call(task, k)) {
      task[k] = v;
    }
  }
  return { task, body };
}

function listTasks(bucketDir) {
  const tasksDir = path.join(bucketDir, "tasks");
  let entries;
  try {
    entries = fs.readdirSync(tasksDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const tasks = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory()) continue;
    const dir = path.join(tasksDir, entry.name);
    warnIfSyncConflictPresent(dir);
    const taskPath = path.join(dir, "task.md");
    try {
      const { task, body } = readTaskFile(taskPath);
      if (!task.id) task.id = entry.name;
      tasks.push({
        stage: "tasks",
        dirName: entry.name,
        dir,
        taskPath,
        eventsDir: path.join(dir, "events"),
        task,
        body,
      });
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") {
        // Ignore folders missing task.md or synced mid-scan
        continue;
      }
      if (err instanceof CliError) {
        if (!warnedMalformedTasks.has(taskPath)) {
          warnedMalformedTasks.add(taskPath);
          process.stderr.write(`Warning: skipping malformed task ${taskPath}: ${err.message}\n`);
        }
        continue;
      }
      throw err;
    }
  }
  return tasks;
}

function scanAllTasks(bucketDir) {
  const tasks = listTasks(bucketDir);
  const byId = new Map();
  for (const item of tasks) {
    byId.set(item.task.id || item.dirName, item);
  }
  return { tasks, byId };
}

function findTask(bucketDir, taskId) {
  validateTaskId(taskId);
  const dir = path.join(bucketDir, "tasks", taskId);
  const taskPath = path.join(dir, "task.md");
  try {
    const { task, body } = readTaskFile(taskPath);
    if (!task.id) task.id = taskId;
    warnIfSyncConflictPresent(dir);
    return {
      stage: "tasks",
      dirName: taskId,
      dir,
      taskPath,
      eventsDir: path.join(dir, "events"),
      task,
      body,
    };
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

function parseEventFilenameParts(filename) {
  const m = filename.match(
    /^(\d{8}T\d{6}(?:\d{3})?Z)-(.+)-(claim-committed|created|claimed|promote|demote|amend|question|answer|note|log|review|feedback|complete|cancelled|reset)(?:-(\d+))?\.md$/
  );
  if (!m) return null;
  return {
    utc: m[1].length === 16 ? m[1].replace("Z", "000Z") : m[1],
    entityId: m[2],
    type: m[3],
    seq: m[4] ? Number.parseInt(m[4], 10) : 1,
  };
}

function compareEventFilenames(a, b) {
  if (a === b) return 0;
  const pa = parseEventFilenameParts(a);
  const pb = parseEventFilenameParts(b);
  if (pa && pb) {
    if (pa.utc !== pb.utc) return pa.utc < pb.utc ? -1 : 1;
    if (pa.type === "created" && pb.type !== "created") return -1;
    if (pb.type === "created" && pa.type !== "created") return 1;
    if (pa.entityId === pb.entityId && pa.type === pb.type) {
      if (pa.seq !== pb.seq) return pa.seq - pb.seq;
    }
  }
  return a < b ? -1 : 1;
}

function getFileMtimeNs(filePath) {
  try {
    return fs.statSync(filePath, { bigint: true }).mtimeNs;
  } catch {
    return 0n;
  }
}

function listEventFiles(eventsDir) {
  let entries;
  try {
    entries = fs.readdirSync(eventsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const files = entries
    .filter(
      (e) =>
        !e.name.startsWith(".") &&
        !isSyncConflictFilename(e.name) &&
        e.isFile() &&
        e.name.endsWith(".md")
    )
    .map((e) => ({
      name: e.name,
      parts: parseEventFilenameParts(e.name),
      mtimeNs: getFileMtimeNs(path.join(eventsDir, e.name)),
    }));

  files.sort((a, b) => {
    if (a.parts && b.parts) {
      if (a.parts.utc !== b.parts.utc) {
        return a.parts.utc < b.parts.utc ? -1 : 1;
      }
      if (a.parts.type === "created" && b.parts.type !== "created") return -1;
      if (b.parts.type === "created" && a.parts.type !== "created") return 1;
      if (
        a.parts.entityId === b.parts.entityId &&
        a.parts.type === b.parts.type &&
        a.parts.seq !== b.parts.seq
      ) {
        return a.parts.seq - b.parts.seq;
      }
      if (a.name.match(/^\d{8}T\d{6}Z-/) && b.name.match(/^\d{8}T\d{6}Z-/) &&
          a.mtimeNs !== b.mtimeNs) {
        return a.mtimeNs < b.mtimeNs ? -1 : 1;
      }
    }
    return compareEventFilenames(a.name, b.name);
  });

  return files.map((f) => f.name);
}

function isEventAfter(eventsDir, candidateName, afterName) {
  if (candidateName === afterName) return false;
  const candParts = parseEventFilenameParts(candidateName);
  const afterParts = parseEventFilenameParts(afterName);
  if (candParts && afterParts) {
    if (candParts.utc !== afterParts.utc) {
      return candParts.utc > afterParts.utc;
    }
    if (candParts.type === "created" && afterParts.type !== "created") {
      return false;
    }
    if (
      candParts.entityId === afterParts.entityId &&
      candParts.type === afterParts.type
    ) {
      return candParts.seq > afterParts.seq;
    }
    if (/^\d{8}T\d{6}Z-/.test(candidateName) && /^\d{8}T\d{6}Z-/.test(afterName)) {
      const candMtime = getFileMtimeNs(path.join(eventsDir, candidateName));
      const afterMtime = getFileMtimeNs(path.join(eventsDir, afterName));
      if (candMtime !== afterMtime) return candMtime > afterMtime;
    }
  }
  return compareEventFilenames(candidateName, afterName) > 0;
}

function readEventFile(eventsDir, filename, includeFullBody = true, eventLines = 5) {
  const raw = fs.readFileSync(path.join(eventsDir, filename), "utf8");
  let data = {};
  let body;
  try {
    ({ data, body } = parseFrontmatter(raw));
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    body = raw.replace(/\r/g, "");
  }
  const lines = body.trim().split("\n");
  return {
    filename,
    type: String(data.type ?? parseEventFilenameParts(filename)?.type ?? "note"),
    entity_id: String(data.entity_id ?? ""),
    timestamp: String(data.timestamp ?? ""),
    body: includeFullBody ? body.trim() : lines.slice(0, eventLines).join("\n"),
    truncated: !includeFullBody && lines.length > eventLines,
    ...checkpointFields(data),
  };
}

function serializeTaskSummary(item, includeEvents = false, eventLines = 5) {
  const events = listEventFiles(item.eventsDir);
  return {
    id: item.task.id,
    title: item.task.title,
    stage: item.stage,
    status: item.task.status,
    priority: item.task.priority,
    tags: item.task.tags,
    owner: item.task.owner,
    assignee: item.task.assignee,
    affinity: item.task.affinity || "",
    claimed_by: item.task.claimed_by,
    parent: item.task.parent,
    depends_on: item.task.depends_on,
    revision: item.task.revision,
    claim_round: item.task.claim_round,
    outcome: item.task.outcome || "",
    last_amend_seen: item.task.last_amend_seen || "",
    instructions_seen: item.task.instructions_seen || "",
    ttl_seconds: item.task.ttl_seconds ?? null,
    state_seq: Number(item.task.state_seq) || 0,
    updated_by: item.task.updated_by,
    updated_at: item.task.updated_at,
    path: item.dir,
    task_path: item.taskPath,
    latest_event: events.length ? readEventFile(item.eventsDir, events.at(-1), includeEvents, eventLines) : null,
  };
}

function checkpointFields(data) {
  return Object.fromEntries(["files_touched", "resources", "pid", "child_pid", "host", "notes",
    "phase", "cmd", "log", "exit_code", "signal", "error", "ac", "proposed_outcome"]
    .filter((key) => Object.hasOwn(data, key)).map((key) => [key, data[key]]));
}

function writeUniqueMarkdown(targetDir, prefix, content, label = "file") {
  fs.mkdirSync(targetDir, { recursive: true });
  for (let seq = 1; seq < 1000; seq += 1) {
    const suffix = seq === 1 ? "" : `-${seq}`;
    const filename = `${prefix}${suffix}.md`;
    const targetPath = path.join(targetDir, filename);
    tmpCounter += 1;
    const tmpPath = path.join(
      targetDir,
      `.${filename}.${process.pid}.${tmpCounter}.tmp`
    );
    try {
      fs.writeFileSync(tmpPath, content, { encoding: "utf8", flag: "wx" });
      try {
        fs.linkSync(tmpPath, targetPath);
      } catch (err) {
        if (!["EXDEV", "ENOTSUP", "EOPNOTSUPP", "EPERM", "ENOSYS"].includes(err.code)) throw err;
        fs.writeFileSync(targetPath, content, { encoding: "utf8", flag: "wx" });
      }
      fs.unlinkSync(tmpPath);
      return { filename, path: targetPath };
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      if (err.code === "EEXIST") continue;
      throw err;
    }
  }
  throw new CliError(`Failed to allocate unique ${label} filename after 1000 attempts.`);
}

function writeUniqueEvent(
  eventsDir,
  entityId,
  eventType,
  body,
  now = new Date(),
  extraFrontmatter = {}
) {
  const compactUtc = formatCompactUtc(now);
  const isoUtc = formatIsoUtc(now);
  const content = formatEventMarkdown(
    {
      type: eventType,
      entity_id: entityId,
      timestamp: isoUtc,
      ...extraFrontmatter,
    },
    body
  );
  const res = writeUniqueMarkdown(
    eventsDir,
    `${compactUtc}-${entityId}-${eventType}`,
    content,
    "event"
  );
  return { ...res, timestamp: isoUtc };
}

function publishTaskState(item, task, body, entityId, eventType, message, now = new Date(), extra = {}) {
  task.affinity ??= "";
  task.outcome ??= "";
  task.last_amend_seen ??= "";
  task.instructions_seen ??= "";
  task.state_seq = (Number(task.state_seq) || 0) + 1;
  const event = writeUniqueEvent(item.eventsDir, entityId, eventType, message, now, {
    ...extra,
    snapshot_version: 1,
    state_keys: Object.keys(task),
    ...task,
  });
  atomicWriteFile(item.taskPath, formatTaskMarkdown(task, body));
  return event;
}

function getRoundClaims(eventsDir, claimRound = 1) {
  const targetRound = Number(claimRound) || 1;
  const eventNames = listEventFiles(eventsDir);
  let lastBoundaryIdx = -1;
  for (let i = 0; i < eventNames.length; i += 1) {
    const parts = parseEventFilenameParts(eventNames[i]);
    if (parts && ["created", "answer", "feedback", "reset", "release"].includes(parts.type)) {
      lastBoundaryIdx = i;
    }
  }
  const claims = [];
  for (let i = 0; i < eventNames.length; i += 1) {
    const name = eventNames[i];
    const parts = parseEventFilenameParts(name);
    if (!parts || parts.type !== "claimed") continue;
    let data = {};
    try {
      ({ data } = parseFrontmatter(fs.readFileSync(path.join(eventsDir, name), "utf8")));
    } catch {
      data = {};
    }
    const hasExplicitRound = data.round !== undefined && data.round !== "";
    if (hasExplicitRound) {
      if (Number(data.round) !== targetRound) continue;
    } else if (i <= lastBoundaryIdx) {
      continue;
    }
    const entityId =
      typeof data.entity_id === "string" && data.entity_id.trim()
        ? data.entity_id.trim()
        : parts.entityId;
    claims.push({
      filename: name,
      utc: parts.utc,
      entityId,
      round: hasExplicitRound ? Number(data.round) : targetRound,
    });
  }
  claims.sort((a, b) => {
    if (a.utc !== b.utc) return a.utc < b.utc ? -1 : 1;
    if (a.entityId !== b.entityId) return a.entityId < b.entityId ? -1 : 1;
    return compareEventFilenames(a.filename, b.filename);
  });
  return { claims, winner: claims[0] || null };
}

function hasCompetingRoundClaim(item, entityId) {
  const claimRound = Number(item.task.claim_round) || 1;
  const { winner } = getRoundClaims(item.eventsDir, claimRound);
  return Boolean(winner && winner.entityId !== entityId);
}

function parseMessageFilenameParts(filename) {
  const m = filename.match(/^(\d{8}T\d{6}(?:\d{3})?Z)-(.+)\.md$/);
  if (!m) return null;
  return { utc: m[1].length === 16 ? m[1].replace("Z", "000Z") : m[1], rest: m[2] };
}

function compareTimestampedPrefixAndSeq(aRest, bRest) {
  if (aRest === bRest) return 0;
  const ma = aRest.match(/^(.+)-(\d+)$/);
  const mb = bRest.match(/^(.+)-(\d+)$/);
  if (ma && ma[1] === bRest) return 1;
  if (mb && mb[1] === aRest) return -1;
  if (ma && mb && ma[1] === mb[1]) {
    return Number.parseInt(ma[2], 10) - Number.parseInt(mb[2], 10);
  }
  return aRest < bRest ? -1 : 1;
}

function compareMessageFilenames(a, b) {
  if (a === b) return 0;
  const pa = parseMessageFilenameParts(a);
  const pb = parseMessageFilenameParts(b);
  if (pa && pb) {
    if (pa.utc !== pb.utc) return pa.utc < pb.utc ? -1 : 1;
    return compareTimestampedPrefixAndSeq(pa.rest, pb.rest);
  }
  return a < b ? -1 : 1;
}

function listMessageFiles(messagesDir) {
  let entries;
  try {
    entries = fs.readdirSync(messagesDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const files = entries
    .filter(
      (e) =>
        !e.name.startsWith(".") &&
        !isSyncConflictFilename(e.name) &&
        e.isFile() &&
        e.name.endsWith(".md")
    )
    .map((e) => ({
      name: e.name,
      parts: parseMessageFilenameParts(e.name),
      mtimeNs: getFileMtimeNs(path.join(messagesDir, e.name)),
    }));

  files.sort((a, b) => {
    if (a.parts && b.parts) {
      if (a.parts.utc !== b.parts.utc) {
        return a.parts.utc < b.parts.utc ? -1 : 1;
      }
      const seqCmp = compareTimestampedPrefixAndSeq(a.parts.rest, b.parts.rest);
      const ma = a.parts.rest.match(/^(.+)-(\d+)$/);
      const mb = b.parts.rest.match(/^(.+)-(\d+)$/);
      if (
        (ma && ma[1] === b.parts.rest) ||
        (mb && mb[1] === a.parts.rest) ||
        (ma && mb && ma[1] === mb[1])
      ) {
        return seqCmp;
      }
      if (/^\d{8}T\d{6}Z-/.test(a.name) && /^\d{8}T\d{6}Z-/.test(b.name) &&
          a.mtimeNs !== b.mtimeNs) {
        return a.mtimeNs < b.mtimeNs ? -1 : 1;
      }
    }
    return compareMessageFilenames(a.name, b.name);
  });
  return files.map((f) => f.name);
}

function isMessageAfter(messagesDir, candidateName, afterName) {
  if (!afterName) return true;
  if (candidateName === afterName) return false;
  const candParts = parseMessageFilenameParts(candidateName);
  const afterParts = parseMessageFilenameParts(afterName);
  if (candParts && afterParts) {
    if (candParts.utc !== afterParts.utc) {
      return candParts.utc > afterParts.utc;
    }
    const ma = candParts.rest.match(/^(.+)-(\d+)$/);
    const mb = afterParts.rest.match(/^(.+)-(\d+)$/);
    if (
      (ma && ma[1] === afterParts.rest) ||
      (mb && mb[1] === candParts.rest) ||
      (ma && mb && ma[1] === mb[1])
    ) {
      return compareTimestampedPrefixAndSeq(candParts.rest, afterParts.rest) > 0;
    }
    if (/^\d{8}T\d{6}Z-/.test(candidateName) && /^\d{8}T\d{6}Z-/.test(afterName)) {
      const candMtime = getFileMtimeNs(path.join(messagesDir, candidateName));
      const afterMtime = getFileMtimeNs(path.join(messagesDir, afterName));
      if (candMtime !== afterMtime) return candMtime > afterMtime;
    }
  }
  return compareMessageFilenames(candidateName, afterName) > 0;
}

function formatMessageMarkdown(data, body) {
  const fm = serializeFrontmatter(data, ["from", "to", "tags", "timestamp"]);
  const trimmedBody = String(body || "").replace(/\r/g, "").trim();
  if (!trimmedBody) return `${fm}\n`;
  return `${fm}\n\n${trimmedBody}\n`;
}

function writeUniqueMessage(messagesDir, fromEntity, toList, tags, slugText, body, now = new Date(), extra = {}) {
  const compactUtc = formatCompactUtc(now);
  const isoUtc = formatIsoUtc(now);
  const slug = slugify(slugText || "msg");
  const content = formatMessageMarkdown(
    {
      from: fromEntity,
      to: toList,
      tags,
      timestamp: isoUtc,
      ...extra,
    },
    body
  );
  const res = writeUniqueMarkdown(
    messagesDir,
    `${compactUtc}-${fromEntity}-${slug}`,
    content,
    "message"
  );
  return { ...res, timestamp: isoUtc };
}

function readMessageFile(msgPath) {
  const filename = path.basename(msgPath);
  const raw = fs.readFileSync(msgPath, "utf8");
  try {
    const { data, body } = parseFrontmatter(raw);
    return {
      filename,
      forced: Boolean(data.forced),
      from: String(data.from ?? ""),
      to: coerceStringList(data.to),
      tags: normalizeTags(coerceStringList(data.tags)),
      timestamp: String(data.timestamp ?? ""),
      body: body.trim(),
    };
  } catch (err) {
    if (err instanceof CliError) {
      return {
        filename,
        from: "",
        to: ["*"],
        tags: [],
        timestamp: "",
        body: raw.replace(/\r/g, "").trim(),
      };
    }
    throw err;
  }
}

function matchesMessage(msg, entityId, workerTags) {
  if (entityId && msg.from === entityId) return false;
  if (msg.to.includes("*")) return true;
  if (entityId && msg.to.includes(entityId)) return true;
  if (msg.tags.length > 0 && workerTags.size > 0) {
    return msg.tags.some((t) => workerTags.has(t));
  }
  return false;
}

function findUnreadMessages(bucketDir, entityId, workerTags, afterMsg) {
  const messagesDir = path.join(bucketDir, "messages");
  const allFiles = listMessageFiles(messagesDir);
  const latestFile = allFiles.length > 0 ? allFiles[allFiles.length - 1] : "";
  const candidateFiles = afterMsg
    ? allFiles.filter((f) => isMessageAfter(messagesDir, f, afterMsg))
    : allFiles;
  const matched = [];
  for (const filename of candidateFiles) {
    try {
      const msg = readMessageFile(path.join(messagesDir, filename));
      if (matchesMessage(msg, entityId, workerTags)) {
        matched.push(msg);
      }
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
  }
  return { matched, latestFile };
}

function formatEntityMarkdown(data, body) {
  const fm = serializeFrontmatter(data, [
    "entity_id",
    "tags",
    "include_untagged",
    "mode",
    "session_nonce",
    "ttl_seconds",
    "last_msg_seen",
    "updated_at",
  ]);
  const trimmedBody = String(body || "").replace(/\r/g, "").trim();
  if (!trimmedBody) return `${fm}\n`;
  return `${fm}\n\n${trimmedBody}\n`;
}

function readEntityFile(bucketDir, entityId) {
  const entityPath = path.join(bucketDir, "entities", `${entityId}.md`);
  let raw;
  try {
    raw = fs.readFileSync(entityPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  try {
    const { data, body } = parseFrontmatter(raw);
    const ttl = Number.parseInt(String(data.ttl_seconds ?? DEFAULT_ENTITY_TTL_SECONDS), 10);
    return {
      entity_id: String(data.entity_id || entityId),
      tags: normalizeTags(coerceStringList(data.tags)),
      include_untagged: Boolean(data.include_untagged),
      mode: String(data.mode ?? ""),
      delivery: data.delivery === "none" || data.delivery === "watch"
        ? data.delivery : data.ended_at || ["once", "one-shot"].includes(String(data.mode)) ? "none" : "watch",
      session_nonce: String(data.session_nonce ?? ""),
      ttl_seconds: Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_ENTITY_TTL_SECONDS,
      last_msg_seen: String(data.last_msg_seen ?? ""),
      owner_task_seen: coerceStringList(data.owner_task_seen),
      stale_task_seen: coerceStringList(data.stale_task_seen),
      dispatcher: String(data.dispatcher ?? ""),
      host: String(data.host ?? ""),
      claimed_task: String(data.claimed_task ?? ""),
      running: data.running && typeof data.running === "object" && !Array.isArray(data.running) ? data.running : null,
      ended_at: String(data.ended_at ?? ""),
      updated_at: String(data.updated_at ?? ""),
      body: body.trim(),
      path: entityPath,
    };
  } catch (err) {
    if (err instanceof CliError) return null;
    throw err;
  }
}

function upsertEntityFile(bucketDir, entityId, updates = {}) {
  const entitiesDir = path.join(bucketDir, "entities");
  fs.mkdirSync(entitiesDir, { recursive: true });
  const entityPath = path.join(entitiesDir, `${entityId}.md`);
  const existing = readEntityFile(bucketDir, entityId);
  warnEntitySession(existing, entityId);
  let initialLastMsgSeen = existing ? existing.last_msg_seen : "";
  if (!existing) {
    const existingMsgs = listMessageFiles(path.join(bucketDir, "messages"));
    if (existingMsgs.length > 0) {
      initialLastMsgSeen = existingMsgs[existingMsgs.length - 1];
    }
  }
  const isoUtc = formatIsoUtc(new Date());
  const nextData = {
    entity_id: entityId,
    tags:
      updates.tags !== undefined
        ? normalizeTags(updates.tags)
        : existing
        ? existing.tags
        : [],
    include_untagged:
      updates.include_untagged !== undefined
        ? Boolean(updates.include_untagged)
        : existing
        ? existing.include_untagged
        : false,
    mode:
      updates.mode !== undefined
        ? String(updates.mode)
        : existing
        ? existing.mode
         : "",
    session_nonce: sessionNonce || existing?.session_nonce || "",
    delivery: updates.delivery ?? existing?.delivery ??
      (["once", "one-shot"].includes(updates.mode) ? "none" : "watch"),
    ttl_seconds:
      updates.ttl_seconds !== undefined
        ? updates.ttl_seconds
        : existing
        ? existing.ttl_seconds
        : readBucketConfig(bucketDir).default_ttl_seconds,
    last_msg_seen:
      updates.last_msg_seen !== undefined
        ? String(updates.last_msg_seen)
        : initialLastMsgSeen,
    owner_task_seen: updates.owner_task_seen ?? existing?.owner_task_seen ?? [],
    stale_task_seen: updates.stale_task_seen ?? existing?.stale_task_seen ?? [],
    dispatcher: updates.dispatcher ?? existing?.dispatcher ?? "",
    host: updates.host ?? existing?.host ?? "",
    claimed_task: updates.claimed_task ?? existing?.claimed_task ?? "",
    running: updates.running !== undefined ? updates.running : existing?.running ?? "",
    ended_at: updates.ended_at ?? existing?.ended_at ?? "",
    updated_at: isoUtc,
  };
  for (const key of ["owner_task_seen", "stale_task_seen"]) {
    nextData[key] = nextData[key].filter((cursor) => {
      try {
        const task = findTask(bucketDir, cursor.split("/")[0]);
        return !task || !TERMINAL_STATUSES.has(task.task.status);
      } catch (err) {
        if (err instanceof CliError) return true;
        throw err;
      }
    });
  }
  const nextBody =
    updates.body !== undefined ? updates.body : existing ? existing.body : "";
  atomicWriteFile(entityPath, formatEntityMarkdown(nextData, nextBody));
  return { ...nextData, body: String(nextBody || "").trim(), path: entityPath };
}

function warnEntitySession(existing, entityId) {
  if (!sessionNonce || !existing?.session_nonce || existing.session_nonce === sessionNonce ||
      warnedEntitySessions.has(entityId)) return;
  const timestamp = Date.parse(existing.updated_at);
  const updatedMs = Number.isFinite(timestamp) ? timestamp : fs.statSync(existing.path).mtimeMs;
  if (Date.now() - updatedMs > existing.ttl_seconds * 1000) return;
  console.error(`Warning: entity "${entityId}" has a different live session nonce; concurrent writers may share this id.`);
  warnedEntitySessions.add(entityId);
}

function useEntitySession(bucketDir, entityId, values) {
  sessionNonce = values["session-nonce"] ?? process.env.WB_SESSION_NONCE ?? "";
  warnEntitySession(readEntityFile(bucketDir, entityId), entityId);
}

function touchExistingEntity(bucketDir, entityId) {
  if (readEntityFile(bucketDir, entityId)) {
    upsertEntityFile(bucketDir, entityId);
  }
}

function listEntities(bucketDir) {
  const entitiesDir = path.join(bucketDir, "entities");
  try {
    fs.statSync(entitiesDir);
  } catch {
    return [];
  }
  let entries;
  try {
    entries = fs.readdirSync(entitiesDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const nowMs = Date.now();
  const out = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || !entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const entityId = entry.name.slice(0, -3);
    const info = readEntityFile(bucketDir, entityId);
    if (!info) continue;
    let updatedMs = Date.parse(info.updated_at);
    if (!Number.isFinite(updatedMs)) {
      try {
        updatedMs = fs.statSync(info.path).mtimeMs;
      } catch {
        updatedMs = 0;
      }
    }
    const ageSec = Math.max(0, Math.round((nowMs - updatedMs) / 1000));
    const online = !info.ended_at && ageSec <= info.ttl_seconds;
    out.push({
      ...info,
      age_seconds: ageSec,
      state: info.ended_at ? "ended" : online ? "online" : "stale",
      online,
    });
  }
  out.sort((a, b) => a.entity_id.localeCompare(b.entity_id));
  return out;
}

function formatTagMarkdown(data, body) {
  const fm = serializeFrontmatter(data, ["tag", "updated_by", "updated_at"]);
  const trimmedBody = String(body || "").replace(/\r/g, "").trim();
  if (!trimmedBody) return `${fm}\n`;
  return `${fm}\n\n${trimmedBody}\n`;
}

function readTagDoc(tagPath, tagName) {
  const raw = fs.readFileSync(tagPath, "utf8");
  try {
    const { data, body } = parseFrontmatter(raw);
    return {
      tag: String(data.tag || tagName).trim().toLowerCase(),
      updated_by: String(data.updated_by ?? ""),
      updated_at: String(data.updated_at ?? ""),
      description: body.trim(),
    };
  } catch (err) {
    if (err instanceof CliError) {
      return {
        tag: tagName,
        updated_by: "",
        updated_at: "",
        description: raw.replace(/\r/g, "").trim(),
      };
    }
    throw err;
  }
}

function listTagsInfo(bucketDir) {
  const tagsDir = path.join(bucketDir, "tags");
  try {
    fs.statSync(tagsDir);
  } catch {
    // ignore
  }
  const map = new Map();
  const ensureEntry = (name) => {
    const key = String(name).trim().toLowerCase();
    if (!key) return null;
    if (!map.has(key)) {
      map.set(key, {
        tag: key,
        documented: false,
        description: "",
        updated_by: "",
        updated_at: "",
        entities: [],
        online_entities: [],
        task_count: 0,
      });
    }
    return map.get(key);
  };

  try {
    const entries = fs.readdirSync(tagsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || !entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      const tagName = entry.name.slice(0, -3).toLowerCase();
      const doc = readTagDoc(path.join(tagsDir, entry.name), tagName);
      const item = ensureEntry(doc.tag);
      if (item) {
        item.documented = true;
        item.description = doc.description;
        item.updated_by = doc.updated_by;
        item.updated_at = doc.updated_at;
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  for (const ent of listEntities(bucketDir)) {
    for (const t of ent.tags) {
      const item = ensureEntry(t);
      if (item) {
        item.entities.push(ent.entity_id);
        if (ent.online) item.online_entities.push(ent.entity_id);
      }
    }
  }

  const { tasks } = scanAllTasks(bucketDir);
  for (const taskItem of tasks.filter(
    (t) => t.task.status !== "complete" && t.task.status !== "cancelled"
  )) {
    for (const t of taskItem.task.tags || []) {
      const item = ensureEntry(t);
      if (item) item.task_count += 1;
    }
  }

  return Array.from(map.values()).sort((a, b) => a.tag.localeCompare(b.tag));
}

function matchesTags(task, entityId, workerTags, includeUntagged) {
  if (task.assignee && task.assignee === entityId) {
    return true;
  }
  if (task.assignee && task.assignee !== entityId) {
    return false;
  }
  if (workerTags.size === 0) {
    return true;
  }
  const taskTags = normalizeTags(task.tags || []);
  if (taskTags.length === 0) {
    return Boolean(includeUntagged);
  }
  return taskTags.some((t) => workerTags.has(t));
}

function findOwnerActionableTasks(bucketDir, entityId, allActionable = false) {
  const seen = new Map((readEntityFile(bucketDir, entityId)?.owner_task_seen ?? [])
    .map((cursor) => cursor.split("/")));
  return listTasks(bucketDir)
    .filter(
      (item) =>
        item.task.owner === entityId &&
        (item.task.status === "blocked" || item.task.status === "review") &&
        (allActionable || listEventFiles(item.eventsDir).some((filename) =>
          !seen.has(item.task.id) || isEventAfter(item.eventsDir, filename, seen.get(item.task.id))))
    )
    .sort(sortByPriorityAndAge);
}

function ageSeconds(timestamp, fallback = 0) {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? Math.max(0, (Date.now() - parsed) / 1000) : fallback;
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === "ESRCH" ? false : null; }
}

function pendingSince(item) {
  const events = listEventFiles(item.eventsDir);
  let timestamp = item.task.updated_at;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    try {
      const { data } = parseFrontmatter(fs.readFileSync(path.join(item.eventsDir, events[i]), "utf8"));
      if (data.snapshot_version !== 1) continue;
      if (data.status !== "pending") break;
      timestamp = data.timestamp;
    } catch (err) {
      if (err.code !== "ENOENT" && !(err instanceof CliError)) throw err;
    }
  }
  return timestamp;
}

function taskAlerts(bucketDir, item, byId, config = readBucketConfig(bucketDir)) {
  const task = item.task;
  const alerts = [];
  if (task.status === "in-progress" && task.claimed_by) {
    const entity = readEntityFile(bucketDir, task.claimed_by);
    const ttl = positiveSeconds(task.ttl_seconds, "task ttl_seconds") ?? entity?.ttl_seconds ?? config.default_ttl_seconds;
    const timestamp = entity?.updated_at || task.updated_at;
    const age = ageSeconds(timestamp, Infinity);
    const running = entity?.running;
    const dead = running?.host === os.hostname() && (!running.task || running.task === task.id) &&
      pidAlive(running.pid) === false;
    const level = dead || entity?.ended_at || age > ttl * config.abandoned_ttl_multiplier
      ? "abandoned" : age > ttl ? "stale" : null;
    if (level) alerts.push({
      type: level,
      heartbeat: { entity_id: task.claimed_by, updated_at: timestamp, ttl_seconds: ttl,
        age_seconds: Number.isFinite(age) ? Math.floor(age) : null, missing: !entity },
      reason: dead ? "wrapper_pid_gone" : entity?.ended_at ? "entity_ended" : "heartbeat",
    });
  }
  if (task.status === "pending" && !task.claimed_by) {
    const age = ageSeconds(pendingSince(item));
    if (task.assignee) {
      const entity = readEntityFile(bucketDir, task.assignee);
      if (age > config.pinned_idle_seconds && (!entity || entity.ended_at ||
          ageSeconds(entity.updated_at, Infinity) > entity.ttl_seconds * 2)) {
        alerts.push({ type: "pinned_idle", assignee: task.assignee, age_seconds: Math.floor(age) });
      }
    } else if (!fs.existsSync(path.join(bucketDir, "PAUSED")) && age > config.unclaimed_seconds &&
        dependenciesSatisfied(task, byId) && !getRoundClaims(item.eventsDir, task.claim_round).winner) {
      alerts.push({ type: "unclaimed", age_seconds: Math.floor(age) });
    }
  }
  return alerts;
}

function alertCursor(item, alert) {
  return `${item.task.id}/${item.task.claim_round}/${item.task.claimed_by || item.task.assignee}/${alert.type}/${alert.heartbeat?.updated_at || pendingSince(item)}/${alert.reason || ""}`;
}

function findOwnerAlerts(bucketDir, entityId) {
  const seen = new Set(readEntityFile(bucketDir, entityId)?.stale_task_seen ?? []);
  const { tasks, byId } = scanAllTasks(bucketDir);
  const config = readBucketConfig(bucketDir);
  return tasks.filter((item) => item.task.owner === entityId)
    .sort(sortByPriorityAndAge).flatMap((item) => taskAlerts(bucketDir, item, byId, config)
      .filter((alert) => !seen.has(alertCursor(item, alert)))
      .map((alert) => ({ ...item, alert, alert_cursor: alertCursor(item, alert) })));
}

function unreadTaskInstructions(item) {
  const files = listEventFiles(item.eventsDir);
  const previousClaim = item.task.claim_round > 1
    ? getRoundClaims(item.eventsDir, item.task.claim_round - 1).winner?.filename
    : null;
  return files.filter((filename) => {
    const type = parseEventFilenameParts(filename)?.type;
    if (type === "amend") {
      return !item.task.last_amend_seen || isEventAfter(item.eventsDir, filename, item.task.last_amend_seen);
    }
    return type === "feedback" && (!previousClaim || isEventAfter(item.eventsDir, filename, previousClaim));
  }).map((filename) => readEventFile(item.eventsDir, filename));
}

function dependenciesSatisfied(task, byId) {
  for (const depId of task.depends_on || []) {
    const dep = byId.get(depId);
    if (!dep || dep.task.status !== "complete") {
      return false;
    }
  }
  return true;
}

function sortByPriorityAndAge(a, b) {
  const pa = PRIORITY_RANK[a.task.priority] ?? 2;
  const pb = PRIORITY_RANK[b.task.priority] ?? 2;
  if (pa !== pb) return pa - pb;
  const ida = a.task.id || a.dirName;
  const idb = b.task.id || b.dirName;
  if (ida === idb) return 0;
  return ida < idb ? -1 : 1;
}

function findEligibleTasks(bucketDir, entityId, workerTags, includeUntagged, includeOwnClaim = false) {
  const { tasks, byId } = scanAllTasks(bucketDir);
  const available = tasks.filter((item) => {
    if (item.task.status !== "pending" || item.task.claimed_by !== "") return false;
    const { winner } = getRoundClaims(item.eventsDir, item.task.claim_round);
    return !winner || (includeOwnClaim && winner.entityId === entityId);
  });

  const assignedToMe = available
    .filter(
      (item) =>
        item.task.status === "pending" &&
        item.task.claimed_by === "" &&
        assignedToEntity(item.task, entityId, bucketDir) &&
        dependenciesSatisfied(item.task, byId)
    )
    .sort(sortByPriorityAndAge);

  const openPool = available
    .filter(
      (item) =>
        item.task.status === "pending" &&
        item.task.claimed_by === "" &&
        item.task.assignee === "" &&
        matchesTags(item.task, entityId, workerTags, includeUntagged) &&
        dependenciesSatisfied(item.task, byId)
    )
    .sort(sortByPriorityAndAge);

  return [...assignedToMe, ...openPool];
}

function getActiveWipTasks(bucketDir, entityId) {
  return listTasks(bucketDir).filter(
    (item) =>
      item.task.status === "in-progress" && item.task.claimed_by === entityId
  );
}

function readBodyInput(values) {
  if (values["body-file"]) {
    return fs.readFileSync(values["body-file"], "utf8");
  }
  if (values.stdin) {
    return fs.readFileSync(0, "utf8");
  }
  if (typeof values.message === "string") {
    return values.message;
  }
  return "";
}

function readStandingInstructions(bucketDir, task) {
  const instructions = [];
  const bucketPath = path.join(bucketDir, "INSTRUCTIONS.md");
  if (fs.existsSync(bucketPath)) {
    const raw = fs.readFileSync(bucketPath, "utf8").replace(/\r/g, "");
    instructions.push({ file: "INSTRUCTIONS.md", body: (raw.split("\n")[0].trim() === "---" ? parseFrontmatter(raw).body : raw).trim() });
  }
  for (const tag of task.tags) {
    if (tag.startsWith(".") || /[/\\]/.test(tag) || tag.includes("..")) continue;
    const tagPath = path.join(bucketDir, "tags", `${tag}.md`);
    if (fs.existsSync(tagPath)) {
      instructions.push({ file: `tags/${tag}.md`, body: readTagDoc(tagPath, tag).description });
    }
  }
  return instructions.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
}

function instructionVersion(bucketDir, task) {
  const instructions = readStandingInstructions(bucketDir, task);
  const content = Object.fromEntries(instructions.map(({ file, body }) => [file, body]));
  const hash = createHash("sha256").update(JSON.stringify(instructions.map(({ body }) => body))).digest("hex");
  return { instructions, content, hash };
}

function assertInstructionsAcknowledged(bucketDir, item) {
  const current = instructionVersion(bucketDir, item.task);
  if (item.task.instructions_seen === current.hash ||
      (!item.task.instructions_seen && item.task.status !== "in-progress" && !current.instructions.length)) return;
  const action = item.task.status === "in-progress"
    ? `run ack-instructions --task ${item.task.id}, read the diff and apply it`
    : ["draft", "ready"].includes(item.task.status) ? "promote to pending, then claim to read the current rules"
    : item.task.status === "review" ? "use owner feedback, then claim to read the current rules"
    : item.task.status === "blocked" ? "use owner answer, then claim to read the current rules"
    : "claim to read the current rules";
  throw new CliError(`Standing instructions need acknowledgement; ${action}.`);
}

function instructionDiff(item, current) {
  let previous = {};
  let known = !item.task.instructions_seen;
  for (const filename of listEventFiles(item.eventsDir)) {
    let data;
    try { ({ data } = parseFrontmatter(fs.readFileSync(path.join(item.eventsDir, filename), "utf8"))); }
    catch (err) { if (err instanceof CliError) continue; throw err; }
    if (data.instructions_hash === item.task.instructions_seen && data.instruction_content &&
        typeof data.instruction_content === "object" && !Array.isArray(data.instruction_content)) {
      previous = data.instruction_content;
      known = true;
      break;
    }
  }
  const lines = known ? [] : ["Previous instruction content unavailable; current bodies follow."];
  for (const file of [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort()) {
    if (previous[file] === current[file]) continue;
    const before = previous[file] ? String(previous[file]).split("\n") : [];
    const after = current[file] ? current[file].split("\n") : [];
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
    let oldEnd = before.length;
    let newEnd = after.length;
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
      oldEnd -= 1;
      newEnd -= 1;
    }
    lines.push(`--- ${file}`, `+++ ${file}`, `@@ line ${start + 1} @@`,
      ...before.slice(start, oldEnd).map((line) => `-${line}`),
      ...after.slice(start, newEnd).map((line) => `+${line}`));
  }
  return lines.join("\n");
}

function cmdCreate(argv) {
  const { values } = parseCommand("create", argv);

  if (values.help) {
    printCreateHelp();
    return 0;
  }

  const bucketDir = path.resolve(values.bucket || "");
  if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
  const entityId = validateIdentifier(values.entity, "--entity");
  useEntitySession(bucketDir, entityId, values);
  if (!values.title || !values.title.trim()) {
    throw new CliError("Missing required --title <text>.");
  }
  assertTransition("create", null, entityId);
  const priority = String(values.priority || "medium").toLowerCase();
  if (!VALID_PRIORITIES.has(priority)) {
    throw new CliError(
      `Invalid --priority "${priority}". Must be one of: low, medium, high, critical.`
    );
  }
  const requestedBacklog = Boolean(values.backlog || values.draft);
  const initialStatus = values.status
    ? String(values.status).toLowerCase()
    : requestedBacklog
    ? "draft"
    : "pending";
  if (!["draft", "ready", "pending"].includes(initialStatus)) {
    throw new CliError(
      `Invalid initial --status "${initialStatus}". Must be one of: draft, ready, pending.`
    );
  }
  if (requestedBacklog && initialStatus === "pending") {
    throw new CliError("--backlog/--draft cannot be combined with --status pending.");
  }

  validateAssignee(bucketDir, values.assignee);
  const taskTtl = positiveSeconds(values["ttl-seconds"], "--ttl-seconds");
  if (values.parent) validateTaskId(values.parent);

  const tags = normalizeTags(parseListFlags(values.tag));
  const dependsOn = parseListFlags(values["depends-on"]);
  for (const dep of dependsOn) validateTaskId(dep);

  ensureBucketDirs(bucketDir);
  const now = new Date();
  const compactUtc = formatCompactUtc(now).replace(/\d{3}Z$/, "Z");
  const isoUtc = formatIsoUtc(now);
  const baseSlug = slugify(values.slug || values.title);

  let taskId = null;
  let taskDir = null;
  const tasksRoot = path.join(bucketDir, "tasks");
  for (let seq = 1; seq < 1000; seq += 1) {
    const candidate = `${compactUtc}-${baseSlug}${seq === 1 ? "" : `-${seq}`}`;
    const candidateDir = path.join(tasksRoot, candidate);
    if (fs.existsSync(candidateDir)) continue;
    try {
      fs.mkdirSync(candidateDir, { recursive: false });
      taskId = candidate;
      taskDir = candidateDir;
      break;
    } catch (err) {
      if (err.code === "EEXIST") continue;
      throw err;
    }
  }
  if (!taskId || !taskDir) {
    throw new CliError("Failed to create unique task directory.");
  }

  const eventsDir = path.join(taskDir, "events");
  fs.mkdirSync(eventsDir, { recursive: true });
  let body;
  const explicitBody = readBodyInput(values);
  if (explicitBody) {
    body = `\n${explicitBody.replace(/\r/g, "").replace(/^\n+/, "")}`;
    if (!body.endsWith("\n")) body += "\n";
  } else {
    const fileList = parseListFlags(values.files)
      .map((f) => `\`${f}\``)
      .join(", ");
    const acLines =
      values.ac && values.ac.length > 0
        ? parseListFlags(values.ac).map((c, idx) => `- [ ] #${idx + 1} ${c}`).join("\n")
        : "- [ ] #1 Verification command passes.";
    body = [
      "",
      "## Context & Target",
      `- **Workspace:** ${values.workspace ? `\`${values.workspace}\`` : "(specify workspace)"}`,
      `- **Relevant Files:** ${fileList || "(specify files)"}`,
      "",
      "## Description",
      values.description ? values.description.trim() : values.title.trim(),
      "",
      "## Acceptance Criteria",
      acLines,
      "",
    ].join("\n");
  }

  const taskData = {
    id: taskId,
    title: values.title.trim(),
    status: initialStatus,
    priority,
    tags,
    owner: entityId,
    claimed_by: "",
    claim_round: 1,
    assignee: values.assignee || "",
    affinity: "",
    parent: values.parent || "",
    depends_on: dependsOn,
    revision: 1,
    updated_by: entityId,
    updated_at: isoUtc,
    outcome: "",
    last_amend_seen: "",
    instructions_seen: "",
    ...(taskTtl !== undefined ? { ttl_seconds: taskTtl } : {}),
  };

  const taskPath = path.join(taskDir, "task.md");
  const createdEvent = publishTaskState(
    { eventsDir, taskPath }, taskData, body, entityId, "created",
    `Task created: ${values.title.trim()}`, now
  );
  touchExistingEntity(bucketDir, entityId);

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          ...serializeTaskSummary({ stage: "tasks", task: taskData, dir: taskDir, taskPath, eventsDir }),
          created_event: createdEvent.filename,
        },
        null,
        2
      )
    );
  } else {
    console.log(`Created ${taskId} in ${taskDir} (status=${initialStatus})`);
    console.log(`Event: ${createdEvent.filename}`);
  }
  return 0;
}

async function cmdClaim(argv) {
  const { values } = parseCommand("claim", argv);

  if (values.help) {
    printClaimHelp();
    return 0;
  }

  if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
  const bucketDir = path.resolve(values.bucket);
  const entityId = validateIdentifier(values.entity, "--entity");
  useEntitySession(bucketDir, entityId, values);
  const settleMs = readBucketConfig(bucketDir).claim_settle_ms;
  const workerTags = new Set(normalizeTags(parseListFlags(values.tag)));
  const includeUntagged = Boolean(values["include-untagged"]);

  ensureBucketDirs(bucketDir);

  if (fs.existsSync(path.join(bucketDir, "PAUSED"))) {
    throw new CliError("Bucket is paused (PAUSED exists); no tasks may be claimed.", 4);
  }

  const wip = getActiveWipTasks(bucketDir, entityId);
  if (wip.length > 0) {
    throw new CliError(
      `WIP limit reached: "${entityId}" already has in-progress task "${wip[0].task.id}".`,
      2
    );
  }

  const existing = readEntityFile(bucketDir, entityId);
  const dispatcher = values.dispatcher ?? process.env.WB_DISPATCHER ?? existing?.dispatcher ?? "";
  if (dispatcher) validateIdentifier(dispatcher, "--dispatcher");
  if (dispatcher === entityId) throw new CliError("An entity cannot be its own dispatcher.");
  if (existing && dispatcher !== existing.dispatcher && !existing.ended_at &&
      ageSeconds(existing.updated_at, Infinity) <= existing.ttl_seconds) {
    throw new CliError("Cannot change the recorded dispatcher of a live identity; use a fresh entity ID.", 3);
  }
  upsertEntityFile(bucketDir, entityId, {
    mode: existing?.mode || "once", dispatcher, host: os.hostname(),
    delivery: existing?.delivery || "none",
    tags: Array.from(workerTags), include_untagged: includeUntagged,
    ttl_seconds: readBucketConfig(bucketDir).default_ttl_seconds, ended_at: "",
    ...(existing?.ended_at || (existing?.running?.host === os.hostname() && pidAlive(existing.running.pid) === false)
      ? { running: "" } : {}),
  });

  const { byId } = scanAllTasks(bucketDir);
  let candidates;
  if (values.task) {
    validateTaskId(values.task);
    const found = byId.get(values.task);
    if (!found) {
      throw new CliError(`Task "${values.task}" not found.`);
    }
    assertTransition("claim", found, entityId, { bucketDir, workerTags, includeUntagged, byId });
    candidates = [found];
  } else {
    candidates = findEligibleTasks(bucketDir, entityId, workerTags, includeUntagged, true);
    if (candidates.length === 0) {
      throw new CliError(`No eligible tasks available for "${entityId}".`, 2);
    }
  }

  let claimedEntry = null;
  let claimedEvent = null;
  let finalTask = null;
  let finalInstructions = [];

  for (const candidate of candidates) {
    let preTask;
    try {
      ({ task: preTask } = readTaskFile(candidate.taskPath));
    } catch {
      continue;
    }
    if (preTask.status !== "pending" || preTask.claimed_by !== "") {
      continue;
    }
    if (!canClaim({ ...candidate, task: preTask }, entityId, workerTags, includeUntagged, byId, bucketDir)) continue;
    assertTransition("claim", { ...candidate, task: preTask }, entityId, { bucketDir, workerTags, includeUntagged, byId });

    const claimRound = Number(preTask.claim_round) || 1;
    const { winner: preWinner } = getRoundClaims(candidate.eventsDir, claimRound);
    if (preWinner && preWinner.entityId !== entityId) {
      continue;
    }

    let myClaimEvent;
    if (preWinner && preWinner.entityId === entityId) {
      myClaimEvent = { filename: preWinner.filename };
    } else {
      myClaimEvent = writeUniqueEvent(
        candidate.eventsDir,
        entityId,
        "claimed",
        `Claimed by ${entityId} (round ${claimRound}).`,
        new Date(),
        { round: claimRound }
      );
    }

    await new Promise((resolve) => setTimeout(resolve, settleMs));

    let postTask;
    let postBody;
    try {
      ({ task: postTask, body: postBody } = readTaskFile(candidate.taskPath));
    } catch {
      continue;
    }
    if (
      postTask.status !== "pending" &&
      !(postTask.status === "in-progress" && postTask.claimed_by === entityId)
    ) {
      continue;
    }
    if ((Number(postTask.claim_round) || 1) !== claimRound) {
      continue;
    }

    const { winner } = getRoundClaims(candidate.eventsDir, claimRound);
    if (!winner || winner.entityId !== entityId) {
      continue;
    }

    if (fs.existsSync(path.join(bucketDir, "PAUSED"))) {
      throw new CliError("Bucket was paused during claim; task remains pending.", 4);
    }
    assertTransition("claim", { ...candidate, task: postTask }, entityId, {
      bucketDir, workerTags, includeUntagged, byId: scanAllTasks(bucketDir).byId,
    });

    postTask.status = "in-progress";
    postTask.claimed_by = entityId;
    postTask.claim_round = claimRound;
    postTask.updated_by = entityId;
    postTask.updated_at = formatIsoUtc(new Date());
    const version = instructionVersion(bucketDir, postTask);
    postTask.instructions_seen = version.hash;
    publishTaskState(candidate, postTask, postBody, entityId, "claim-committed",
      `Claim election won by ${entityId} (round ${claimRound}).`, new Date(),
      { claim_event: myClaimEvent.filename, round: claimRound,
        instructions_hash: version.hash, instruction_content: version.content });

    claimedEntry = candidate;
    claimedEvent = myClaimEvent;
    finalTask = postTask;
    finalInstructions = version.instructions;
    break;
  }

  if (!claimedEntry || !finalTask) {
    throw new CliError("Lost claim race; no remaining eligible tasks.", 3);
  }

  upsertEntityFile(bucketDir, entityId, { claimed_task: finalTask.id });

  const events = listEventFiles(claimedEntry.eventsDir);
  const lastEventSeen = events.length > 0 ? events[events.length - 1] : claimedEvent.filename;

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          ...serializeTaskSummary({ ...claimedEntry, task: finalTask }),
          claimed_event: claimedEvent.filename,
          last_event_seen: lastEventSeen,
          events,
          instructions: finalInstructions,
          unread_events: unreadTaskInstructions({ ...claimedEntry, task: finalTask }),
        },
        null,
        2
      )
    );
  } else {
    console.log(`Claimed ${finalTask.id} (${claimedEntry.dir})`);
    console.log(`Title: ${finalTask.title}`);
    console.log(`Priority: ${finalTask.priority} | Tags: ${JSON.stringify(finalTask.tags)}`);
    console.log(`Claimed Event: ${claimedEvent.filename}`);
    console.log(`last_event_seen: ${lastEventSeen}`);
  }
  return 0;
}

function cmdTransition(command, argv) {
  const { values } = parseCommand(command, argv);
  if (values.help) {
    printCommandHelp(command);
    return 0;
  }

  if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
  const bucketDir = path.resolve(values.bucket);
  const entityId = validateIdentifier(values.entity, "--entity");
  useEntitySession(bucketDir, entityId, values);
  let payload;
  if (command === "amend" && values["all-in-progress"]) {
    if (values.task) throw new CliError("Use --task or --all-in-progress, not both.");
    if (values.assignee !== undefined || values["ttl-seconds"] !== undefined ||
        values["add-depends-on"] || values["remove-depends-on"]) {
      throw new CliError("Bulk amendments accept body corrections, not metadata changes.");
    }
    if (values.owner !== undefined && values.owner !== entityId) {
      throw new CliError("Bulk amendments require the caller's ownership.", 3);
    }
    const tags = normalizeTags(parseListFlags(values.tag));
    const tasks = listTasks(bucketDir).filter((item) => item.task.status === "in-progress" &&
      item.task.owner === entityId && (!tags.length || item.task.tags.some((tag) => tags.includes(tag))));
    for (const item of tasks) assertTransition("amend", item, entityId, { bucketDir });
    const message = readBodyInput(values);
    const results = [];
    for (const item of tasks) {
      try {
        results.push(transitionTask(command, { ...values, task: item.task.id, message, stdin: false, "body-file": undefined }, bucketDir, entityId));
      } catch (err) {
        throw new CliError(`Bulk amend stopped at task "${item.task.id}"; completed task IDs: ${results.map((result) => result.id).join(", ") || "none"}. Inspect the stopped task's events before retrying. ${err.message}`,
          err instanceof CliError ? err.exitCode : 1);
      }
    }
    payload = { count: results.length, tasks: results };
  } else {
    if (command === "amend" && (values.owner !== undefined || values.tag)) {
      throw new CliError("--owner/--tag require --all-in-progress.");
    }
    payload = transitionTask(command, values, bucketDir, entityId);
  }
  if (values.json) console.log(JSON.stringify(payload, null, 2));
  else if (payload.tasks) {
    for (const item of payload.tasks) console.log(`Posted ${item.event} to ${item.id}`);
    console.log(`Amended ${payload.count} tasks.`);
  } else {
    if (payload.instruction_diff) console.log(payload.instruction_diff);
    console.log(payload.event ? `Posted ${payload.event} to ${payload.id}` : `Instructions unchanged for ${payload.id}.`);
    if (payload.task_updated) {
      console.log(`State: status=${payload.status} revision=${payload.previous_revision}->${payload.revision} claim_round=${payload.previous_claim_round}->${payload.claim_round}`);
    }
  }
  return 0;
}

function transitionTask(command, values, bucketDir, entityId) {
  const taskId = validateTaskId(values.task);
  const intent = command === "post" ? values.type || "log" : command;
  if (command === "post" && !["log", "note"].includes(intent)) {
    throw new CliError('post only accepts --type log|note; use an intent command. Run "wb.mjs post --help".');
  }

  ensureBucketDirs(bucketDir);
  const found = findTask(bucketDir, taskId);
  if (!found) {
    throw new CliError(`Task "${taskId}" not found.`);
  }
  const addDeps = parseListFlags(values["add-depends-on"]);
  const removeDeps = new Set(parseListFlags(values["remove-depends-on"]));
  const taskTtl = positiveSeconds(values["ttl-seconds"], "--ttl-seconds");
  const metadataChange = values.assignee !== undefined || taskTtl !== undefined || addDeps.length > 0 || removeDeps.size > 0;
  const rule = assertTransition(intent, found, entityId, { bucketDir, targetStatus: values.status, metadataChange });
  const previousClaimant = (found.task.status === "in-progress"
    ? getRoundClaims(found.eventsDir, found.task.claim_round).winner?.entityId : null) || found.task.claimed_by;
  const eventType = rule.event || intent;
  const targetStatus = values.status ?? rule.to;
  if (values.outcome !== undefined && !["pass", "partial", "fail", "abandoned"].includes(values.outcome)) {
    throw new CliError("--outcome must be pass|partial|fail|abandoned.");
  }
  if (["review", "question"].includes(intent)) {
    const pending = unreadTaskInstructions(found).filter((event) => event.type === "amend");
    if (pending.length) throw new CliError(`Unaccepted amendments: ${pending.map((event) => event.filename).join(", ")}; run accept-amends --task ${taskId}.`);
    assertInstructionsAcknowledged(bucketDir, found);
  }
  const acceptedAmends = intent === "accept-amends"
    ? unreadTaskInstructions(found).filter((event) => event.type === "amend")
    : [];
  if (intent === "accept-amends" && acceptedAmends.length === 0) {
    throw new CliError("No unaccepted amend events.");
  }
  const ignoredFiles = new Set(parseListFlags(values["ignore-amend"]));
  if (ignoredFiles.size && !values.reason?.trim()) throw new CliError("--ignore-amend requires --reason.");
  if (values.reason !== undefined && !ignoredFiles.size) throw new CliError("--reason requires --ignore-amend.");
  for (const filename of ignoredFiles) {
    if (!acceptedAmends.some((event) => event.filename === filename)) throw new CliError(`Not an outstanding amend: ${filename}.`);
  }
  let instructionExtra = {};
  let instructionOutput = {};
  if (intent === "ack-instructions") {
    const version = instructionVersion(bucketDir, found.task);
    const diff = instructionDiff(found, version.content);
    instructionOutput = { instruction_diff: diff, instructions: version.instructions };
    if (found.task.instructions_seen === version.hash) {
      return { ...serializeTaskSummary(found), event: null, task_updated: false,
        previous_revision: found.task.revision, previous_claim_round: found.task.claim_round, ...instructionOutput };
    }
    instructionExtra = { instructions_hash: version.hash, instruction_content: version.content };
  }

  for (const dep of [...addDeps, ...removeDeps]) validateTaskId(dep);
  validateAssignee(bucketDir, values.assignee);
  let reviewExtra = {};
  if (intent === "review") {
    const verdicts = parseAcVerdicts(values);
    validateReviewVerdicts(found.body, verdicts, values["proposed-outcome"]);
    const sorted = [...verdicts.entries()].sort((a, b) => a[0] - b[0]);
    reviewExtra = {
      ac: sorted.map(([n, v]) => `${n}:${v}`),
      proposed_outcome: values["proposed-outcome"],
    };
  }
  let acceptVerdicts = null;
  let acceptProposed = null;
  let acceptDerived = null;
  if (intent === "complete" && values["accept-ac"]) {
    const latest = latestReviewVerdicts(found.eventsDir, found.task.claim_round);
    if (!latest) throw new CliError("complete --accept-ac requires a valid current-round review.");
    validateReviewVerdicts(found.body, latest.verdicts, latest.proposed);
    acceptVerdicts = latest.verdicts;
    acceptProposed = latest.proposed;
    const derived = derivedOutcome(acceptVerdicts);
    if (values.outcome === undefined && acceptProposed !== derived) {
      throw new CliError(`Proposed outcome "${acceptProposed}" differs from derived outcome "${derived}"; confirm or override with --outcome.`);
    }
    if (values.outcome === undefined) acceptDerived = derived;
  }
  const checkpoint = ["checkpoint", "release"].includes(intent) ? checkpointManifest(values) : {};
  const mutatesTaskMd = Boolean(targetStatus || metadataChange || acceptedAmends.length || acceptVerdicts || intent === "ack-instructions");

  const now = new Date();
  const isoUtc = formatIsoUtc(now);
  const message = [
    readBodyInput(values),
    ...(acceptedAmends.length ? [`Amendment receipts:\n${acceptedAmends.map((event) =>
      `- ${event.filename}: ${ignoredFiles.has(event.filename) ? `ignored (${values.reason.trim()})` : "accepted"}`).join("\n")}`] : []),
  ].filter(Boolean).join("\n\n");
  if (eventType === "amend" && ["review", "blocked"].includes(found.task.status)) {
    console.error(`Warning: task "${taskId}" is ${found.task.status}; amend does not reopen it. Use feedback/answer to resume execution.`);
  }

  const updatedTask = { ...found.task };
  let updatedBody = found.body;

  if (mutatesTaskMd) {
    if (targetStatus) updatedTask.status = targetStatus;
    if (["feedback", "answer", "reset", "release"].includes(intent)) {
      updatedTask.claim_round = (Number(updatedTask.claim_round) || 1) + 1;
      updatedTask.claimed_by = "";
      const dispatcher = previousClaimant && readEntityFile(bucketDir, previousClaimant)?.dispatcher;
      updatedTask.assignee = intent === "reset" || values.reopen
        ? "" : dispatcher || previousClaimant || found.task.assignee;
      updatedTask.affinity = intent === "reset" || values.reopen ? "" : dispatcher ? previousClaimant : "";
    }
    if (["feedback", "answer"].includes(intent) || metadataChange ||
        (intent === "accept-amends" && acceptedAmends.some((event) => !ignoredFiles.has(event.filename)))) {
      updatedTask.revision = (Number(updatedTask.revision) || 1) + 1;
    }
    if (TERMINAL_STATUSES.has(targetStatus)) {
      updatedTask.claimed_by = "";
    } else if (rule.actor === "claimant") {
      updatedTask.claimed_by = entityId;
    }
    if (values.assignee !== undefined) updatedTask.assignee = values.assignee;
    if (taskTtl !== undefined) updatedTask.ttl_seconds = taskTtl;
    if (acceptedAmends.length) {
      const incorporated = acceptedAmends.filter((event) => !ignoredFiles.has(event.filename));
      if (incorporated.length) updatedBody = `${updatedBody.trimEnd()}\n\n${incorporated.map((event) =>
        `## Amendment: ${event.filename}\n\n${event.body}`).join("\n\n")}\n`;
      updatedTask.last_amend_seen = acceptedAmends.at(-1).filename;
    }
    if (intent === "ack-instructions") updatedTask.instructions_seen = instructionExtra.instructions_hash;
    if (acceptVerdicts) {
      updatedBody = applyAcVerdicts(updatedBody, acceptVerdicts);
      if (values.outcome !== undefined) updatedTask.outcome = values.outcome;
      else if (acceptDerived) updatedTask.outcome = acceptDerived;
    } else if (values.outcome !== undefined) updatedTask.outcome = values.outcome;

    if (addDeps.length > 0 || removeDeps.size > 0) {
      const nextDeps = updatedTask.depends_on.filter((d) => !removeDeps.has(d));
      for (const dep of addDeps) {
        if (!nextDeps.includes(dep)) nextDeps.push(dep);
      }
      updatedTask.depends_on = nextDeps;
    }

    updatedTask.updated_by = entityId;
    updatedTask.updated_at = isoUtc;
  }
  const eventResult = mutatesTaskMd
    ? publishTaskState(found, updatedTask, updatedBody, entityId, eventType, message, now, {
      ...checkpoint, ...reviewExtra, ...instructionExtra,
      ...(acceptedAmends.length ? { accepted_amends: acceptedAmends.filter((event) => !ignoredFiles.has(event.filename)).map((event) => event.filename),
        ignored_amends: [...ignoredFiles], ignore_reason: values.reason?.trim() || "" } : {}),
    })
    : writeUniqueEvent(found.eventsDir, entityId, eventType, message, now, { ...checkpoint, ...reviewExtra });

  touchExistingEntity(bucketDir, entityId);
  if (found.task.status === "in-progress" && updatedTask.status !== "in-progress" && previousClaimant) {
    const claimant = readEntityFile(bucketDir, previousClaimant);
    if (claimant?.claimed_task === taskId) upsertEntityFile(bucketDir, previousClaimant, { claimed_task: "" });
  }

  return {
    ...serializeTaskSummary({ ...found, task: updatedTask }),
    event: eventResult.filename,
    task_updated: mutatesTaskMd,
    previous_revision: found.task.revision,
    previous_claim_round: found.task.claim_round,
    ...instructionOutput,
  };
}

const AC_VERDICT_RE = /^- \[( |x|X)\] #(\d+)\s*(.*)$/;
const VALID_OUTCOMES = ["pass", "partial", "fail", "abandoned"];

function numberedCriteria(body) {
  const found = [];
  for (const line of String(body || "").split("\n")) {
    const m = AC_VERDICT_RE.exec(line.replace(/\r/g, ""));
    if (m) found.push({ n: Number(m[2]), checked: m[1] !== " ", line });
  }
  return found;
}

function parseAcVerdicts(values) {
  const raw = parseListFlags(values.ac);
  const byN = new Map();
  for (const entry of raw) {
    const m = /^(\d+)=(pass|fail|not-run)$/.exec(entry.trim());
    if (!m) throw new CliError(`Malformed --ac verdict "${entry}". Use N=pass|fail|not-run.`);
    const n = Number(m[1]);
    if (!Number.isSafeInteger(n) || n < 1) throw new CliError("Criterion numbers must be positive safe integers.");
    if (byN.has(n)) throw new CliError(`Duplicate --ac verdict for criterion ${n}.`);
    byN.set(n, m[2]);
  }
  return byN;
}

function validateReviewVerdicts(body, verdicts, proposedOutcome) {
  if (proposedOutcome === undefined || !VALID_OUTCOMES.includes(proposedOutcome)) {
    throw new CliError("--proposed-outcome must be pass|partial|fail|abandoned.");
  }
  const criteria = numberedCriteria(body);
  if (!criteria.length) throw new CliError("Review requires a brief with numbered acceptance criteria (- [ ] #N).");
  const seen = new Set();
  for (const c of criteria) {
    if (!Number.isSafeInteger(c.n) || c.n < 1) throw new CliError("Criterion numbers must be positive safe integers.");
    if (seen.has(c.n)) throw new CliError(`Duplicate numbered acceptance criterion #${c.n} in brief.`);
    seen.add(c.n);
  }
  for (const n of verdicts.keys()) {
    if (!seen.has(n)) throw new CliError(`--ac verdict for unknown criterion #${n}.`);
  }
  for (const n of seen) {
    if (!verdicts.has(n)) throw new CliError(`Missing --ac verdict for criterion #${n}.`);
  }
}

function latestReviewVerdicts(eventsDir, claimRound) {
  const reviews = [];
  for (const filename of listEventFiles(eventsDir)) {
    if (parseEventFilenameParts(filename)?.type !== "review") continue;
    let data = {};
    try {
      ({ data } = parseFrontmatter(fs.readFileSync(path.join(eventsDir, filename), "utf8")));
    } catch { continue; }
    if (data.snapshot_version === 1 && data.claim_round === Number(claimRound) &&
        data.status === "review" && Number.isSafeInteger(data.state_seq)) reviews.push({ data, filename });
  }
  reviews.sort((a, b) => b.data.state_seq - a.data.state_seq);
  if (!reviews.length) return null;
  const { data, filename } = reviews[0];
  const winner = getRoundClaims(eventsDir, claimRound).winner;
  if (!winner || data.claimed_by !== winner.entityId || data.entity_id !== winner.entityId ||
      !Array.isArray(data.ac) || !VALID_OUTCOMES.includes(data.proposed_outcome)) return null;
  const verdicts = new Map();
  for (const entry of data.ac) {
    const m = /^(\d+):(pass|fail|not-run)$/.exec(String(entry));
    if (!m || verdicts.has(Number(m[1]))) return null;
    verdicts.set(Number(m[1]), m[2]);
  }
  return verdicts.size ? { verdicts, proposed: data.proposed_outcome, filename } : null;
}

function derivedOutcome(verdicts) {
  const vals = [...verdicts.values()];
  if (vals.every((v) => v === "pass")) return "pass";
  if (vals.every((v) => v === "fail")) return "fail";
  return "partial";
}

function applyAcVerdicts(body, verdicts) {
  return String(body || "").split("\n").map((line) => {
    const m = AC_VERDICT_RE.exec(line.replace(/\r/g, ""));
    if (!m) return line;
    const n = Number(m[2]);
    const rest = m[3].replace(/\s+\((?:fail|not-run)\)$/, "");
    const verdict = verdicts.get(n);
    if (verdict === "pass") return `- [x] #${n}${rest ? ` ${rest}` : ""}`;
    if (verdict === "fail") return `- [ ] #${n}${rest ? ` ${rest}` : ""} (fail)`;
    if (verdict === "not-run") return `- [ ] #${n}${rest ? ` ${rest}` : ""} (not-run)`;
    return line;
  }).join("\n");
}

function checkpointManifest(values) {
  if (!values.notes?.trim()) throw new CliError("A checkpoint requires --notes describing state and cleanup/resume needs.");
  const pid = positiveSeconds(values.pid, "--pid");
  return {
    files_touched: parseListFlags(values["files-touched"]),
    resources: parseListFlags(values.resources),
    pid: pid ?? process.pid, host: values.host || os.hostname(), notes: values.notes.trim(),
  };
}

async function cmdRun(argv) {
  const { values, command } = parseCommand("run", argv);
  if (values.help) { printCommandHelp("run"); return 0; }
  if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
  if (!command.length) throw new CliError('run requires -- <command> [args...].');
  const bucketDir = path.resolve(values.bucket);
  const entityId = validateIdentifier(values.entity, "--entity");
  useEntitySession(bucketDir, entityId, values);
  const taskId = validateTaskId(values.task);
  const found = findTask(bucketDir, taskId);
  if (!found) throw new CliError(`Task "${taskId}" not found.`);
  assertTransition("checkpoint", found, entityId, { bucketDir });
  assertInstructionsAcknowledged(bucketDir, found);
  const existing = readEntityFile(bucketDir, entityId);
  if (existing?.running && (existing.running.host === os.hostname()
    ? pidAlive(existing.running.pid) !== false : ageSeconds(existing.updated_at, Infinity) <= existing.ttl_seconds)) {
    throw new CliError(`Entity "${entityId}" already has an active run wrapper.`, 3);
  }
  const config = readBucketConfig(bucketDir);
  const ttl = positiveSeconds(found.task.ttl_seconds, "task ttl_seconds") ?? existing?.ttl_seconds ?? config.default_ttl_seconds;
  const logPath = values.log ? path.resolve(values.log) : "";
  const logFd = logPath ? fs.openSync(logPath, "a") : null;
  const running = { pid: process.pid, host: os.hostname(), cmd: command, started_at: formatIsoUtc(), task: taskId };
  let timer;
  let child;
  let heartbeatError;
  let receivedSignal;
  const onSignal = (signal) => { receivedSignal = signal; child?.kill(signal); };
  try {
    upsertEntityFile(bucketDir, entityId, {
      mode: existing?.mode || "once", host: os.hostname(), running, ended_at: "",
    });
    writeUniqueEvent(found.eventsDir, entityId, "checkpoint", "Command starting.", new Date(), {
      files_touched: [], resources: [], pid: process.pid, host: os.hostname(), notes: "Command starting",
      phase: "start", cmd: command, log: logPath,
    });
    const result = await new Promise((resolve) => {
      child = spawn(command[0], command.slice(1), { stdio: ["inherit", logFd ?? "inherit", logFd ?? "inherit"] });
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      child.once("error", (error) => resolve({ code: error.code === "ENOENT" ? 127 : 126, error: error.message }));
      child.once("close", (code, signal) => resolve({ code, signal }));
      try {
        running.child_pid = child.pid || "";
        upsertEntityFile(bucketDir, entityId, { running });
      } catch (err) {
        heartbeatError = err;
        child.kill("SIGTERM");
      }
      timer = setInterval(() => {
        try { upsertEntityFile(bucketDir, entityId); }
        catch (err) { heartbeatError = err; clearInterval(timer); child.kill("SIGTERM"); }
      }, Math.max(1, ttl * 1000 / 4));
    });
    const signal = receivedSignal || result.signal || "";
    const code = signal ? 128 + (os.constants.signals[signal] || 1) : result.code ?? 1;
    writeUniqueEvent(found.eventsDir, entityId, "checkpoint", result.error || "Command exited.", new Date(), {
      files_touched: [], resources: [], pid: process.pid, child_pid: child.pid || "", host: os.hostname(), notes: "Command exited",
      phase: "exit", cmd: command, log: logPath, exit_code: code, signal, error: result.error || heartbeatError?.message || "",
    });
    if (heartbeatError) throw heartbeatError;
    return code;
  } finally {
    clearInterval(timer);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (logFd !== null) fs.closeSync(logFd);
    upsertEntityFile(bucketDir, entityId, { running: "" });
  }
}

function cmdStatus(argv) {
  const { values } = parseCommand("status", argv);
  if (values.help) { printCommandHelp("status"); return 0; }
  if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
  if (values.owner) validateIdentifier(values.owner, "--owner");
  const bucketDir = path.resolve(values.bucket);
  const config = readBucketConfig(bucketDir);
  const { tasks, byId } = scanAllTasks(bucketDir);
  const active = tasks.filter((item) => !TERMINAL_STATUSES.has(item.task.status) &&
    (values.owner === undefined || item.task.owner === values.owner)).sort(sortByPriorityAndAge);
  const dispatchers = new Set(listEntities(bucketDir).map((entity) => entity.dispatcher).filter(Boolean));
  const summaries = active.map((item) => {
    const summary = serializeTaskSummary(item);
    const responsible = item.task.claimed_by || item.task.assignee;
    const entity = responsible ? readEntityFile(bucketDir, responsible) : null;
    const running = entity?.running && (!entity.running.task || entity.running.task === item.task.id) ? entity.running : null;
    const heartbeatAge = ageSeconds(entity?.updated_at, null);
    const eventAge = ageSeconds(summary.latest_event?.timestamp, null);
    const waitingRole = ["blocked", "review", "draft", "ready"].includes(item.task.status) ? "owner"
      : item.task.status === "pending" && item.task.assignee &&
        (item.task.affinity || dispatchers.has(item.task.assignee)) ? "dispatcher" : "executor";
    return { ...summary,
      running: running ? { ...running, age_seconds: Math.floor(ageSeconds(running.started_at)) } : null,
      heartbeat_age_seconds: heartbeatAge === null ? null : Math.floor(heartbeatAge),
      latest_event_age_seconds: eventAge === null ? null : Math.floor(eventAge),
      waiting_on: { role: waitingRole, entity_id: waitingRole === "owner" ? item.task.owner
        : item.task.claimed_by || item.task.assignee || "" },
      alerts: taskAlerts(bucketDir, item, byId, config),
    };
  });
  const conflicts = [];
  if (config.sync === "local" && fs.existsSync(bucketDir)) {
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        if (isSyncConflictFilename(entry.name)) conflicts.push(path.relative(bucketDir, path.join(dir, entry.name)));
        else if (entry.isDirectory()) visit(path.join(dir, entry.name));
      }
    };
    visit(bucketDir);
  }
  const warnings = conflicts.length ? ["Sync-conflict artifacts in a local bucket; check bucket.md sync setting."] : [];
  const result = { count: summaries.length, tasks: summaries, warnings, sync_conflicts: conflicts };
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const warning of warnings) console.log(`Warning: ${warning}`);
    for (const task of summaries) {
      console.log(`${task.id}: ${task.status} claimant=${task.claimed_by || "-"} waiting_on=${task.waiting_on.role}:${task.waiting_on.entity_id || "pool"}`);
      console.log(`  command=${task.running ? JSON.stringify(task.running.cmd) : "-"} age=${task.running?.age_seconds ?? "-"}s heartbeat_age=${task.heartbeat_age_seconds ?? "-"}s`);
      console.log(`  event=${task.latest_event?.filename || "-"} age=${task.latest_event_age_seconds ?? "-"}s alerts=${task.alerts.map((alert) => alert.type).join(",") || "-"}`);
    }
  }
  return 0;
}

function cmdRender(argv) {
  const { values } = parseCommand("render", argv);

  if (values.help) {
    printRenderHelp();
    return 0;
  }

  if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
  const bucketDir = path.resolve(values.bucket);
  const taskId = validateTaskId(values.task);
  if (values["latest-event"] && values["tail-events"] !== undefined) {
    throw new CliError("Use either --latest-event or --tail-events, not both.");
  }
  const tailEvents = values["latest-event"] ? 1
    : values["tail-events"] !== undefined ? Number(values["tail-events"]) : null;
  if (tailEvents !== null && (!Number.isInteger(tailEvents) || tailEvents < 0)) {
    throw new CliError("--tail-events must be a non-negative integer.");
  }

  const found = findTask(bucketDir, taskId);
  if (!found) {
    throw new CliError(`Task "${taskId}" not found.`);
  }

  let eventFiles = listEventFiles(found.eventsDir);
  if (values["after-event"]) {
    eventFiles = eventFiles.filter((f) =>
      isEventAfter(found.eventsDir, f, values["after-event"])
    );
  }
  if (tailEvents !== null) eventFiles = tailEvents === 0 ? [] : eventFiles.slice(-tailEvents);

  const events = eventFiles.map((filename) => {
    const fullPath = path.join(found.eventsDir, filename);
    const raw = fs.readFileSync(fullPath, "utf8");
    try {
      const { data, body } = parseFrontmatter(raw);
      return {
        filename,
        type: String(data.type ?? ""),
        entity_id: String(data.entity_id ?? ""),
        timestamp: String(data.timestamp ?? ""),
        body: body.trim(),
        ...checkpointFields(data),
      };
    } catch (err) {
      if (err instanceof CliError) {
        return {
          filename,
          type: "note",
          entity_id: "",
          timestamp: "",
          body: raw.replace(/\r/g, "").trim(),
        };
      }
      throw err;
    }
  });

  const { winner } = getRoundClaims(found.eventsDir, found.task.claim_round || 1);
  const claimWinner = winner ? winner.entityId : "";

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          ...serializeTaskSummary(found),
          claim_winner: claimWinner,
          body: found.body.trim(),
          events,
        },
        null,
        2
      )
    );
    return 0;
  }

  const out = [];
  out.push(`<!-- stage: ${found.stage} | path: ${found.dir} | claim_winner: ${claimWinner} -->`);
  out.push(formatTaskMarkdown(found.task, found.body).trimEnd());
  out.push("");
  out.push("## Event Stream");
  if (events.length === 0) {
    out.push("_No events._");
  } else {
    for (const ev of events) {
      out.push("");
      out.push(`### ${ev.filename}`);
      out.push(`- **Type:** \`${ev.type}\` | **Entity:** \`${ev.entity_id}\` | **Timestamp:** ${ev.timestamp}`);
      if (Object.hasOwn(ev, "notes")) out.push(`- **Checkpoint:** ${JSON.stringify(checkpointFields(ev))}`);
      if (ev.body) {
        out.push("");
        out.push(ev.body);
      }
    }
  }
  console.log(out.join("\n"));
  return 0;
}

function cmdList(argv) {
  const { values } = parseCommand("list", argv);
  if (values.help) {
    printListHelp();
    return 0;
  }
  if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
  if (values.owner) validateIdentifier(values.owner, "--owner");
  if (values.assignee) validateIdentifier(values.assignee, "--assignee");
  if (values["claimed-by"]) validateIdentifier(values["claimed-by"], "--claimed-by");
  const statuses = new Set(parseListFlags(values.status));
  for (const status of statuses) {
    if (!VALID_STATUSES.has(status)) throw new CliError(`Invalid --status "${status}".`);
  }
  const tags = new Set(normalizeTags(parseListFlags(values.tag)));
  const tasks = listTasks(path.resolve(values.bucket))
    .filter(({ task }) =>
      (!statuses.size || statuses.has(task.status)) &&
      (!tags.size || task.tags.some((tag) => tags.has(tag))) &&
       (!values.owner || task.owner === values.owner) &&
       (values.assignee === undefined || task.assignee === values.assignee) &&
       (values["claimed-by"] === undefined || task.claimed_by === values["claimed-by"]))
    .sort(sortByPriorityAndAge)
    .map((item) => serializeTaskSummary(item));
  if (values.json) {
    console.log(JSON.stringify({ count: tasks.length, tasks }, null, 2));
  } else {
    for (const task of tasks) {
      console.log(`${task.id} status=${task.status} assignee=${task.assignee || "-"} claimed_by=${task.claimed_by || "-"} revision=${task.revision} claim_round=${task.claim_round} latest=${task.latest_event?.filename ?? "-"} type=${task.latest_event?.type ?? "-"}`);
    }
  }
  return 0;
}

function cmdFsck(argv) {
  const { values } = parseCommand("fsck", argv);
  if (values.help) {
    printCommandHelp("fsck");
    return 0;
  }
  if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
  const bucketDir = path.resolve(values.bucket);
  const config = readBucketConfig(bucketDir);
  const issues = [];
  let checked = 0;
  let repaired = 0;
  const tasksDir = path.join(bucketDir, "tasks");
  const entries = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir, { withFileTypes: true }) : [];
  const sameState = (a, b) => {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.every((key) => JSON.stringify(a[key]) === JSON.stringify(b[key]));
  };
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || isSyncConflictFilename(entry.name)) continue;
    checked += 1;
    const taskDir = path.join(tasksDir, entry.name);
    const taskPath = path.join(taskDir, "task.md");
    const eventsDir = path.join(taskDir, "events");
    for (const dir of [taskDir, eventsDir]) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir).filter(isSyncConflictFilename)) {
        issues.push({ task_id: entry.name, kind: "sync_conflict", file: name, sync: config.sync });
      }
    }
    const snapshots = [];
    let invalid = false;
    for (const filename of listEventFiles(eventsDir)) {
      let data;
      try {
        ({ data } = parseFrontmatter(fs.readFileSync(path.join(eventsDir, filename), "utf8")));
      } catch (err) {
        if (!(err instanceof CliError)) throw err;
        issues.push({ task_id: entry.name, kind: "invalid_event", event: filename });
        invalid = true;
        continue;
      }
      if (data.snapshot_version === undefined) continue;
      if (data.snapshot_version !== 1 || !Array.isArray(data.state_keys) ||
          ![...CANONICAL_TASK_KEYS, "state_seq", "affinity", "outcome", "last_amend_seen", "instructions_seen"]
            .every((key) => data.state_keys.includes(key)) || data.id !== entry.name ||
          !VALID_STATUSES.has(data.status) || !Number.isSafeInteger(data.state_seq) || data.state_seq < 1 ||
          data.state_keys.some((key) => !Object.hasOwn(data, key))) {
        issues.push({ task_id: entry.name, kind: "invalid_snapshot", event: filename });
        invalid = true;
        continue;
      }
      const state = Object.fromEntries(data.state_keys.map((key) => [key, data[key]]));
      if (data.type === "claim-committed") {
        const { winner } = getRoundClaims(eventsDir, data.claim_round);
        if (!winner || winner.entityId !== data.entity_id || winner.filename !== data.claim_event) {
          issues.push({ task_id: entry.name, kind: "losing_claim_snapshot", event: filename });
          continue;
        }
      }
      snapshots.push({ filename, state });
    }
    let current;
    try {
      current = parseFrontmatter(fs.readFileSync(taskPath, "utf8"));
    } catch (err) {
      if (!(err instanceof CliError) && err.code !== "ENOENT") throw err;
      issues.push({ task_id: entry.name, kind: "invalid_view", message: "Missing or invalid task.md; body cannot be reconstructed." });
      continue;
    }
    if (!snapshots.length) {
      issues.push({
        task_id: entry.name,
        kind: "legacy",
        message: Number(current.data.revision) !== Number(current.data.claim_round)
          ? "legacy: revision not bumped on rework"
          : "legacy: no state snapshots",
      });
      continue;
    }
    snapshots.sort((a, b) => a.state.state_seq - b.state.state_seq || compareEventFilenames(a.filename, b.filename));
    for (let i = 1; i < snapshots.length; i += 1) {
      if (snapshots[i].state.state_seq === snapshots[i - 1].state.state_seq &&
          !sameState(snapshots[i].state, snapshots[i - 1].state)) {
        issues.push({ task_id: entry.name, kind: "snapshot_conflict", event: snapshots[i].filename });
        invalid = true;
      }
    }
    const latest = snapshots.at(-1);
    const terminal = TERMINAL_STATUSES.has(current.data.status) ||
      snapshots.some(({ state }) => TERMINAL_STATUSES.has(state.status));
    if (!sameState(current.data, latest.state)) {
      const issue = { task_id: entry.name, kind: "drift", event: latest.filename, terminal, repaired: false };
      if (values.repair && !terminal && !invalid) {
        atomicWriteFile(taskPath, formatTaskMarkdown(latest.state, current.body));
        issue.repaired = true;
        repaired += 1;
      }
      issues.push(issue);
    }
  }
  for (const dir of [bucketDir, ...["tasks", "messages", "entities"].map((sub) => path.join(bucketDir, sub))]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter(isSyncConflictFilename)) {
      issues.push({ kind: "sync_conflict", file: name, sync: config.sync });
    }
  }
  const unresolved = issues.filter((issue) => issue.kind !== "legacy" && !issue.repaired).length;
  if (values.json) console.log(JSON.stringify({ checked, repaired, unresolved, issues }, null, 2));
  else {
    for (const issue of issues) {
      console.log(`${issue.task_id || "bucket"}: ${issue.kind}: ${issue.message || issue.event || issue.file}${issue.repaired ? " (repaired)" : issue.terminal ? " (terminal; not repaired)" : ""}${issue.kind === "sync_conflict" && issue.sync === "local" ? " (warning: local bucket contains sync conflicts)" : ""}`);
    }
    console.log(`Checked ${checked} tasks; repaired ${repaired}; unresolved ${unresolved}.`);
  }
  return unresolved ? 1 : 0;
}

function cmdBucket(argv) {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") {
    printBucketHelp();
    return 0;
  }
  if (!["pause", "resume"].includes(action)) throw new CliError(`Unknown bucket action "${action}". Expected: pause, resume.`);
  const { values } = parseCommand(`bucket ${action}`, rest);
  if (values.help) {
    printCommandHelp(`bucket ${action}`);
    return 0;
  }
  if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
  const bucketDir = path.resolve(values.bucket);
  ensureBucketDirs(bucketDir);
  const pausePath = path.join(bucketDir, "PAUSED");
  if (action === "pause") {
    atomicWriteFile(pausePath, `${String(readBodyInput(values) || "Paused.").replace(/\r/g, "").trim()}\n`);
  } else {
    try {
      fs.unlinkSync(pausePath);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  const result = { paused: action === "pause", path: pausePath };
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`Bucket ${result.paused ? "paused" : "resumed"}.`);
  return 0;
}

async function cmdWatch(argv) {
  const { values } = parseCommand("watch", argv);

  if (values.help) {
    printWatchHelp();
    return 0;
  }

  if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
  const bucketDir = path.resolve(values.bucket);
  const watchTaskId = values.task ? validateTaskId(values.task) : null;
  const entityId = values.entity ? validateIdentifier(values.entity, "--entity") : null;
  if (entityId) useEntitySession(bucketDir, entityId, values);
  const ownerOnly = Boolean(values["owner-only"]);
  const excludedTasks = new Set(parseListFlags(values["exclude-task"]));
  for (const taskId of excludedTasks) validateTaskId(taskId);
  const eventLines = Number(values["event-lines"]);
  if (!Number.isInteger(eventLines) || eventLines < 0) {
    throw new CliError("--event-lines must be a non-negative integer.");
  }

  if (!watchTaskId && !entityId) {
    throw new CliError(
      "watch requires --entity <id> (for worker/owner watch) or --task <id>."
    );
  }
  if (watchTaskId && ownerOnly) {
    throw new CliError("--owner-only cannot be combined with --task.");
  }

  const workerTags = new Set(normalizeTags(parseListFlags(values.tag)));
  const includeUntagged = Boolean(values["include-untagged"]);
  const pollMs = Number(values["poll-ms"]);
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new CliError("--poll-ms must be a positive integer.");
  const config = readBucketConfig(bucketDir);
  const msgCoalesceMs = config.msg_coalesce_ms;
  const timeoutSec = Number(values.timeout);
  if (!Number.isFinite(timeoutSec) || timeoutSec < 0) throw new CliError("--timeout must be a non-negative number.");

  ensureBucketDirs(bucketDir);

  if (!watchTaskId && entityId) {
    upsertEntityFile(bucketDir, entityId, {
      tags: Array.from(workerTags),
      include_untagged: includeUntagged,
      mode: ownerOnly ? "owner" : "worker",
      delivery: "watch",
      ended_at: "",
      host: os.hostname(),
    });
  }

  let initialTaskState = null;
  if (watchTaskId) {
    const initial = findTask(bucketDir, watchTaskId);
    if (!initial) throw new CliError(`Task "${watchTaskId}" not found.`);
    if (initial) {
      initialTaskState = {
        stage: initial.stage,
        status: initial.task.status,
        events: new Set(listEventFiles(initial.eventsDir)),
      };
    }
  }

  let isInitialEval = true;

  function evaluateOnce() {
    if (watchTaskId) {
      const current = findTask(bucketDir, watchTaskId);
      if (!current) {
        if (initialTaskState) {
          return {
            mode: "task",
            id: watchTaskId,
            reason: "removed",
            stage: null,
            status: null,
            new_events: [],
          };
        }
        return null;
      }
      // Stat task.md and events/ to keep SMB/NFS client cache fresh during polling
      try {
        fs.statSync(current.taskPath);
        fs.statSync(current.eventsDir);
      } catch {
        // ignore
      }

      const currentEvents = listEventFiles(current.eventsDir);
      const newEvents = values["after-event"]
        ? currentEvents.filter(
            (f) =>
              isEventAfter(current.eventsDir, f, values["after-event"]) ||
              (!isInitialEval &&
                f !== values["after-event"] &&
                (!initialTaskState || !initialTaskState.events.has(f)))
          )
        : initialTaskState
        ? currentEvents.filter((f) => !initialTaskState.events.has(f))
        : currentEvents;

      const baselineStatus =
        values["since-status"] ?? initialTaskState?.status ?? current.task.status;
      const statusChanged = current.task.status !== baselineStatus;
      const stageChanged = initialTaskState
        ? current.stage !== initialTaskState.stage
        : false;
      const appeared = !initialTaskState && !values["after-event"] && !values["since-status"];

      if (newEvents.length > 0 || statusChanged || stageChanged || appeared) {
        return {
          mode: "task",
          ...serializeTaskSummary(current, values["include-events"], eventLines),
          reason: newEvents.length ? "new_events" : statusChanged ? "status_changed" : "appeared",
          previous_status: baselineStatus,
          status_changed: statusChanged,
          stage_changed: stageChanged,
          new_events: newEvents,
          last_event_seen:
            currentEvents.length > 0 ? currentEvents[currentEvents.length - 1] : "",
          paused: fs.existsSync(path.join(bucketDir, "PAUSED")),
          events: newEvents.map((filename) => readEventFile(current.eventsDir, filename, values["include-events"], eventLines)),
        };
      }
      return null;
    }

    // Stat task and message dirs to keep SMB/NFS/sync client caches fresh during polling
    for (const sub of ["tasks", "messages"]) {
      try {
        fs.statSync(path.join(bucketDir, sub));
      } catch {
        // ignore
      }
    }

    const paused = fs.existsSync(path.join(bucketDir, "PAUSED"));
    const eligible = ownerOnly || paused
      ? []
      : findEligibleTasks(bucketDir, entityId, workerTags, includeUntagged)
        .filter((item) => !excludedTasks.has(item.task.id));
    const ownerTasks = findOwnerActionableTasks(bucketDir, entityId, values["all-actionable"])
      .filter((item) => !excludedTasks.has(item.task.id));
    const alerts = findOwnerAlerts(bucketDir, entityId)
      .filter((item) => !excludedTasks.has(item.task.id));
    const alertTasks = (type) => alerts.filter((item) => item.alert.type === type).map((item) => ({
      ...serializeTaskSummary(item, values["include-events"], eventLines),
      ...item.alert, alert_cursor: item.alert_cursor,
    }));
    const msgCursor =
      values["after-msg"] !== undefined
        ? values["after-msg"]
        : readEntityFile(bucketDir, entityId)?.last_msg_seen ?? "";
    const { matched: unreadMessages, latestFile: latestMsgFile } =
      findUnreadMessages(bucketDir, entityId, workerTags, msgCursor);

    if (
      eligible.length > 0 ||
      ownerTasks.length > 0 ||
      alerts.length > 0 ||
      (paused && !ownerOnly) ||
      unreadMessages.length > 0
    ) {
      return {
        mode: ownerOnly ? "owner" : "ready",
        reason: paused && !ownerOnly ? "paused" : alerts.length ? alerts[0].alert.type : ownerTasks.length ? "owner_update" : eligible.length ? "work" : "messages",
        paused,
        entity_id: entityId,
        count: eligible.length,
        tasks: eligible.map((item) => serializeTaskSummary(item, values["include-events"], eventLines)),
        owner_tasks: ownerTasks.map((item) => serializeTaskSummary(item, values["include-events"], eventLines)),
        stale_tasks: alertTasks("stale"),
        abandoned_tasks: alertTasks("abandoned"),
        pinned_idle_tasks: alertTasks("pinned_idle"),
        unclaimed_tasks: alertTasks("unclaimed"),
        messages: unreadMessages,
        last_msg_seen: latestMsgFile || msgCursor,
      };
    }
    return null;
  }

  function advanceDeliveryCursors(result) {
    if (!watchTaskId && entityId && result?.owner_tasks?.length) {
      const seen = new Map((readEntityFile(bucketDir, entityId)?.owner_task_seen ?? [])
        .map((cursor) => cursor.split("/")));
      for (const task of result.owner_tasks) {
        if (task.latest_event) seen.set(task.id, task.latest_event.filename);
      }
      upsertEntityFile(bucketDir, entityId, {
        owner_task_seen: Array.from(seen, ([id, event]) => `${id}/${event}`),
      });
    }
    const alertTasks = result ? ["stale_tasks", "abandoned_tasks", "pinned_idle_tasks", "unclaimed_tasks"]
      .flatMap((key) => result[key] || []) : [];
    if (!watchTaskId && entityId && alertTasks.length) {
      const seen = new Map((readEntityFile(bucketDir, entityId)?.stale_task_seen ?? [])
        .map((cursor) => [cursor.split("/")[0], cursor]));
      for (const task of alertTasks) {
        seen.set(task.id, task.alert_cursor);
      }
      upsertEntityFile(bucketDir, entityId, { stale_task_seen: Array.from(seen.values()) });
    }
    if (
      !watchTaskId &&
      entityId &&
      result &&
      Array.isArray(result.messages) &&
      result.messages.length > 0 &&
      values["after-msg"] === undefined &&
      result.last_msg_seen
    ) {
      upsertEntityFile(bucketDir, entityId, {
        last_msg_seen: result.last_msg_seen,
      });
    }
  }

  function printResult(result) {
    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.mode === "ready" || result.mode === "owner") {
      if (result.paused) console.log("Bucket is paused; no work is handed out.");
      if (result.tasks.length > 0) {
        console.log(`Ready tasks for ${result.entity_id} (${result.count}):`);
        for (const t of result.tasks) {
          console.log(
            `- ${t.id} [${t.priority}] (${t.stage}/${t.status}) revision=${t.revision} claim_round=${t.claim_round} claimed_by=${t.claimed_by || "-"} assignee=${t.assignee || "-"} tags=${JSON.stringify(t.tags)} :: ${t.title}`
          );
          printEvent(t.latest_event);
        }
      }
      if (result.owner_tasks.length > 0) {
        console.log(
          `Owned tasks needing attention for ${result.entity_id} (${result.owner_tasks.length}):`
        );
        for (const t of result.owner_tasks) {
          console.log(
            `- ${t.id} [${t.priority}] (${t.stage}/${t.status}) revision=${t.revision} claim_round=${t.claim_round} claimed_by=${t.claimed_by || "-"} assignee=${t.assignee || "-"} :: ${t.title}`
          );
          printEvent(t.latest_event);
        }
      }
      if (result.messages.length > 0) {
        console.log(`Unread messages for ${result.entity_id} (${result.messages.length}):`);
        for (const m of result.messages) {
          console.log(
            `- ${m.filename} from=${m.from} to=${JSON.stringify(m.to)} tags=${JSON.stringify(m.tags)}: ${m.body}`
          );
        }
      }
      for (const task of result.stale_tasks) {
        console.log(`Stale: ${task.id} status=${task.status} revision=${task.revision} claim_round=${task.claim_round} claimed_by=${task.claimed_by} assignee=${task.assignee || "-"} heartbeat=${task.heartbeat.updated_at} age=${task.heartbeat.age_seconds}s ttl=${task.heartbeat.ttl_seconds}s`);
        printEvent(task.latest_event);
      }
      for (const task of [...result.abandoned_tasks, ...result.pinned_idle_tasks, ...result.unclaimed_tasks]) {
        console.log(`${task.type}: ${task.id} status=${task.status} claimant=${task.claimed_by || "-"} assignee=${task.assignee || "-"}`);
      }
    } else {
      console.log(
        `Task update for ${result.id}: stage=${result.stage} status=${result.status} revision=${result.revision ?? "-"} claim_round=${result.claim_round ?? "-"} claimed_by=${result.claimed_by || "-"} assignee=${result.assignee || "-"}`
      );
      if (result.status_changed) {
        console.log(`Status changed: ${result.previous_status} -> ${result.status}`);
      }
      if (result.new_events.length > 0) {
        console.log(`New events: ${result.new_events.join(", ")}`);
      }
      if (result.events?.length) {
        for (const event of result.events) printEvent(event);
      } else {
        printEvent(result.latest_event);
      }
    }
  }

  function printEvent(event) {
    if (!event) return;
    console.log(`  Event: ${event.filename} type=${event.type}${event.truncated ? " (truncated)" : ""}`);
    if (Object.hasOwn(event, "notes")) console.log(`  Checkpoint: ${JSON.stringify(checkpointFields(event))}`);
    if (event.body) console.log(event.body);
  }

  const immediate = evaluateOnce();
  isInitialEval = false;
  if (immediate) {
    advanceDeliveryCursors(immediate);
    printResult(immediate);
    return 0;
  }

  return await new Promise((resolve) => {
    let settled = false;
    let debounceTimer = null;
    let msgCoalesceTimer = null;
    let firstMsgCoalesceAt = 0;
    let coalesceLastSeen = "";
    let pollTimer = null;
    let heartbeatTimer = null;
    let timeoutTimer = null;
    const watchers = [];

    function cleanup() {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (msgCoalesceTimer) clearTimeout(msgCoalesceTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // ignore
        }
      }
      process.removeListener("SIGINT", onSig);
      process.removeListener("SIGTERM", onSig);
    }

    function finish(code, result = null) {
      if (settled) return;
      settled = true;
      cleanup();
      if (result) {
        advanceDeliveryCursors(result);
        printResult(result);
      }
      resolve(code);
    }

    function isMessageOnlyResult(res) {
      return (
        res &&
        (res.mode === "ready" || res.mode === "owner") &&
        res.tasks.length === 0 &&
        res.owner_tasks.length === 0 &&
        res.stale_tasks.length === 0 &&
        res.abandoned_tasks.length === 0 &&
        res.pinned_idle_tasks.length === 0 &&
        res.unclaimed_tasks.length === 0 &&
        !res.paused &&
        res.messages.length > 0
      );
    }

    function checkAndFinish() {
      if (settled) return;
      try {
        const res = evaluateOnce();
        if (!res) {
          if (msgCoalesceTimer) {
            clearTimeout(msgCoalesceTimer);
            msgCoalesceTimer = null;
            firstMsgCoalesceAt = 0;
            coalesceLastSeen = "";
          }
          return;
        }
        if (isMessageOnlyResult(res) && msgCoalesceMs > 0) {
          if (msgCoalesceTimer && res.last_msg_seen === coalesceLastSeen) {
            return;
          }
          if (!firstMsgCoalesceAt) firstMsgCoalesceAt = Date.now();
          coalesceLastSeen = res.last_msg_seen || "";
          const elapsed = Date.now() - firstMsgCoalesceAt;
          const remaining = Math.min(
            msgCoalesceMs,
            Math.max(0, MAX_MSG_COALESCE_MS - elapsed)
          );
          if (remaining <= 0) {
            finish(0, res);
            return;
          }
          if (msgCoalesceTimer) clearTimeout(msgCoalesceTimer);
          msgCoalesceTimer = setTimeout(() => {
            msgCoalesceTimer = null;
            try {
              const latest = evaluateOnce();
              if (latest) {
                finish(0, latest);
              } else {
                firstMsgCoalesceAt = 0;
                coalesceLastSeen = "";
              }
            } catch {
              firstMsgCoalesceAt = 0;
              coalesceLastSeen = "";
            }
          }, remaining);
          return;
        }
        finish(0, res);
      } catch {
        // Transient read errors during concurrent renames are retried on next tick
      }
    }

    function scheduleCheck() {
      if (settled || debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        checkAndFinish();
      }, 25);
    }

    function onSig() {
      finish(130);
    }
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);

    const onWatchEvent = (_eventType, filename) => {
      if (filename) {
        const str = String(filename);
        const base = path.basename(str);
        if (base.startsWith(".") || isSyncConflictFilename(base)) return;
        const top = str.split(/[\\/]/)[0];
        if (top === "entities") return;
      }
      scheduleCheck();
    };

    try {
      watchers.push(fs.watch(bucketDir, { recursive: true }, onWatchEvent));
    } catch {
      // Fallback on platforms/mounts without recursive fs.watch: watch top-level dirs + polling
      for (const sub of ["tasks", "messages"]) {
        try {
          watchers.push(fs.watch(path.join(bucketDir, sub), onWatchEvent));
        } catch {
          // polling fallback handles it
        }
      }
    }

    pollTimer = setInterval(checkAndFinish, pollMs);

    if (entityId && readEntityFile(bucketDir, entityId)) {
      heartbeatTimer = setInterval(() => {
        try {
          upsertEntityFile(bucketDir, entityId);
        } catch {
          // ignore transient heartbeat failure
        }
      }, Math.max(1, (readEntityFile(bucketDir, entityId)?.ttl_seconds ?? config.default_ttl_seconds) * 1000 / 4));
    }

    if (timeoutSec > 0) {
      timeoutTimer = setTimeout(() => {
        console.error(`Watch timed out after ${timeoutSec}s.`);
        finish(124);
      }, timeoutSec * 1000);
    }
  });
}

function cmdMsg(argv) {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") {
    printMsgHelp();
    return 0;
  }

  if (action === "send") {
    const { values } = parseCommand("msg send", rest);
    if (values.help) {
      printCommandHelp("msg send");
      return 0;
    }
    if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
    const bucketDir = path.resolve(values.bucket);
    const entityId = validateIdentifier(values.entity, "--entity");
    useEntitySession(bucketDir, entityId, values);
    const body = readBodyInput(values);
    if (!body.trim()) {
      throw new CliError("Message body cannot be empty (pass -m, --body-file, or --stdin).");
    }

    const rawTo = parseListFlags(values.to);
    for (const r of rawTo) {
      if (r !== "*") validateIdentifier(r, "--to");
    }
    const tags = normalizeTags(parseListFlags(values.tag));
    const toList = rawTo.length > 0 ? rawTo : tags.length > 0 ? [] : ["*"];
    if (!values.force) {
      for (const recipient of toList.filter((id) => id !== "*")) {
        if (readEntityFile(bucketDir, recipient)?.delivery !== "none") continue;
        const active = getActiveWipTasks(bucketDir, recipient)[0];
        throw new CliError(`"${recipient}" does not poll messages; ${active
          ? `use amend --task ${active.task.id}`
          : "use a task amendment for corrections"}.`, 2);
      }
    }

    ensureBucketDirs(bucketDir);
    const now = new Date();
    const res = writeUniqueMessage(
      path.join(bucketDir, "messages"),
      entityId,
      toList,
      tags,
      values.slug || "msg",
      body,
      now,
      { forced: Boolean(values.force) }
    );
    touchExistingEntity(bucketDir, entityId);

    const payload = {
      filename: res.filename,
      path: res.path,
      from: entityId,
      to: toList,
      tags,
      timestamp: res.timestamp,
      forced: Boolean(values.force),
    };
    if (values.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Sent message ${res.filename} (to=${JSON.stringify(toList)} tags=${JSON.stringify(tags)})`);
    }
    return 0;
  }

  if (action === "list") {
    const { values } = parseCommand("msg list", rest);
    if (values.help) {
      printCommandHelp("msg list");
      return 0;
    }
    if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
    const bucketDir = path.resolve(values.bucket);
    const entityId = values.entity ? validateIdentifier(values.entity, "--entity") : null;
    if (values.unread && !entityId) {
      throw new CliError("--unread requires --entity <id>.");
    }
    const workerTags = new Set(normalizeTags(parseListFlags(values.tag)));

    const messagesDir = path.join(bucketDir, "messages");
    try {
      fs.statSync(messagesDir);
    } catch {
      // ignore
    }
    let files = listMessageFiles(messagesDir);
    let afterCursor = values["after-msg"] ?? "";
    if (!afterCursor && values.unread && entityId) {
      afterCursor = readEntityFile(bucketDir, entityId)?.last_msg_seen ?? "";
    }
    if (afterCursor) {
      files = files.filter((f) => isMessageAfter(messagesDir, f, afterCursor));
    }

    const messages = [];
    for (const filename of files) {
      try {
        const msg = readMessageFile(path.join(messagesDir, filename));
        if (!values.all && entityId) {
          if (!matchesMessage(msg, entityId, workerTags)) continue;
        } else if (!values.all && workerTags.size > 0) {
          if (!msg.tags.some((t) => workerTags.has(t))) continue;
        }
        messages.push(msg);
      } catch (err) {
        if (err.code === "ENOENT") continue;
        throw err;
      }
    }

    if (values.json) {
      console.log(
        JSON.stringify(
          {
            count: messages.length,
            messages,
          },
          null,
          2
        )
      );
    } else if (messages.length === 0) {
      console.log("No matching messages.");
    } else {
      for (const m of messages) {
        console.log(
          `- ${m.filename} | from=${m.from} to=${JSON.stringify(m.to)} tags=${JSON.stringify(m.tags)} | ${m.timestamp}`
        );
        if (m.body) console.log(`  ${m.body}`);
      }
    }
    return 0;
  }

  throw new CliError(`Unknown msg action "${action}". Expected: send, list.`);
}

function cmdEntity(argv) {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") {
    printEntityHelp();
    return 0;
  }

  if (action === "end") {
    const { values } = parseCommand("entity end", rest);
    if (values.help) {
      printCommandHelp("entity end");
      return 0;
    }
    if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
    const bucketDir = path.resolve(values.bucket);
    const entityId = validateIdentifier(values.entity, "--entity");
    const targetId = values.target ? validateIdentifier(values.target, "--target") : entityId;
    const target = readEntityFile(bucketDir, targetId);
    if (!target) throw new CliError(`Entity "${targetId}" not found.`);
    if (targetId !== entityId && target.dispatcher !== entityId) {
      throw new CliError(`Only "${targetId}" or its recorded dispatcher may end it.`, 3);
    }
    const saved = upsertEntityFile(bucketDir, targetId, { ended_at: target.ended_at || formatIsoUtc(), delivery: "none" });
    if (values.json) console.log(JSON.stringify(saved, null, 2));
    else console.log(`Ended entity ${targetId}.`);
    return 0;
  }

  if (action === "register") {
    const { values } = parseCommand("entity register", rest);
    if (values.help) {
      printCommandHelp("entity register");
      return 0;
    }
    if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
    const bucketDir = path.resolve(values.bucket);
    const entityId = validateIdentifier(values.entity, "--entity");
    useEntitySession(bucketDir, entityId, values);
    if (values.mode && !["once", "one-shot", "continuous", "owner", "worker"].includes(values.mode)) {
      throw new CliError(`Invalid --mode "${values.mode}".`);
    }
    if (values.delivery !== undefined && !["watch", "none"].includes(values.delivery)) {
      throw new CliError("--delivery must be watch|none.");
    }
    ensureBucketDirs(bucketDir);
    const tags = normalizeTags(parseListFlags(values.tag));
    const ttlSec = values.ttl !== undefined ? Number(values.ttl) : undefined;
    if (ttlSec !== undefined && (!Number.isSafeInteger(ttlSec) || ttlSec < 1)) {
      throw new CliError("--ttl must be a positive integer.");
    }
    const note = readBodyInput(values);
    const saved = upsertEntityFile(bucketDir, entityId, {
      ...(values.tag ? { tags } : {}),
      ...(values["include-untagged"] ? { include_untagged: true } : {}),
      ...(values.mode ? { mode: values.mode } : {}),
      ...(values.delivery !== undefined ? { delivery: values.delivery } : values.mode
        ? { delivery: ["once", "one-shot"].includes(values.mode) ? "none" : "watch" } : {}),
      ...(ttlSec !== undefined ? { ttl_seconds: ttlSec } : {}),
      ...(note ? { body: note } : {}),
      ended_at: "",
    });
    if (values.json) {
      console.log(JSON.stringify(saved, null, 2));
    } else {
      console.log(
        `Registered entity ${saved.entity_id} (tags=${JSON.stringify(saved.tags)}, ttl=${saved.ttl_seconds}s)`
      );
    }
    return 0;
  }

  if (action === "list") {
    const { values } = parseCommand("entity list", rest);
    if (values.help) {
      printCommandHelp("entity list");
      return 0;
    }
    if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
    const bucketDir = path.resolve(values.bucket);
    let entities = listEntities(bucketDir);
    if (!values.all) entities = entities.filter((e) => !e.ended_at && e.age_seconds <= e.ttl_seconds * 3);
    if (values.online) {
      entities = entities.filter((e) => e.online);
    }
    if (values.json) {
      console.log(JSON.stringify({ count: entities.length, entities }, null, 2));
    } else if (entities.length === 0) {
      console.log("No registered entities.");
    } else {
      for (const e of entities) {
        console.log(
          `- ${e.entity_id} [${e.state}] mode=${e.mode || "-"} tags=${JSON.stringify(e.tags)} age=${e.age_seconds}s/${e.ttl_seconds}s`
        );
      }
    }
    return 0;
  }

  throw new CliError(`Unknown entity action "${action}". Expected: register, end, list.`);
}

function cmdTag(argv) {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") {
    printTagHelp();
    return 0;
  }

  if (action === "set") {
    const { values } = parseCommand("tag set", rest);
    if (values.help) {
      printCommandHelp("tag set");
      return 0;
    }
    if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
    const bucketDir = path.resolve(values.bucket);
    const entityId = validateIdentifier(values.entity, "--entity");
    useEntitySession(bucketDir, entityId, values);
    const tags = normalizeTags(parseListFlags(values.tag));
    if (tags.length !== 1) throw new CliError("tag set requires exactly one --tag.");
    const tagName = validateIdentifier(tags[0], "--tag");
    const description = readBodyInput(values);
    ensureBucketDirs(bucketDir);
    const isoUtc = formatIsoUtc(new Date());
    const tagPath = path.join(bucketDir, "tags", `${tagName}.md`);
    atomicWriteFile(
      tagPath,
      formatTagMarkdown(
        { tag: tagName, updated_by: entityId, updated_at: isoUtc },
        description
      )
    );
    touchExistingEntity(bucketDir, entityId);
    const payload = {
      tag: tagName,
      path: tagPath,
      description: description.trim(),
      updated_by: entityId,
      updated_at: isoUtc,
    };
    if (values.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Saved tag ${tagName} (${tagPath})`);
    }
    return 0;
  }

  if (action === "list") {
    const { values } = parseCommand("tag list", rest);
    if (values.help) {
      printCommandHelp("tag list");
      return 0;
    }
    if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
    const bucketDir = path.resolve(values.bucket);
    const tags = listTagsInfo(bucketDir);
    if (values.json) {
      console.log(JSON.stringify({ count: tags.length, tags }, null, 2));
    } else if (tags.length === 0) {
      console.log("No tags found.");
    } else {
      for (const t of tags) {
        const desc = t.description ? ` :: ${t.description}` : "";
        console.log(
          `- ${t.tag} (online_entities=${JSON.stringify(t.online_entities)}, tasks=${t.task_count})${desc}`
        );
      }
    }
    return 0;
  }

  throw new CliError(`Unknown tag action "${action}". Expected: set, list.`);
}

function printMainHelp() {
  printCommandHelp();
}

function printCreateHelp() {
  printCommandHelp("create");
}

function printClaimHelp() {
  printCommandHelp("claim");
}

function printWatchHelp() {
  printCommandHelp("watch");
}

function printRenderHelp() {
  printCommandHelp("render");
}

function printListHelp() {
  printCommandHelp("list");
}

function printBucketHelp() {
  printCommandHelp("bucket");
}

function printMsgHelp() {
  printCommandHelp("msg");
}

function printEntityHelp() {
  printCommandHelp("entity");
}

function printTagHelp() {
  printCommandHelp("tag");
}

async function main(argv = process.argv.slice(2)) {
  const [sub, ...rest] = argv;
  if (!sub || sub === "--help" || sub === "-h") {
    printMainHelp();
    return 0;
  }

  switch (sub) {
    case "create":
      return cmdCreate(rest);
    case "claim":
      return await cmdClaim(rest);
    case "post":
    case "promote":
    case "demote":
    case "amend":
    case "review":
    case "question":
    case "feedback":
    case "answer":
    case "reset":
    case "release":
    case "checkpoint":
    case "complete":
    case "cancel":
    case "log":
    case "accept-amends":
    case "ack-instructions":
      return cmdTransition(sub, rest);
    case "watch":
      return await cmdWatch(rest);
    case "run":
      return await cmdRun(rest);
    case "status":
      return cmdStatus(rest);
    case "render":
      return cmdRender(rest);
    case "list":
      return cmdList(rest);
    case "fsck":
      return cmdFsck(rest);
    case "bucket":
      return cmdBucket(rest);
    case "msg":
      return cmdMsg(rest);
    case "entity":
      return cmdEntity(rest);
    case "tag":
      return cmdTag(rest);
    default:
      throw new CliError(`Unknown subcommand "${sub}". Run "wb.mjs --help".`);
  }
}

const isEntrypoint =
  process.argv[1] &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      const message = String(err.message || err).replace(/\s+/g, " ");
      console.error(`${message}${message.includes('Run "wb.mjs') ? "" : ` Run "wb.mjs ${process.argv.slice(2).filter((arg) => !arg.startsWith("-")).slice(0, 1).join("")} --help".`}`);
      process.exitCode = err instanceof CliError ? err.exitCode : 1;
    });
}

export {
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
};
