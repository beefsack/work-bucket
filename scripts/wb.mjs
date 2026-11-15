#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const VALID_STATUSES = new Set([
  "pending",
  "in-progress",
  "blocked",
  "review",
  "complete",
  "cancelled",
]);

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
  for (const sub of ["pending", "active", "archive"]) {
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
      if (key === "tags" || key === "depends_on") {
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
  const fm = serializeFrontmatter(data, ["type", "entity_id", "timestamp"]);
  const trimmedBody = String(body || "").replace(/\r/g, "").trim();
  if (!trimmedBody) return `${fm}\n`;
  return `${fm}\n\n${trimmedBody}\n`;
}

function readTaskFile(taskPath) {
  const raw = fs.readFileSync(taskPath, "utf8");
  const { data, body } = parseFrontmatter(raw);
  const task = {
    id: String(data.id ?? ""),
    title: String(data.title ?? ""),
    status: String(data.status ?? "pending"),
    priority: String(data.priority ?? "medium"),
    tags: normalizeTags(Array.isArray(data.tags) ? data.tags : []),
    owner: String(data.owner ?? ""),
    claimed_by: String(data.claimed_by ?? ""),
    assignee: String(data.assignee ?? ""),
    parent: String(data.parent ?? ""),
    depends_on: Array.isArray(data.depends_on)
      ? data.depends_on.map((d) => String(d))
      : [],
    revision:
      typeof data.revision === "number"
        ? data.revision
        : Number.parseInt(String(data.revision || "1"), 10) || 1,
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

function listStageTasks(bucketDir, stage) {
  const stageDir = path.join(bucketDir, stage);
  let entries;
  try {
    entries = fs.readdirSync(stageDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const tasks = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!entry.isDirectory()) continue;
    const dir = path.join(stageDir, entry.name);
    const taskPath = path.join(dir, "task.md");
    try {
      const { task, body } = readTaskFile(taskPath);
      if (!task.id) task.id = entry.name;
      tasks.push({
        stage,
        dirName: entry.name,
        dir,
        taskPath,
        eventsDir: path.join(dir, "events"),
        task,
        body,
      });
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") {
        // Ignore folders missing task.md or moved mid-scan
        continue;
      }
      throw err;
    }
  }
  return tasks;
}

function scanAllTasks(bucketDir) {
  const active = listStageTasks(bucketDir, "active");
  const pending = listStageTasks(bucketDir, "pending");
  const archive = listStageTasks(bucketDir, "archive");
  const byId = new Map();
  for (const item of [...active, ...pending, ...archive]) {
    byId.set(item.task.id || item.dirName, item);
  }
  return { active, pending, archive, byId };
}

function findTask(bucketDir, taskId) {
  validateTaskId(taskId);
  for (const stage of ["active", "pending", "archive"]) {
    const dir = path.join(bucketDir, stage, taskId);
    const taskPath = path.join(dir, "task.md");
    try {
      const { task, body } = readTaskFile(taskPath);
      if (!task.id) task.id = taskId;
      return {
        stage,
        dirName: taskId,
        dir,
        taskPath,
        eventsDir: path.join(dir, "events"),
        task,
        body,
      };
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") continue;
      throw err;
    }
  }
  return null;
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

function writeUniqueEvent(eventsDir, entityId, eventType, body, now = new Date()) {
  fs.mkdirSync(eventsDir, { recursive: true });
  const compactUtc = formatCompactUtc(now);
  const isoUtc = formatIsoUtc(now);
  const content = formatEventMarkdown(
    {
      type: eventType,
      entity_id: entityId,
      timestamp: isoUtc,
    },
    body
  );

  for (let seq = 1; seq < 1000; seq += 1) {
    const suffix = seq === 1 ? "" : `-${seq}`;
    const filename = `${compactUtc}-${entityId}-${eventType}${suffix}.md`;
    const targetPath = path.join(eventsDir, filename);
    if (fs.existsSync(targetPath)) continue;
    tmpCounter += 1;
    const tmpPath = path.join(
      eventsDir,
      `.${filename}.${process.pid}.${tmpCounter}.tmp`
    );
    try {
      fs.writeFileSync(tmpPath, content, { encoding: "utf8", flag: "wx" });
      // Ensure target wasn't created concurrently before rename
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(tmpPath);
        continue;
      }
      fs.renameSync(tmpPath, targetPath);
      return { filename, path: targetPath, timestamp: isoUtc };
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
  throw new CliError("Failed to allocate unique event filename after 1000 attempts.");
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
  return taskTags.every((t) => workerTags.has(t));
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

function findEligibleTasks(bucketDir, entityId, workerTags, includeUntagged) {
  const { active, pending, byId } = scanAllTasks(bucketDir);

  const activeMine = active
    .filter(
      (item) =>
        item.task.status === "pending" &&
        item.task.assignee === entityId &&
        dependenciesSatisfied(item.task, byId)
    )
    .sort(sortByPriorityAndAge);

  const pendingPool = pending
    .filter(
      (item) =>
        item.task.status === "pending" &&
        item.task.claimed_by === "" &&
        matchesTags(item.task, entityId, workerTags, includeUntagged) &&
        dependenciesSatisfied(item.task, byId)
    )
    .sort(sortByPriorityAndAge);

  return [...activeMine, ...pendingPool];
}

function getActiveWipTasks(bucketDir, entityId) {
  const active = listStageTasks(bucketDir, "active");
  return active.filter(
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
  for (let seq = 1; seq < 1000; seq += 1) {
    const candidate = `${compactUtc}-${baseSlug}${seq === 1 ? "" : `-${seq}`}`;
    const inActiveOrArchive =
      fs.existsSync(path.join(bucketDir, "active", candidate)) ||
      fs.existsSync(path.join(bucketDir, "archive", candidate));
    if (inActiveOrArchive) continue;

    const candidateDir = path.join(bucketDir, "pending", candidate);
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
    status: "pending",
    priority,
    tags,
    owner: entityId,
    claimed_by: "",
    assignee: values.assignee || "",
    parent: values.parent || "",
    depends_on: dependsOn,
    revision: 1,
    updated_by: entityId,
    updated_at: isoUtc,
  };

  const taskPath = path.join(taskDir, "task.md");
  atomicWriteFile(taskPath, formatTaskMarkdown(taskData, body));

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          task_id: taskId,
          stage: "pending",
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
    console.log(`Created ${taskId} in ${taskDir}`);
    console.log(`Event: ${createdEvent.filename}`);
  }
  return 0;
}

function cmdClaim(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      bucket: { type: "string", short: "b" },
      entity: { type: "string", short: "e" },
      task: { type: "string" },
      tag: { type: "string", multiple: true },
      tags: { type: "string", multiple: true },
      "include-untagged": { type: "boolean", default: false },
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
      (found.stage === "active" &&
        found.task.status === "pending" &&
        found.task.assignee === entityId &&
        dependenciesSatisfied(found.task, byId)) ||
      (found.stage === "pending" &&
        found.task.status === "pending" &&
        found.task.claimed_by === "" &&
        matchesTags(found.task, entityId, workerTags, includeUntagged) &&
        dependenciesSatisfied(found.task, byId));
    if (!eligible) {
      throw new CliError(
        `Task "${values.task}" is not eligible for "${entityId}" (stage=${found.stage}, status=${found.task.status}).`,
        2
      );
    }
    candidates = [found];
  } else {
    candidates = findEligibleTasks(bucketDir, entityId, workerTags, includeUntagged);
    if (candidates.length === 0) {
      throw new CliError(`No eligible tasks available for "${entityId}".`, 2);
    }
  }

  let claimedEntry = null;
  for (const candidate of candidates) {
    if (candidate.stage === "pending") {
      const destDir = path.join(bucketDir, "active", candidate.dirName);
      try {
        fs.renameSync(candidate.dir, destDir);
      } catch (err) {
        if (err.code === "ENOENT" || err.code === "EEXIST" || err.code === "ENOTEMPTY") {
          // Lost claim race to another entity
          continue;
        }
        throw err;
      }
      claimedEntry = {
        ...candidate,
        stage: "active",
        dir: destDir,
        taskPath: path.join(destDir, "task.md"),
        eventsDir: path.join(destDir, "events"),
      };
      break;
    } else {
      claimedEntry = candidate;
      break;
    }
  }

  if (!claimedEntry) {
    throw new CliError("Lost claim race; no remaining eligible tasks.", 2);
  }

  const now = new Date();
  const isoUtc = formatIsoUtc(now);
  const { task: freshTask, body: freshBody } = readTaskFile(claimedEntry.taskPath);
  const claimedEvent = writeUniqueEvent(
    claimedEntry.eventsDir,
    entityId,
    "claimed",
    `Claimed by ${entityId}.`,
    now
  );

  freshTask.status = "in-progress";
  freshTask.claimed_by = entityId;
  freshTask.updated_by = entityId;
  freshTask.updated_at = isoUtc;
  atomicWriteFile(claimedEntry.taskPath, formatTaskMarkdown(freshTask, freshBody));

  const events = listEventFiles(claimedEntry.eventsDir);
  const lastEventSeen = events.length > 0 ? events[events.length - 1] : claimedEvent.filename;

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          task_id: freshTask.id,
          stage: "active",
          path: claimedEntry.dir,
          task_path: claimedEntry.taskPath,
          claimed_event: claimedEvent.filename,
          last_event_seen: lastEventSeen,
          events,
          task: freshTask,
        },
        null,
        2
      )
    );
  } else {
    console.log(`Claimed ${freshTask.id} (${claimedEntry.dir})`);
    console.log(`Title: ${freshTask.title}`);
    console.log(`Priority: ${freshTask.priority} | Tags: ${JSON.stringify(freshTask.tags)}`);
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
  if (found.stage === "archive") {
    throw new CliError(`Task "${taskId}" is already in archive/ and cannot be modified.`);
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
      values.reopen
  );

  // Enforce single-writer rule on task.md
  if (mutatesTaskMd) {
    const curStatus = found.task.status;
    if (curStatus === "in-progress") {
      if (entityId !== found.task.claimed_by && eventType !== "reset") {
        throw new CliError(
          `Single-writer violation: task "${taskId}" is in-progress (claimed_by="${found.task.claimed_by}"); "${entityId}" may only append events without modifying task.md.`
        );
      }
    } else if (curStatus === "blocked" || curStatus === "review") {
      if (entityId !== found.task.owner) {
        throw new CliError(
          `Single-writer violation: task "${taskId}" is ${curStatus} (owner="${found.task.owner}"); only owner may modify task.md.`
        );
      }
    } else if (curStatus === "pending" && found.stage === "pending") {
      if (entityId !== found.task.owner && eventType !== "reset") {
        throw new CliError(
          `Single-writer violation: unclaimed pending task "${taskId}" belongs to owner "${found.task.owner}".`
        );
      }
    } else if (curStatus === "pending" && found.stage === "active") {
      if (entityId !== found.task.owner && eventType !== "reset") {
        throw new CliError(
          `Single-writer violation: active pending task "${taskId}" may only be modified by owner "${found.task.owner}" (or claimed via 'claim').`
        );
      }
    }
  }

  const now = new Date();
  const isoUtc = formatIsoUtc(now);
  const message = readBodyInput(values);

  // 1. Payload-before-flag: write immutable event file first
  const eventResult = writeUniqueEvent(
    found.eventsDir,
    entityId,
    eventType,
    message,
    now
  );

  let finalStage = found.stage;
  let finalDir = found.dir;
  const updatedTask = { ...found.task };

  // 2. Atomically update task.md if requested
  if (mutatesTaskMd) {
    if (targetStatus) {
      updatedTask.status = targetStatus;
    }
    if (values["bump-revision"]) {
      updatedTask.revision = (Number(updatedTask.revision) || 1) + 1;
    }
    if (values["claimed-by"] !== undefined) {
      if (values["claimed-by"]) validateIdentifier(values["claimed-by"], "--claimed-by");
      updatedTask.claimed_by = values["claimed-by"];
    } else if (
      targetStatus === "complete" ||
      targetStatus === "cancelled" ||
      eventType === "reset" ||
      values.reopen
    ) {
      updatedTask.claimed_by = "";
    }

    if (values.assignee !== undefined) {
      if (values.assignee) validateIdentifier(values.assignee, "--assignee");
      updatedTask.assignee = values.assignee;
    } else if (values.reopen || eventType === "reset") {
      updatedTask.assignee = "";
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

    atomicWriteFile(found.taskPath, formatTaskMarkdown(updatedTask, found.body));

    // 3. Directory stage moves (after payload & task.md update)
    if (updatedTask.status === "complete" || updatedTask.status === "cancelled") {
      const archiveDir = path.join(bucketDir, "archive", found.dirName);
      fs.renameSync(found.dir, archiveDir);
      finalStage = "archive";
      finalDir = archiveDir;
    } else if (
      found.stage === "active" &&
      (values.reopen || eventType === "reset") &&
      updatedTask.status === "pending"
    ) {
      const pendingDir = path.join(bucketDir, "pending", found.dirName);
      fs.renameSync(found.dir, pendingDir);
      finalStage = "pending";
      finalDir = pendingDir;
    }
  }

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          task_id: updatedTask.id,
          stage: finalStage,
          path: finalDir,
          event: eventResult.filename,
          task_updated: mutatesTaskMd,
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
        `State: stage=${finalStage} status=${updatedTask.status} revision=${updatedTask.revision}`
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
    const { data, body } = parseFrontmatter(raw);
    return {
      filename,
      type: String(data.type ?? ""),
      entity_id: String(data.entity_id ?? ""),
      timestamp: String(data.timestamp ?? ""),
      body: body.trim(),
    };
  });

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          task_id: found.task.id,
          stage: found.stage,
          path: found.dir,
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
  out.push(`<!-- stage: ${found.stage} | path: ${found.dir} -->`);
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
      "after-event": { type: "string" },
      "since-status": { type: "string" },
      "poll-ms": { type: "string", default: "1000" },
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

  if (!watchTaskId && !entityId) {
    throw new CliError("watch requires --entity <id> (for claimable tasks) or --task <id>.");
  }

  const workerTags = new Set(
    normalizeTags([
      ...parseListFlags(values.tag),
      ...parseListFlags(values.tags),
    ])
  );
  const includeUntagged = Boolean(values["include-untagged"]);
  const pollMs = Math.max(50, Number.parseInt(values["poll-ms"], 10) || 1000);
  const timeoutSec = Math.max(0, Number.parseFloat(values.timeout) || 0);

  ensureBucketDirs(bucketDir);

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
      // Stat task.md to keep SMB/NFS client cache fresh during polling
      try {
        fs.statSync(current.taskPath);
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
        };
      }
      return null;
    }

    // Mode (a): watch for claimable tasks for entityId
    for (const sub of ["pending", "active", "archive"]) {
      try {
        fs.statSync(path.join(bucketDir, sub));
      } catch {
        // ignore
      }
    }

    const eligible = findEligibleTasks(
      bucketDir,
      entityId,
      workerTags,
      includeUntagged
    );
    if (eligible.length > 0) {
      return {
        mode: "ready",
        entity_id: entityId,
        count: eligible.length,
        tasks: eligible.map((item) => ({
          id: item.task.id,
          title: item.task.title,
          stage: item.stage,
          status: item.task.status,
          priority: item.task.priority,
          tags: item.task.tags,
          owner: item.task.owner,
          assignee: item.task.assignee,
          path: item.dir,
        })),
      };
    }
    return null;
  }

  function printResult(result) {
    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.mode === "ready") {
      console.log(`Ready tasks for ${result.entity_id} (${result.count}):`);
      for (const t of result.tasks) {
        console.log(
          `- ${t.id} [${t.priority}] (${t.stage}/${t.status}) tags=${JSON.stringify(t.tags)} :: ${t.title}`
        );
      }
    } else {
      console.log(
        `Task update for ${result.task_id}: stage=${result.stage} status=${result.status}`
      );
      if (result.status_changed) {
        console.log(`Status changed: ${result.previous_status} -> ${result.status}`);
      }
      if (result.new_events.length > 0) {
        console.log(`New events: ${result.new_events.join(", ")}`);
      }
    }
  }

  const immediate = evaluateOnce();
  isInitialEval = false;
  if (immediate) {
    printResult(immediate);
    return 0;
  }

  return await new Promise((resolve) => {
    let settled = false;
    let debounceTimer = null;
    let pollTimer = null;
    let timeoutTimer = null;
    const watchers = [];

    function cleanup() {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (pollTimer) clearInterval(pollTimer);
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
      if (result) printResult(result);
      resolve(code);
    }

    function checkAndFinish() {
      if (settled) return;
      try {
        const res = evaluateOnce();
        if (res) finish(0, res);
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
      if (filename && path.basename(String(filename)).startsWith(".")) return;
      scheduleCheck();
    };

    try {
      watchers.push(fs.watch(bucketDir, { recursive: true }, onWatchEvent));
    } catch {
      // Fallback on platforms/mounts without recursive fs.watch: watch top-level stage dirs + polling
      for (const sub of ["pending", "active", "archive"]) {
        try {
          watchers.push(fs.watch(path.join(bucketDir, sub), onWatchEvent));
        } catch {
          // polling fallback handles it
        }
      }
    }

    pollTimer = setInterval(checkAndFinish, pollMs);

    if (timeoutSec > 0) {
      timeoutTimer = setTimeout(() => {
        console.error(`Watch timed out after ${timeoutSec}s.`);
        finish(124);
      }, timeoutSec * 1000);
    }
  });
}

function printMainHelp() {
  console.log(`Usage: wb.mjs <subcommand> [options]

Subcommands:
  create   Create a new task in pending/ with initial created event
  claim    Atomically claim an eligible task from pending/ or resume assigned active/ task
  post     Append an immutable event to events/ and optionally transition task.md
  watch    Block with native fs.watch + 1000ms stat polling until work or update arrives
  render   Render task.md and chronologically sorted events/*.md

Run "wb.mjs <subcommand> --help" for subcommand options.`);
}

function printCreateHelp() {
  console.log(`Usage: wb.mjs create --bucket <dir> --entity <id> --title <text> [options]
  --priority <low|medium|high|critical>  Task priority (default: medium)
  --tag <tag> / --tags <a,b>             Capability tags (repeatable / comma-separated)
  --assignee <entity_id>                 Optional target executor
  --parent <task_id>                     Optional parent task_id
  --depends-on <id1,id2>                 Upstream task_ids that must be complete
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
  --json                                 Output JSON`);
}

function printPostHelp() {
  console.log(`Usage: wb.mjs post --bucket <dir> --entity <id> --task <id> --type <type> [options]
  --type <type>                          created|claimed|amend|question|answer|log|review|feedback|complete|cancelled|reset
  --message <text> | --body-file <path> | --stdin    Event body
  --status <status>                      pending|in-progress|blocked|review|complete|cancelled
  --bump-revision                        Increment task.md revision
  --assignee <id>                        Update assignee (pass "" to clear)
  --claimed-by <id>                      Update claimed_by (pass "" to clear)
  --add-depends-on <id1,id2>             Append task IDs to depends_on
  --remove-depends-on <id1,id2>          Remove task IDs from depends_on
  --reopen                               Move active task back to pending/ and clear claimed_by/assignee
  --json                                 Output JSON`);
}

function printWatchHelp() {
  console.log(`Usage: wb.mjs watch --bucket <dir> [--entity <id>] [--task <id>] [options]
  --entity <id>                          Watch for claimable tasks for entity
  --task <task_id>                       Watch a specific task for new events or status change
  --tag <tag> / --tags <a,b>             Capability tags (repeatable / comma-separated)
  --include-untagged                     Also match untagged tasks when --tag is set
  --after-event <filename>               Wake immediately if events newer than filename exist
  --since-status <status>                Wake immediately if task status differs from status
  --poll-ms <ms>                         Stat polling fallback interval (default: 1000)
  --timeout <seconds>                    Optional timeout (exits 124)
  --json                                 Output JSON`);
}

function printRenderHelp() {
  console.log(`Usage: wb.mjs render --bucket <dir> --task <task_id> [options]
  --after-event <filename>               Only include events newer than filename
  --json                                 Output JSON`);
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
      return cmdClaim(rest);
    case "post":
      return cmdPost(rest);
    case "watch":
      return await cmdWatch(rest);
    case "render":
      return cmdRender(rest);
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
  parseFrontmatter,
  serializeFrontmatter,
  slugify,
};
