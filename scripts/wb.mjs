#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

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
const ENTITY_HEARTBEAT_MS = 60_000;
const DEFAULT_MSG_COALESCE_MS = 500;
const MAX_MSG_COALESCE_MS = 2000;
const DEFAULT_CLAIM_SETTLE_MS = 2000;
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

const VALID_EVENT_TYPES = new Set([
  "created",
  "claimed",
  "amend",
  "question",
  "answer",
  "log",
  "review",
  "feedback",
  "complete",
  "cancelled",
  "reset",
]);

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

let tmpCounter = 0;

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function formatIsoUtc(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function formatCompactUtc(date = new Date()) {
  return formatIsoUtc(date).replace(/[-:]/g, "");
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
    /^(\d{8}T\d{6}Z)-(.+)-(created|claimed|amend|question|answer|log|review|feedback|complete|cancelled|reset)(?:-(\d+))?\.md$/
  );
  if (!m) return null;
  return {
    utc: m[1],
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
      if (a.mtimeNs !== b.mtimeNs) {
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
    const candMtime = getFileMtimeNs(path.join(eventsDir, candidateName));
    const afterMtime = getFileMtimeNs(path.join(eventsDir, afterName));
    if (candMtime !== afterMtime) {
      return candMtime > afterMtime;
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
    type: String(data.type ?? "note"),
    entity_id: String(data.entity_id ?? ""),
    timestamp: String(data.timestamp ?? ""),
    body: includeFullBody ? body.trim() : lines.slice(0, eventLines).join("\n"),
    truncated: !includeFullBody && lines.length > eventLines,
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
    claimed_by: item.task.claimed_by,
    revision: item.task.revision,
    claim_round: item.task.claim_round,
    path: item.dir,
    latest_event: events.length ? readEventFile(item.eventsDir, events.at(-1), includeEvents, eventLines) : null,
  };
}

function writeUniqueMarkdown(targetDir, prefix, content, label = "file") {
  fs.mkdirSync(targetDir, { recursive: true });
  for (let seq = 1; seq < 1000; seq += 1) {
    const suffix = seq === 1 ? "" : `-${seq}`;
    const filename = `${prefix}${suffix}.md`;
    const targetPath = path.join(targetDir, filename);
    if (fs.existsSync(targetPath)) continue;
    tmpCounter += 1;
    const tmpPath = path.join(
      targetDir,
      `.${filename}.${process.pid}.${tmpCounter}.tmp`
    );
    try {
      fs.writeFileSync(tmpPath, content, { encoding: "utf8", flag: "wx" });
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(tmpPath);
        continue;
      }
      fs.renameSync(tmpPath, targetPath);
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

function getRoundClaims(eventsDir, claimRound = 1) {
  const targetRound = Number(claimRound) || 1;
  const eventNames = listEventFiles(eventsDir);
  let lastBoundaryIdx = -1;
  for (let i = 0; i < eventNames.length; i += 1) {
    const parts = parseEventFilenameParts(eventNames[i]);
    if (parts && ["created", "answer", "feedback", "reset"].includes(parts.type)) {
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
  const m = filename.match(/^(\d{8}T\d{6}Z)-(.+)\.md$/);
  if (!m) return null;
  return { utc: m[1], rest: m[2] };
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
      if (a.mtimeNs !== b.mtimeNs) {
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
    const candMtime = getFileMtimeNs(path.join(messagesDir, candidateName));
    const afterMtime = getFileMtimeNs(path.join(messagesDir, afterName));
    if (candMtime !== afterMtime) {
      return candMtime > afterMtime;
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

function writeUniqueMessage(messagesDir, fromEntity, toList, tags, slugText, body, now = new Date()) {
  const compactUtc = formatCompactUtc(now);
  const isoUtc = formatIsoUtc(now);
  const slug = slugify(slugText || "msg");
  const content = formatMessageMarkdown(
    {
      from: fromEntity,
      to: toList,
      tags,
      timestamp: isoUtc,
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
      ttl_seconds: Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_ENTITY_TTL_SECONDS,
      last_msg_seen: String(data.last_msg_seen ?? ""),
      owner_task_seen: coerceStringList(data.owner_task_seen),
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
    ttl_seconds:
      updates.ttl_seconds !== undefined
        ? updates.ttl_seconds
        : existing
        ? existing.ttl_seconds
        : DEFAULT_ENTITY_TTL_SECONDS,
    last_msg_seen:
      updates.last_msg_seen !== undefined
        ? String(updates.last_msg_seen)
        : initialLastMsgSeen,
    owner_task_seen: updates.owner_task_seen ?? existing?.owner_task_seen ?? [],
    updated_at: isoUtc,
  };
  const nextBody =
    updates.body !== undefined ? updates.body : existing ? existing.body : "";
  atomicWriteFile(entityPath, formatEntityMarkdown(nextData, nextBody));
  return { ...nextData, body: String(nextBody || "").trim(), path: entityPath };
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
    const online = ageSec <= info.ttl_seconds;
    out.push({
      ...info,
      age_seconds: ageSec,
      state: online ? "online" : "stale",
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
    const { winner } = getRoundClaims(item.eventsDir, item.task.claim_round);
    return !winner || (includeOwnClaim && winner.entityId === entityId);
  });

  const assignedToMe = available
    .filter(
      (item) =>
        item.task.status === "pending" &&
        item.task.claimed_by === "" &&
        item.task.assignee === entityId &&
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
  if (typeof values.body === "string") {
    return values.body;
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
    instructions.push({ file: "INSTRUCTIONS.md", body: fs.readFileSync(bucketPath, "utf8").replace(/\r/g, "").trim() });
  }
  for (const tag of task.tags) {
    if (tag.startsWith(".") || /[/\\]/.test(tag) || tag.includes("..")) continue;
    const tagPath = path.join(bucketDir, "tags", `${tag}.md`);
    if (fs.existsSync(tagPath)) {
      instructions.push({ file: `tags/${tag}.md`, body: readTagDoc(tagPath, tag).description });
    }
  }
  return instructions;
}

function cmdCreate(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      bucket: { type: "string", short: "b" },
      entity: { type: "string", short: "e" },
      title: { type: "string", short: "t" },
      priority: { type: "string", short: "p", default: "medium" },
      tag: { type: "string", multiple: true },
      tags: { type: "string", multiple: true },
      assignee: { type: "string", default: "" },
      parent: { type: "string", default: "" },
      "depends-on": { type: "string", multiple: true },
      workspace: { type: "string", default: "" },
      files: { type: "string", multiple: true },
      description: { type: "string", default: "" },
      ac: { type: "string", multiple: true },
      body: { type: "string" },
      "body-file": { type: "string" },
      stdin: { type: "boolean", default: false },
      slug: { type: "string" },
      backlog: { type: "boolean", default: false },
      draft: { type: "boolean", default: false },
      status: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printCreateHelp();
    return 0;
  }

  const bucketDir = path.resolve(values.bucket || "");
  if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
  const entityId = validateIdentifier(values.entity, "--entity");
  if (!values.title || !values.title.trim()) {
    throw new CliError("Missing required --title <text>.");
  }
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

  if (values.assignee) validateIdentifier(values.assignee, "--assignee");
  if (values.parent) validateTaskId(values.parent);

  const tags = normalizeTags([
    ...parseListFlags(values.tag),
    ...parseListFlags(values.tags),
  ]);
  const dependsOn = parseListFlags(values["depends-on"]);
  for (const dep of dependsOn) validateTaskId(dep);

  ensureBucketDirs(bucketDir);
  const now = new Date();
  const compactUtc = formatCompactUtc(now);
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
  const createdEvent = writeUniqueEvent(
    eventsDir,
    entityId,
    "created",
    `Task created: ${values.title.trim()}`,
    now
  );

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
        ? values.ac.map((c, idx) => `- [ ] #${idx + 1} ${c}`).join("\n")
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
    parent: values.parent || "",
    depends_on: dependsOn,
    revision: 1,
    updated_by: entityId,
    updated_at: isoUtc,
  };

  const taskPath = path.join(taskDir, "task.md");
  atomicWriteFile(taskPath, formatTaskMarkdown(taskData, body));
  touchExistingEntity(bucketDir, entityId);

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          task_id: taskId,
          stage: "tasks",
          path: taskDir,
          task_path: taskPath,
          created_event: createdEvent.filename,
          task: taskData,
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
  const { values } = parseArgs({
    args: argv,
    options: {
      bucket: { type: "string", short: "b" },
      entity: { type: "string", short: "e" },
      task: { type: "string" },
      tag: { type: "string", multiple: true },
      tags: { type: "string", multiple: true },
      "include-untagged": { type: "boolean", default: false },
      "claim-settle-ms": { type: "string", default: String(DEFAULT_CLAIM_SETTLE_MS) },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printClaimHelp();
    return 0;
  }

  if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
  const bucketDir = path.resolve(values.bucket);
  const entityId = validateIdentifier(values.entity, "--entity");
  const settleMs = Number.parseInt(values["claim-settle-ms"], 10);
  if (!Number.isFinite(settleMs) || settleMs < 0) {
    throw new CliError(`Invalid --claim-settle-ms "${values["claim-settle-ms"]}".`);
  }
  const workerTags = new Set(
    normalizeTags([
      ...parseListFlags(values.tag),
      ...parseListFlags(values.tags),
    ])
  );
  const includeUntagged = Boolean(values["include-untagged"]);

  ensureBucketDirs(bucketDir);

  const wip = getActiveWipTasks(bucketDir, entityId);
  if (wip.length > 0) {
    throw new CliError(
      `WIP limit reached: "${entityId}" already has in-progress task "${wip[0].task.id}".`,
      2
    );
  }

  const { byId } = scanAllTasks(bucketDir);
  let candidates;
  if (values.task) {
    validateTaskId(values.task);
    const found = byId.get(values.task);
    if (!found) {
      throw new CliError(`Task "${values.task}" not found.`, 2);
    }
    const eligible =
      found.task.status === "pending" &&
      found.task.claimed_by === "" &&
      (found.task.assignee === entityId ||
        (found.task.assignee === "" &&
          matchesTags(found.task, entityId, workerTags, includeUntagged))) &&
      dependenciesSatisfied(found.task, byId) &&
      !hasCompetingRoundClaim(found, entityId);
    if (!eligible) {
      throw new CliError(
        `Task "${values.task}" is not eligible for "${entityId}" (status=${found.task.status}, claimed_by=${found.task.claimed_by || "none"}).`,
        2
      );
    }
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

    if (settleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, settleMs));
    }

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

    postTask.status = "in-progress";
    postTask.claimed_by = entityId;
    postTask.claim_round = claimRound;
    postTask.updated_by = entityId;
    postTask.updated_at = formatIsoUtc(new Date());
    atomicWriteFile(candidate.taskPath, formatTaskMarkdown(postTask, postBody));

    claimedEntry = candidate;
    claimedEvent = myClaimEvent;
    finalTask = postTask;
    break;
  }

  if (!claimedEntry || !finalTask) {
    throw new CliError("Lost claim race; no remaining eligible tasks.", 2);
  }

  touchExistingEntity(bucketDir, entityId);

  const events = listEventFiles(claimedEntry.eventsDir);
  const lastEventSeen = events.length > 0 ? events[events.length - 1] : claimedEvent.filename;

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          task_id: finalTask.id,
          stage: "tasks",
          path: claimedEntry.dir,
          task_path: claimedEntry.taskPath,
          claimed_event: claimedEvent.filename,
          last_event_seen: lastEventSeen,
          events,
          task: finalTask,
          instructions: readStandingInstructions(bucketDir, finalTask),
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

function cmdPost(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      bucket: { type: "string", short: "b" },
      entity: { type: "string", short: "e" },
      task: { type: "string" },
      type: { type: "string" },
      message: { type: "string", short: "m" },
      "body-file": { type: "string" },
      stdin: { type: "boolean", default: false },
      status: { type: "string" },
      "bump-revision": { type: "boolean", default: false },
      assignee: { type: "string" },
      "claimed-by": { type: "string" },
      "add-depends-on": { type: "string", multiple: true },
      "remove-depends-on": { type: "string", multiple: true },
      "check-ac": { type: "boolean", default: false },
      reopen: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printPostHelp();
    return 0;
  }

  if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
  const bucketDir = path.resolve(values.bucket);
  const entityId = validateIdentifier(values.entity, "--entity");
  const taskId = validateTaskId(values.task);
  const eventType = String(values.type || "").toLowerCase();
  if (!VALID_EVENT_TYPES.has(eventType)) {
    throw new CliError(
      `Invalid --type "${eventType}". Must be one of: ${Array.from(VALID_EVENT_TYPES).join(", ")}.`
    );
  }

  ensureBucketDirs(bucketDir);
  const found = findTask(bucketDir, taskId);
  if (!found) {
    throw new CliError(`Task "${taskId}" not found.`);
  }
  if (found.task.status === "complete" || found.task.status === "cancelled") {
    throw new CliError(`Task "${taskId}" is already ${found.task.status} and cannot be modified.`);
  }

  let targetStatus = values.status ? String(values.status).toLowerCase() : null;
  if (targetStatus && !VALID_STATUSES.has(targetStatus)) {
    throw new CliError(
      `Invalid --status "${targetStatus}". Must be one of: ${Array.from(VALID_STATUSES).join(", ")}.`
    );
  }

  // Convenience defaults for terminal/reset event types when --status is omitted
  if (!targetStatus) {
    if (eventType === "complete") targetStatus = "complete";
    else if (eventType === "cancelled") targetStatus = "cancelled";
    else if (eventType === "reset") targetStatus = "pending";
    else if (values.reopen) targetStatus = "pending";
  }

  const addDeps = parseListFlags(values["add-depends-on"]);
  const removeDeps = new Set(parseListFlags(values["remove-depends-on"]));
  for (const dep of addDeps) validateTaskId(dep);

  const mutatesTaskMd = Boolean(
    targetStatus ||
      values["bump-revision"] ||
      values.assignee !== undefined ||
      values["claimed-by"] !== undefined ||
      addDeps.length > 0 ||
      removeDeps.size > 0 ||
      values["check-ac"] ||
      values.reopen
  );

  // Enforce single-writer rule and late-sync split-brain guard on task.md
  let roundWinner = null;
  if (mutatesTaskMd) {
    const curStatus = found.task.status;
    if (curStatus === "in-progress" && eventType !== "reset") {
      const claimRound = Number(found.task.claim_round) || 1;
      const { winner } = getRoundClaims(found.eventsDir, claimRound);
      roundWinner = winner;
      if (winner) {
        if (winner.entityId !== entityId) {
          const isClaimedBy = entityId === found.task.claimed_by;
          throw new CliError(
            isClaimedBy
              ? `Split-brain claim conflict: round ${claimRound} winner is "${winner.entityId}", not "${entityId}".`
              : `Single-writer violation: task "${taskId}" is in-progress (claimed_by="${found.task.claimed_by}"); "${entityId}" may only append events without modifying task.md.`,
            isClaimedBy ? 2 : 1
          );
        }
      } else if (entityId !== found.task.claimed_by) {
        throw new CliError(
          `Single-writer violation: task "${taskId}" is in-progress (claimed_by="${found.task.claimed_by}"); "${entityId}" may only append events without modifying task.md.`
        );
      }
    } else if (curStatus === "blocked" || curStatus === "review") {
      if (found.task.owner && entityId !== found.task.owner && eventType !== "reset") {
        throw new CliError(
          `Single-writer violation: task "${taskId}" is ${curStatus} (owner="${found.task.owner}"); only owner may modify task.md.`
        );
      }
    } else if (curStatus === "draft" || curStatus === "ready" || curStatus === "pending") {
      if (found.task.owner && entityId !== found.task.owner && eventType !== "reset") {
        throw new CliError(
          `Single-writer violation: ${curStatus} task "${taskId}" belongs to owner "${found.task.owner}".`
        );
      }
    }

    if (
      (curStatus === "draft" || curStatus === "ready" || curStatus === "pending") &&
      targetStatus &&
      ["in-progress", "blocked", "review"].includes(targetStatus)
    ) {
      throw new CliError(
        `Invalid status transition: cannot set status "${targetStatus}" directly from status "${curStatus}".`
      );
    }
  }

  const now = new Date();
  const isoUtc = formatIsoUtc(now);
  const message = readBodyInput(values);
  if (eventType === "amend" && ["review", "blocked"].includes(found.task.status)) {
    console.error(`Warning: task "${taskId}" is ${found.task.status}; amend does not reopen it. Use feedback/answer --status pending to resume execution.`);
  }

  // 1. Payload-before-flag: write immutable event file first
  const eventResult = writeUniqueEvent(
    found.eventsDir,
    entityId,
    eventType,
    message,
    now
  );

  const updatedTask = { ...found.task };
  let updatedBody = found.body;

  // 2. Atomically update task.md if requested
  if (mutatesTaskMd) {
    const returningFromActive =
      (found.task.status === "in-progress" ||
        found.task.status === "blocked" ||
        found.task.status === "review") &&
      targetStatus === "pending";
    const returningToPinnedPending =
      (found.task.status === "blocked" || found.task.status === "review") &&
      targetStatus === "pending" &&
      !values.reopen &&
      eventType !== "reset";

    if (targetStatus) {
      updatedTask.status = targetStatus;
    }
    if (returningFromActive) {
      updatedTask.claim_round = (Number(updatedTask.claim_round) || 1) + 1;
    }
    if (values["bump-revision"] ||
        (["review", "blocked"].includes(found.task.status) &&
         targetStatus === "pending" && ["feedback", "answer"].includes(eventType))) {
      updatedTask.revision = (Number(updatedTask.revision) || 1) + 1;
    }
    if (values["claimed-by"] !== undefined) {
      if (values["claimed-by"]) validateIdentifier(values["claimed-by"], "--claimed-by");
      updatedTask.claimed_by = values["claimed-by"];
    } else if (
      targetStatus === "complete" ||
      targetStatus === "cancelled" ||
      eventType === "reset" ||
      values.reopen ||
      returningToPinnedPending ||
      returningFromActive
    ) {
      updatedTask.claimed_by = "";
    } else if (roundWinner && roundWinner.entityId === entityId) {
      // Heal claimed_by if a split-brain loser overwrote task.md via LWW sync
      updatedTask.claimed_by = entityId;
    }

    if (values.assignee !== undefined) {
      if (values.assignee) validateIdentifier(values.assignee, "--assignee");
      updatedTask.assignee = values.assignee;
    } else if (values.reopen || eventType === "reset") {
      updatedTask.assignee = "";
    } else if (returningToPinnedPending && !updatedTask.assignee && found.task.claimed_by) {
      updatedTask.assignee = found.task.claimed_by;
    }

    if (values["check-ac"]) {
      updatedBody = updatedBody.replace(/^(\s*[-*]\s+)\[ \]/gm, "$1[x]");
    }

    if (addDeps.length > 0 || removeDeps.size > 0) {
      const nextDeps = updatedTask.depends_on.filter((d) => !removeDeps.has(d));
      for (const dep of addDeps) {
        if (!nextDeps.includes(dep)) nextDeps.push(dep);
      }
      updatedTask.depends_on = nextDeps;
    }

    updatedTask.updated_by = entityId;
    updatedTask.updated_at = isoUtc;

    atomicWriteFile(found.taskPath, formatTaskMarkdown(updatedTask, updatedBody));
  }

  touchExistingEntity(bucketDir, entityId);

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          task_id: updatedTask.id,
          stage: "tasks",
          path: found.dir,
          event: eventResult.filename,
          task_updated: mutatesTaskMd,
          previous_revision: found.task.revision,
          previous_claim_round: found.task.claim_round,
          task: updatedTask,
        },
        null,
        2
      )
    );
  } else {
    console.log(`Posted ${eventResult.filename} to ${updatedTask.id}`);
    if (mutatesTaskMd) {
      console.log(
        `State: status=${updatedTask.status} revision=${found.task.revision}->${updatedTask.revision} claim_round=${found.task.claim_round}->${updatedTask.claim_round}`
      );
    }
  }
  return 0;
}

function cmdRender(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      bucket: { type: "string", short: "b" },
      task: { type: "string" },
      "after-event": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printRenderHelp();
    return 0;
  }

  if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
  const bucketDir = path.resolve(values.bucket);
  const taskId = validateTaskId(values.task);

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
          task_id: found.task.id,
          stage: found.stage,
          path: found.dir,
          claim_winner: claimWinner,
          task: found.task,
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
      if (ev.body) {
        out.push("");
        out.push(ev.body);
      }
    }
  }
  console.log(out.join("\n"));
  return 0;
}

async function cmdWatch(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      bucket: { type: "string", short: "b" },
      entity: { type: "string", short: "e" },
      task: { type: "string" },
      tag: { type: "string", multiple: true },
      tags: { type: "string", multiple: true },
      "include-untagged": { type: "boolean", default: false },
      "owner-only": { type: "boolean", default: false },
      "all-actionable": { type: "boolean", default: false },
      "exclude-task": { type: "string", multiple: true },
      "include-events": { type: "boolean", default: false },
      "event-lines": { type: "string", default: "5" },
      "after-event": { type: "string" },
      "after-msg": { type: "string" },
      "since-status": { type: "string" },
      "poll-ms": { type: "string", default: "1000" },
      "msg-coalesce-ms": {
        type: "string",
        default: String(DEFAULT_MSG_COALESCE_MS),
      },
      ttl: { type: "string" },
      timeout: { type: "string", default: "0" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    printWatchHelp();
    return 0;
  }

  if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
  const bucketDir = path.resolve(values.bucket);
  const watchTaskId = values.task ? validateTaskId(values.task) : null;
  const entityId = values.entity ? validateIdentifier(values.entity, "--entity") : null;
  const ownerOnly = Boolean(values["owner-only"]);
  const excludedTasks = new Set(values["exclude-task"] ?? []);
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

  const workerTags = new Set(
    normalizeTags([
      ...parseListFlags(values.tag),
      ...parseListFlags(values.tags),
    ])
  );
  const includeUntagged = Boolean(values["include-untagged"]);
  const pollMs = Math.max(50, Number.parseInt(values["poll-ms"], 10) || 1000);
  const parsedCoalesce = Number.parseInt(values["msg-coalesce-ms"], 10);
  const msgCoalesceMs = Number.isFinite(parsedCoalesce)
    ? Math.max(0, parsedCoalesce)
    : DEFAULT_MSG_COALESCE_MS;
  const timeoutSec = Math.max(0, Number.parseFloat(values.timeout) || 0);
  const ttlSec = values.ttl
    ? Math.max(10, Number.parseInt(values.ttl, 10) || DEFAULT_ENTITY_TTL_SECONDS)
    : undefined;

  ensureBucketDirs(bucketDir);

  if (!watchTaskId && entityId) {
    upsertEntityFile(bucketDir, entityId, {
      tags: Array.from(workerTags),
      include_untagged: includeUntagged,
      mode: ownerOnly ? "owner" : "worker",
      ...(ttlSec !== undefined ? { ttl_seconds: ttlSec } : {}),
    });
  }

  let initialTaskState = null;
  if (watchTaskId) {
    const initial = findTask(bucketDir, watchTaskId);
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
            task_id: watchTaskId,
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
          task_id: watchTaskId,
          reason: newEvents.length ? "new_events" : statusChanged ? "status_changed" : "appeared",
          stage: current.stage,
          path: current.dir,
          status: current.task.status,
          previous_status: baselineStatus,
          status_changed: statusChanged,
          stage_changed: stageChanged,
          new_events: newEvents,
          last_event_seen:
            currentEvents.length > 0 ? currentEvents[currentEvents.length - 1] : "",
          task: current.task,
          revision: current.task.revision,
          claim_round: current.task.claim_round,
          claimed_by: current.task.claimed_by,
          assignee: current.task.assignee,
          latest_event: currentEvents.length ? readEventFile(current.eventsDir, currentEvents.at(-1), values["include-events"], eventLines) : null,
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

    const eligible = ownerOnly
      ? []
      : findEligibleTasks(bucketDir, entityId, workerTags, includeUntagged)
        .filter((item) => !excludedTasks.has(item.task.id));
    const ownerTasks = findOwnerActionableTasks(bucketDir, entityId, values["all-actionable"])
      .filter((item) => !excludedTasks.has(item.task.id));
    const msgCursor =
      values["after-msg"] !== undefined
        ? values["after-msg"]
        : readEntityFile(bucketDir, entityId)?.last_msg_seen ?? "";
    const { matched: unreadMessages, latestFile: latestMsgFile } =
      findUnreadMessages(bucketDir, entityId, workerTags, msgCursor);

    if (
      eligible.length > 0 ||
      ownerTasks.length > 0 ||
      unreadMessages.length > 0
    ) {
      return {
        mode: ownerOnly ? "owner" : "ready",
        entity_id: entityId,
        count: eligible.length,
        tasks: eligible.map((item) => serializeTaskSummary(item, values["include-events"], eventLines)),
        owner_tasks: ownerTasks.map((item) => serializeTaskSummary(item, values["include-events"], eventLines)),
        messages: unreadMessages,
        last_msg_seen: latestMsgFile || msgCursor,
      };
    }
    return null;
  }

  function advanceMessageCursorIfNeeded(result) {
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
    } else {
      console.log(
        `Task update for ${result.task_id}: stage=${result.stage} status=${result.status} revision=${result.revision ?? "-"} claim_round=${result.claim_round ?? "-"} claimed_by=${result.claimed_by || "-"} assignee=${result.assignee || "-"}`
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
    if (event.body) console.log(event.body);
  }

  const immediate = evaluateOnce();
  isInitialEval = false;
  if (immediate) {
    advanceMessageCursorIfNeeded(immediate);
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
        advanceMessageCursorIfNeeded(result);
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

    if (!watchTaskId && entityId) {
      heartbeatTimer = setInterval(() => {
        try {
          upsertEntityFile(bucketDir, entityId);
        } catch {
          // ignore transient heartbeat failure
        }
      }, ENTITY_HEARTBEAT_MS);
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
    const { values } = parseArgs({
      args: rest,
      options: {
        bucket: { type: "string", short: "b" },
        entity: { type: "string", short: "e" },
        to: { type: "string", multiple: true },
        tag: { type: "string", multiple: true },
        tags: { type: "string", multiple: true },
        slug: { type: "string" },
        message: { type: "string", short: "m" },
        body: { type: "string" },
        "body-file": { type: "string" },
        stdin: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      printMsgHelp();
      return 0;
    }
    if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
    const bucketDir = path.resolve(values.bucket);
    const entityId = validateIdentifier(values.entity, "--entity");
    const body = readBodyInput(values);
    if (!body.trim()) {
      throw new CliError("Message body cannot be empty (pass -m, --body-file, or --stdin).");
    }

    const rawTo = parseListFlags(values.to);
    for (const r of rawTo) {
      if (r !== "*") validateIdentifier(r, "--to");
    }
    const tags = normalizeTags([
      ...parseListFlags(values.tag),
      ...parseListFlags(values.tags),
    ]);
    const toList = rawTo.length > 0 ? rawTo : tags.length > 0 ? [] : ["*"];

    ensureBucketDirs(bucketDir);
    const now = new Date();
    const res = writeUniqueMessage(
      path.join(bucketDir, "messages"),
      entityId,
      toList,
      tags,
      values.slug || "msg",
      body,
      now
    );
    touchExistingEntity(bucketDir, entityId);

    const payload = {
      filename: res.filename,
      path: res.path,
      from: entityId,
      to: toList,
      tags,
      timestamp: res.timestamp,
    };
    if (values.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Sent message ${res.filename} (to=${JSON.stringify(toList)} tags=${JSON.stringify(tags)})`);
    }
    return 0;
  }

  if (action === "list") {
    const { values } = parseArgs({
      args: rest,
      options: {
        bucket: { type: "string", short: "b" },
        entity: { type: "string", short: "e" },
        tag: { type: "string", multiple: true },
        tags: { type: "string", multiple: true },
        "after-msg": { type: "string" },
        unread: { type: "boolean", default: false },
        all: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      printMsgHelp();
      return 0;
    }
    if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
    const bucketDir = path.resolve(values.bucket);
    const entityId = values.entity ? validateIdentifier(values.entity, "--entity") : null;
    if (values.unread && !entityId) {
      throw new CliError("--unread requires --entity <id>.");
    }
    const workerTags = new Set(
      normalizeTags([
        ...parseListFlags(values.tag),
        ...parseListFlags(values.tags),
      ])
    );

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

  if (action === "register") {
    const { values } = parseArgs({
      args: rest,
      options: {
        bucket: { type: "string", short: "b" },
        entity: { type: "string", short: "e" },
        tag: { type: "string", multiple: true },
        tags: { type: "string", multiple: true },
        "include-untagged": { type: "boolean", default: false },
        mode: { type: "string" },
        ttl: { type: "string" },
        message: { type: "string", short: "m" },
        body: { type: "string" },
        "body-file": { type: "string" },
        stdin: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      printEntityHelp();
      return 0;
    }
    if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
    const bucketDir = path.resolve(values.bucket);
    const entityId = validateIdentifier(values.entity, "--entity");
    if (values.mode && !["once", "one-shot", "continuous", "owner", "worker"].includes(values.mode)) {
      throw new CliError(`Invalid --mode "${values.mode}".`);
    }
    ensureBucketDirs(bucketDir);
    const tags = normalizeTags([
      ...parseListFlags(values.tag),
      ...parseListFlags(values.tags),
    ]);
    const ttlSec = values.ttl
      ? Math.max(10, Number.parseInt(values.ttl, 10) || DEFAULT_ENTITY_TTL_SECONDS)
      : undefined;
    const note = readBodyInput(values);
    const saved = upsertEntityFile(bucketDir, entityId, {
      ...(values.tag || values.tags ? { tags } : {}),
      ...(values["include-untagged"] ? { include_untagged: true } : {}),
      ...(values.mode ? { mode: values.mode } : {}),
      ...(ttlSec !== undefined ? { ttl_seconds: ttlSec } : {}),
      ...(note ? { body: note } : {}),
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
    const { values } = parseArgs({
      args: rest,
      options: {
        bucket: { type: "string", short: "b" },
        online: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      printEntityHelp();
      return 0;
    }
    if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
    const bucketDir = path.resolve(values.bucket);
    let entities = listEntities(bucketDir);
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

  throw new CliError(`Unknown entity action "${action}". Expected: register, list.`);
}

function cmdTag(argv) {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h") {
    printTagHelp();
    return 0;
  }

  if (action === "set") {
    const { values } = parseArgs({
      args: rest,
      options: {
        bucket: { type: "string", short: "b" },
        entity: { type: "string", short: "e" },
        tag: { type: "string" },
        message: { type: "string", short: "m" },
        body: { type: "string" },
        "body-file": { type: "string" },
        stdin: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      printTagHelp();
      return 0;
    }
    if (!values.bucket) throw new CliError("Missing required --bucket <dir>.");
    const bucketDir = path.resolve(values.bucket);
    const entityId = validateIdentifier(values.entity, "--entity");
    const tagName = validateIdentifier(
      String(values.tag || "").trim().toLowerCase(),
      "--tag"
    );
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
    const { values } = parseArgs({
      args: rest,
      options: {
        bucket: { type: "string", short: "b" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      printTagHelp();
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
  console.log(`Usage: wb.mjs <subcommand> [options]

Subcommands:
  create   Create a new task in tasks/ with initial created event
  claim    Claim an eligible task via lockless 2-phase event election
  post     Append an immutable event to events/ and optionally transition task.md
  watch    Block with native fs.watch + 1000ms stat polling until work, owner update, or messages arrive
  render   Render task.md and chronologically sorted events/*.md
  msg      Send or list public messages in messages/
  entity   Register or list advisory entity presence in entities/
  tag      Document or list capability tags in tags/

Run "wb.mjs <subcommand> --help" for subcommand options.`);
}

function printCreateHelp() {
  console.log(`Usage: wb.mjs create --bucket <dir> --entity <id> --title <text> [options]
  --priority <low|medium|high|critical>  Task priority (default: medium)
  --tag <tag> / --tags <a,b>             Capability tags (repeatable / comma-separated)
  --assignee <entity_id>                 Optional target executor
  --parent <task_id>                     Optional parent task_id
  --depends-on <id1,id2>                 Upstream task_ids that must be complete
  --backlog / --draft                    Create with status "draft"
  --status <draft|ready|pending>         Initial status (default: pending)
  --workspace <path>                     Workspace path for default template
  --files <f1,f2>                        Relevant files for default template
  --description <text>                   Description for default template
  --ac <criterion>                       Acceptance criterion (repeatable)
  --body <markdown> | --body-file <path> | --stdin   Custom Markdown body
  --slug <slug>                          Override auto-generated task slug
  --json                                 Output JSON`);
}

function printClaimHelp() {
  console.log(`Usage: wb.mjs claim --bucket <dir> --entity <id> [options]
  --task <task_id>                       Claim a specific task (otherwise picks top eligible)
  --tag <tag> / --tags <a,b>             Capability tags (repeatable / comma-separated)
  --include-untagged                     Also accept untagged tasks when --tag is set
  --claim-settle-ms <ms>                 Settle wait before electing round winner (default: ${DEFAULT_CLAIM_SETTLE_MS})
  --json                                 Output JSON, including instructions: [{file, body}]
  Read optional INSTRUCTIONS.md and each task tag's tags/<tag>.md body before claiming/executing.`);
}

function printPostHelp() {
  console.log(`Usage: wb.mjs post --bucket <dir> --entity <id> --task <id> --type <type> [options]
  --type <type>                          created|claimed|amend|question|answer|log|review|feedback|complete|cancelled|reset
  --message <text> | --body-file <path> | --stdin    Event body
  --status <status>                      draft|ready|pending|in-progress|blocked|review|complete|cancelled
  --bump-revision                        Increment revision (feedback/answer to pending already bump once)
  --assignee <id>                        Update assignee (pass "" to clear)
  --claimed-by <id>                      Update claimed_by (pass "" to clear)
  --add-depends-on <id1,id2>             Append task IDs to depends_on
  --remove-depends-on <id1,id2>          Remove task IDs from depends_on
  --check-ac                             Check all '- [ ]' acceptance criteria boxes to '- [x]'
  --reopen                               Reset status to pending, increment claim_round, clear claimed_by/assignee
  --json                                 Output JSON, including previous_revision/previous_claim_round
  Feedback/answer returning review/blocked to pending automatically increment revision and claim_round.
  Amend on review/blocked warns; it does not reopen the task.`);
}

function printWatchHelp() {
  console.log(`Usage: wb.mjs watch --bucket <dir> [--entity <id>] [--task <id>] [options]
  --entity <id>                          Watch for tasks, owned blocked/review tasks, and unread messages
  --owner-only                           Do not wake for claimable tasks (owner updates + messages only)
  --all-actionable                       Include all owned review/blocked tasks, even already delivered
  --exclude-task <id>                    Exclude a task from pool/owner results (repeatable)
  --event-lines <N>                      Event body preview lines (default: 5; 0 for metadata only)
  --include-events                       Include full bodies instead of previews
  --task <task_id>                       Watch a specific task for new events or status change
  --tag <tag> / --tags <a,b>             Capability tags (repeatable / comma-separated)
  --include-untagged                     Also match untagged tasks when --tag is set
  --after-event <filename>               Wake immediately if events newer than filename exist
  --after-msg <filename>                 Override stored last_msg_seen cursor
  --since-status <status>                Wake immediately if task status differs from status
  --poll-ms <ms>                         Stat polling fallback interval (default: 1000)
  --msg-coalesce-ms <ms>                 Quiet window for message-only bursts (default: 500)
  --ttl <seconds>                        Entity presence TTL in seconds (default: 300)
  --timeout <seconds>                    Optional timeout (exits 124)
  --json                                 Output JSON
  Pool watches skip pending tasks with any claimed event for the current claim_round.
  Owner updates are edge-triggered; delivery stores per-task owner_task_seen cursors in entities/<id>.md.
  Task summaries include revision, claim_round, claimed_by, assignee and latest_event
  {filename,type,entity_id,timestamp,body,truncated}. --task also includes events for new_events filenames.
  --include-events expands only the surfaced events, not the entire task history.`);
}

function printRenderHelp() {
  console.log(`Usage: wb.mjs render --bucket <dir> --task <task_id> [options]
  --after-event <filename>               Only include events newer than filename
  --json                                 Output JSON`);
}

function printMsgHelp() {
  console.log(`Usage: wb.mjs msg <send|list> --bucket <dir> [options]
  send --entity <id> [--to <id|*,...>] [--tag <t>] [--slug <s>] -m <text> [--json]
  list [--entity <id>] [--tag <t>] [--after-msg <file>] [--unread] [--all] [--json]`);
}

function printEntityHelp() {
  console.log(`Usage: wb.mjs entity <register|list> --bucket <dir> [options]
  register --entity <id> [--tag <t>] [--include-untagged] [--mode <m>] [--ttl <sec>] [-m <note>] [--json]
  list [--online] [--json]`);
}

function printTagHelp() {
  console.log(`Usage: wb.mjs tag <set|list> --bucket <dir> [options]
  set --entity <id> --tag <name> [-m <description>] [--json]
  list [--json]`);
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
      return cmdPost(rest);
    case "watch":
      return await cmdWatch(rest);
    case "render":
      return cmdRender(rest);
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
      if (err instanceof CliError) {
        console.error(err.message);
        process.exitCode = err.exitCode;
      } else {
        console.error(err?.stack || String(err));
        process.exitCode = 1;
      }
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
};
