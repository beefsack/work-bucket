import { parseArgs } from "node:util";

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const string = (description, extra = {}) => ({ type: "string", description, ...extra });
const boolean = (description, extra = {}) => ({ type: "boolean", default: false, description, ...extra });
const list = (description) => string(`${description} (repeatable, comma-separated)`, { multiple: true });
const bucket = { bucket: string("Bucket directory", { short: "b" }) };
const writer = {
  ...bucket,
  entity: string("Acting entity", { short: "e" }),
  "session-nonce": string("Optional session marker; overrides WB_SESSION_NONCE"),
};
const taskWriter = { ...writer, task: string("Task ID") };
const body = {
  message: string("Body text; exclusive with --body-file/--stdin", { short: "m" }),
  "body-file": string("Read body from a file"),
  stdin: boolean("Read body from standard input"),
};
const filters = {
  tag: list("Capability tags (OR matching)"),
  "include-untagged": boolean("Include untagged tasks when filtering tags"),
};
const dependencies = {
  "add-depends-on": list("Add dependency task IDs"),
  "remove-depends-on": list("Remove dependency task IDs"),
};
const common = {
  json: boolean("Output JSON"),
  help: boolean("Show command help", { short: "h" }),
};
const event = { ...taskWriter, ...body };
const checkpoint = {
  "files-touched": list("Files changed or inspected"),
  resources: list("Processes, helpers, temporary directories or other resources"),
  pid: string("Resource process ID"), host: string("Resource host"),
  notes: string("Checkpoint state and cleanup/resume notes"),
};

export const COMMANDS = {
  create: { description: "Create a task owned by the acting entity",
    example: ["--bucket", "<bucket>", "--entity", "owner", "--title", "Example task", "-m", "Task-specific brief"],
    options: {
    ...writer, ...body, title: string("Task title", { short: "t" }),
    priority: string("low|medium|high|critical", { short: "p", default: "medium" }),
    tag: filters.tag, assignee: string("Optional target entity"), parent: string("Parent task ID"),
    "depends-on": list("Dependency task IDs"), workspace: string("Workspace for the default template"),
    files: list("Relevant files"), description: string("Default-template description"),
    ac: list("Acceptance criteria"), "ttl-seconds": string("Task liveness TTL override (positive seconds)"),
    slug: string("Override task slug"), backlog: boolean("Create a draft"), draft: boolean("Create a draft"),
    status: string("Initial draft|ready|pending status"),
  } },
  claim: { description: "Claim eligible work through a settled election",
    example: ["--bucket", "<bucket>", "--entity", "executor", "--task", "<task>"], options: {
    ...taskWriter, ...filters, dispatcher: string("Recorded dispatcher; defaults to WB_DISPATCHER"),
  } },
  promote: { description: "Promote draft/ready work toward pending",
    example: ["--bucket", "<bucket>", "--entity", "owner", "--task", "<task>", "--status", "ready"], options: {
    ...event, status: string("Target ready|pending (default pending)"),
  } },
  demote: { description: "Hold unclaimed ready/pending work",
    example: ["--bucket", "<bucket>", "--entity", "owner", "--task", "<task>"], options: {
    ...event, status: string("Target draft|ready (default ready)"),
  } },
  amend: { description: "Append an owner correction; refine unclaimed metadata",
    example: ["--bucket", "<bucket>", "--entity", "owner", "--task", "<task>", "-m", "Additional requirement"], options: {
    ...event, assignee: string("Set assignee on unclaimed draft/ready/pending tasks; empty clears"),
    ...dependencies, "ttl-seconds": string("Set task liveness TTL on unclaimed work"),
    "all-in-progress": boolean("Amend matching in-progress tasks owned by the caller"),
    owner: string("Bulk owner filter"), tag: filters.tag,
  } },
  review: { description: "Submit per-criterion verdicts for owner review",
    example: ["--bucket", "<bucket>", "--entity", "executor", "--task", "<task>", "--ac", "1=pass", "--proposed-outcome", "pass", "-m", "Evidence and unverified items"], options: {
    ...event, ac: list("Criterion N=pass|fail|not-run, one verdict per criterion"),
    "proposed-outcome": string("Proposed outcome pass|partial|fail|abandoned"),
  } },
  question: { description: "Block execution on an owner decision",
    example: ["--bucket", "<bucket>", "--entity", "executor", "--task", "<task>", "-m", "Decision required"], options: { ...event } },
  feedback: { description: "Return reviewed work to pinned pending",
    example: ["--bucket", "<bucket>", "--entity", "owner", "--task", "<task>", "-m", "Changes required"], options: {
    ...event, reopen: boolean("Return to the unassigned pool instead"),
  } },
  answer: { description: "Return blocked work to pinned pending",
    example: ["--bucket", "<bucket>", "--entity", "owner", "--task", "<task>", "-m", "Decision supplied"], options: {
    ...event, reopen: boolean("Return to the unassigned pool instead"),
  } },
  reset: { description: "Owner recovery: clear an in-progress claim and pin",
    example: ["--bucket", "<bucket>", "--entity", "owner", "--task", "<task>", "-m", "Recovery inspected"], options: { ...event } },
  release: { description: "Claimant or recorded dispatcher returns work with a checkpoint",
    example: ["--bucket", "<bucket>", "--entity", "executor", "--task", "<task>", "--notes", "No resources remain; resume from current tree"],
    options: { ...event, ...checkpoint } },
  checkpoint: { description: "Record structured work and resource state",
    example: ["--bucket", "<bucket>", "--entity", "executor", "--task", "<task>", "--notes", "Tree inspected"],
    options: { ...event, ...checkpoint } },
  run: { description: "Run a command with process-backed heartbeats and checkpoints",
    example: ["--bucket", "<bucket>", "--entity", "executor", "--task", "<task>", "--", "node", "-e", "process.exit(0)"],
    options: { ...taskWriter, log: string("Redirect command stdout/stderr to this file (append)") } },
  status: { description: "Read active tasks, waiting parties, runtime and advisory alerts",
    example: ["--bucket", "<bucket>", "--owner", "owner", "--json"],
    options: { ...bucket, owner: string("Filter task owner") } },
  complete: { description: "Owner closure of non-terminal work",
    example: ["--bucket", "<bucket>", "--entity", "owner", "--task", "<task>", "--outcome", "pass"], options: {
    ...event, outcome: string("pass|partial|fail|abandoned"),
    "accept-ac": boolean("Apply latest current-round review verdicts to the brief"),
  } },
  cancel: { description: "Owner cancellation of non-terminal work",
    example: ["--bucket", "<bucket>", "--entity", "owner", "--task", "<task>", "--outcome", "abandoned"], options: {
    ...event, outcome: string("pass|partial|fail|abandoned"),
  } },
  log: { description: "Append a free-form task log without changing state",
    example: ["--bucket", "<bucket>", "--entity", "owner", "--task", "<task>", "-m", "Observation"], options: { ...event } },
  post: { description: "Append a free-form log or note only",
    example: ["--bucket", "<bucket>", "--entity", "owner", "--task", "<task>", "--type", "note", "-m", "Observation"], options: {
    ...event, type: string("log|note (default log)"),
  } },
  "accept-amends": { description: "Claimant incorporation and receipt of pending amendments",
    example: ["--bucket", "<bucket>", "--entity", "executor", "--task", "<task>", "-m", "Corrections incorporated"], options: {
    ...event, "ignore-amend": list("Amendment event filenames to exclude from incorporation"),
    reason: string("Reason for ignored amendments"),
  } },
  "ack-instructions": { description: "Print standing-rule changes and acknowledge the current version",
    example: ["--bucket", "<bucket>", "--entity", "executor", "--task", "<task>"], options: { ...taskWriter } },
  render: { description: "Render a task summary, body and event history",
    example: ["--bucket", "<bucket>", "--task", "<task>", "--tail-events", "3", "--json"], options: {
    ...bucket, task: string("Task ID"), "after-event": string("Only events after this filename"),
    "tail-events": string("Keep the last N matching events (0 allowed)"),
    "latest-event": boolean("Keep only the latest matching event"),
  } },
  list: { description: "List task summaries",
    example: ["--bucket", "<bucket>", "--status", "pending,review", "--owner", "owner", "--json"], options: {
    ...bucket, status: list("Lifecycle states"), tag: filters.tag, owner: string("Owner entity"),
    assignee: string("Assigned entity"), "claimed-by": string("Claimant entity"),
  } },
  fsck: { description: "Replay snapshots; never repair terminal history",
    example: ["--bucket", "<bucket>", "--json"], options: {
    ...bucket, repair: boolean("Repair unambiguous non-terminal frontmatter"),
  } },
  watch: { description: "Wait for work, owner updates or notices",
    example: ["--bucket", "<bucket>", "--entity", "executor", "--timeout", "1", "--json"], options: {
    ...taskWriter, ...filters, "owner-only": boolean("Only owned updates, alerts and notices"),
    "all-actionable": boolean("Include already-delivered actionable work"),
    "exclude-task": list("Exclude dispatched task IDs"), "include-events": boolean("Expand surfaced event bodies"),
    "event-lines": string("Preview line count", { default: "5" }),
    "after-event": string("Task event cursor"), "after-msg": string("Override message cursor"),
    "since-status": string("Task status baseline"), "poll-ms": string("Polling interval", { default: "1000" }),
    timeout: string("Timeout seconds; 0 waits indefinitely", { default: "0" }),
  } },
  "bucket pause": { description: "Pause new executor claims",
    example: ["--bucket", "<bucket>", "-m", "Await decision"], options: { ...bucket, ...body } },
  "bucket resume": { description: "Resume executor claims",
    example: ["--bucket", "<bucket>"], options: { ...bucket } },
  "msg send": { description: "Publish a public notice",
    example: ["--bucket", "<bucket>", "--entity", "owner", "--to", "*", "-m", "Public notice"], options: {
    ...writer, ...body, to: list("Recipients (* broadcasts)"), tag: filters.tag, slug: string("Notice slug"),
    force: boolean("Human override for direct notices to non-polling recipients"),
  } },
  "msg list": { description: "List public notices",
    example: ["--bucket", "<bucket>", "--all", "--json"], options: {
    ...bucket, entity: writer.entity, tag: filters.tag, "after-msg": string("Message cursor"),
    unread: boolean("Only unread notices for --entity"), all: boolean("Ignore recipient/tag targeting"),
  } },
  "entity register": { description: "Register or refresh an entity",
    example: ["--bucket", "<bucket>", "--entity", "executor", "--mode", "once", "--tag", "linux,gpu"], options: {
    ...writer, ...body, ...filters, mode: string("once|one-shot|continuous|owner|worker"),
    delivery: string("Message delivery watch|none"),
    ttl: string("Override this entity's TTL seconds"),
  } },
  "entity end": { description: "End self or a recorded dispatcher child",
    example: ["--bucket", "<bucket>", "--entity", "executor"], options: {
    ...writer, target: string("Child entity to end (default self)"),
  } },
  "entity list": { description: "Discover active entities",
    example: ["--bucket", "<bucket>", "--all", "--json"], options: {
    ...bucket, online: boolean("Only online entities"), all: boolean("Include ended and long-stale entities"),
  } },
  "tag set": { description: "Set standing instructions for a tag",
    example: ["--bucket", "<bucket>", "--entity", "owner", "--tag", "linux", "-m", "Use the project toolchain"], options: {
    ...writer, ...body, tag: filters.tag,
  } },
  "tag list": { description: "List documented and observed tags",
    example: ["--bucket", "<bucket>", "--json"], options: { ...bucket } },
};

export function parseCommand(name, args) {
  const options = Object.fromEntries(Object.entries({ ...COMMANDS[name].options, ...common })
    .map(([key, { description, ...option }]) => [key, option]));
  try {
    const separator = name === "run" ? args.indexOf("--") : -1;
    const parsed = parseArgs({ args: separator < 0 ? args : args.slice(0, separator), options, strict: true, allowPositionals: false });
    if (name === "run") parsed.command = separator < 0 ? [] : args.slice(separator + 1);
    const values = parsed.values;
    if ([values.message !== undefined, values["body-file"] !== undefined, values.stdin].filter(Boolean).length > 1) {
      throw new CliError("Use only one of -m/--message, --body-file or --stdin.");
    }
    return parsed;
  } catch (err) {
    if (err instanceof CliError || String(err.code).startsWith("ERR_PARSE_ARGS")) {
      throw new CliError(`${err.message.replace(/\s+/g, " ")} Run "wb.mjs ${name} --help".`);
    }
    throw err;
  }
}

export function printCommandHelp(name = "") {
  if (!name || !COMMANDS[name]) {
    console.log(`Usage: wb.mjs ${name ? `${name} <action>` : "<command>"} [options]`);
    for (const [command, definition] of Object.entries(COMMANDS)) {
      if (!name || command.startsWith(`${name} `)) console.log(`  ${command.padEnd(18)} ${definition.description}`);
    }
  } else {
    const definition = COMMANDS[name];
    console.log(`Usage: wb.mjs ${name} [options]${name === "run" ? " -- <command> [args...]" : ""}\n${definition.description}`);
    for (const [flag, option] of Object.entries({ ...definition.options, ...common })) {
      const spelling = `${option.short ? `-${option.short}, ` : ""}--${flag}${option.type === "string" ? " <value>" : ""}`;
      console.log(`  ${spelling.padEnd(32)} ${option.description}${option.type === "string" && option.default !== undefined ? ` (default: ${option.default})` : ""}`);
    }
    console.log(`\nExample: wb.mjs ${name} ${definition.example.map((arg) =>
      /[\s*]/.test(arg) ? JSON.stringify(arg) : arg).join(" ")}`);
  }
  console.log("\nExit codes: 0 ok; 1 usage/validation/not-found; 2 no work/not eligible; 3 conflict/race/permission; 4 paused; 124 timeout; 130 signal.");
  if (name === "run") console.log("run propagates the command exit code; spawn failures: 126/127; termination: 128 + signal number.");
}
