// Keeps track of the pipeline runs started from this workspace, follows the
// active ones, and works out their status.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import { applyEvent, parseEventChunk } from "./events";
import { readTail } from "./dashboard/taskFiles";
import { driverJobState } from "./driverJob";
import { runEnvironment } from "./env";
import {
  orphanedJobIds,
  runFiles,
  type JobState,
  type RunFiles
} from "./launchArgs";
import { abortUnfinished, emptyProgress, type RunProgress } from "./model";
import { isRunAlive, readRecord, writeRecord, type RunRecord } from "./runner";
import { applyTraceFile, parseHistory } from "./trace";

export type RunStatus =
  | "queued"
  | "starting"
  | "running"
  | "succeeded"
  | "failed"
  | "stopped"
  | "lost";

export type Run = {
  files: RunFiles;
  record: RunRecord;
  progress: RunProgress;
  status: RunStatus;
  /** bytes of the events file already applied */
  offset: number;
  rest: string;
  /** the driver job's last known state, for job runs */
  jobState?: JobState;
  jobCheckedAt?: number;
  /** task jobs left running when a job run ended without finishing */
  orphans?: string[];
};

const INDEX_KEY = "nextflow.positron.runs";
const POLL_MS = 1000;
/** how often a driver job's state is asked for, to limit Workbench API load */
const JOB_POLL_MS = 10000;
/** how long a just-submitted job may be missing from the job list */
const JOB_VISIBLE_MS = 120000;

export function isActive(run: Run): boolean {
  return (
    run.status === "queued" ||
    run.status === "starting" ||
    run.status === "running"
  );
}

export class RunStore implements vscode.Disposable {
  private readonly runs = new Map<string, Run>();
  private readonly changed = new vscode.EventEmitter<Run | undefined>();
  private readonly finished = new vscode.EventEmitter<Run>();
  private timer: NodeJS.Timeout | undefined;
  private polling = false;

  /** fires with the run that changed, or undefined for the whole list */
  readonly onDidChange = this.changed.event;
  /** fires once when an active run ends */
  readonly onDidFinish = this.finished.event;

  /** resolves once the runs on disk have been loaded */
  ready: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {}

  load(): Promise<void> {
    this.ready = this.loadRuns();
    return this.ready;
  }

  private async loadRuns() {
    const dirs = new Set(
      this.context.workspaceState.get<string[]>(INDEX_KEY, [])
    );
    // runs live under their launch directory, which may be any subfolder
    const found = await vscode.workspace.findFiles(
      "**/.nextflow/positron/*/run.json",
      "**/{work,node_modules}/**",
      1000
    );
    for (const uri of found) dirs.add(path.dirname(uri.fsPath));
    for (const dir of dirs) {
      const files = filesForDir(dir);
      const record = readRecord(files);
      if (record) this.runs.set(dir, newRun(files, record));
    }
    await Promise.all([...this.runs.values()].map((run) => this.refresh(run)));
    this.saveIndex();
    this.changed.fire(undefined);
    this.schedule();
  }

  all(): Run[] {
    return [...this.runs.values()].sort((a, b) =>
      b.record.startedAt.localeCompare(a.record.startedAt)
    );
  }

  get(dir: string): Run | undefined {
    return this.runs.get(dir);
  }

  add(files: RunFiles, record: RunRecord): Run {
    const run = newRun(files, record);
    run.status = "starting";
    this.runs.set(files.dir, run);
    this.saveIndex();
    this.changed.fire(undefined);
    this.schedule();
    return run;
  }

  remove(run: Run) {
    this.runs.delete(run.files.dir);
    this.saveIndex();
    this.changed.fire(undefined);
  }

  save(run: Run) {
    writeRecord(run.files, run.record);
    this.changed.fire(run);
  }

  dispose() {
    clearTimeout(this.timer);
    this.changed.dispose();
    this.finished.dispose();
  }

  private saveIndex() {
    this.context.workspaceState.update(INDEX_KEY, [...this.runs.keys()]);
  }

  private schedule() {
    clearTimeout(this.timer);
    if (![...this.runs.values()].some(isActive)) return;
    this.timer = setTimeout(() => this.poll(), POLL_MS);
  }

  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const run of this.runs.values()) {
        if (!isActive(run)) continue;
        const before = JSON.stringify([
          run.status,
          run.offset,
          run.progress.tasks
        ]);
        await this.refresh(run);
        if (
          JSON.stringify([run.status, run.offset, run.progress.tasks]) !==
          before
        ) {
          this.changed.fire(run);
        }
      }
    } finally {
      this.polling = false;
      this.schedule();
    }
  }

  /** Is the run's driver job still queued or running? Asked every JOB_POLL_MS. */
  private async jobAlive(run: Run): Promise<boolean> {
    if (!run.record.jobId || run.record.finishedAt) return false;
    const now = Date.now();
    if (!run.jobCheckedAt || now - run.jobCheckedAt >= JOB_POLL_MS) {
      run.jobCheckedAt = now;
      const state = await driverJobState(
        await runEnvironment(),
        run.record.jobId
      );
      // an unreachable launcher keeps the last known state
      if (state) run.jobState = state;
    }
    if (run.jobState === "missing") {
      const age = now - Date.parse(run.record.startedAt);
      return age < JOB_VISIBLE_MS;
    }
    // unknown until the launcher answers, so not ended
    return run.jobState !== "ended";
  }

  /** Read new events (or the trace file) and recompute the status. */
  private async refresh(run: Run) {
    const wasActive = isActive(run);
    if (run.record.withEvents) {
      await readEvents(run);
    } else {
      const trace = await fs.promises
        .readFile(run.files.trace, "utf8")
        .catch(() => "");
      applyTraceFile(run.progress, trace);
    }
    const alive =
      !run.progress.finished &&
      (run.record.mode === "job"
        ? await this.jobAlive(run)
        : await isRunAlive(run.record));
    if (!alive && !run.record.finishedAt) {
      run.record.finishedAt = new Date().toISOString();
      run.record.outcome = await historyOutcome(run);
      if (
        run.record.mode === "job" &&
        !run.record.outcome &&
        !hasStarted(run)
      ) {
        run.record.driverError = driverError(run);
      }
      writeRecord(run.files, run.record);
    }
    if (run.record.driverError) {
      run.progress.errorMessage ??= run.record.driverError;
    }
    run.status = statusOf(run, alive);
    if (
      wasActive &&
      !isActive(run) &&
      run.record.mode === "job" &&
      !run.progress.finished
    ) {
      run.orphans = orphanedJobIds(Object.values(run.progress.tasks));
    }
    if (!isActive(run)) abortUnfinished(run.progress);
    if (wasActive && !isActive(run)) this.finished.fire(run);
  }
}

function filesForDir(dir: string): RunFiles {
  // runFiles() derives the directory from the launch dir and run name
  const runName = path.basename(dir);
  const cwd = path.dirname(path.dirname(path.dirname(dir)));
  return runFiles(cwd, runName);
}

function newRun(files: RunFiles, record: RunRecord): Run {
  return {
    files,
    record,
    progress: emptyProgress(),
    status: "lost",
    offset: 0,
    rest: ""
  };
}

async function readEvents(run: Run) {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(run.files.events, "r");
  } catch {
    return;
  }
  try {
    const { size } = await handle.stat();
    if (size <= run.offset) return;
    const buffer = Buffer.alloc(size - run.offset);
    await handle.read(buffer, 0, buffer.length, run.offset);
    run.offset = size;
    const { events, rest } = parseEventChunk(run.rest, buffer.toString("utf8"));
    run.rest = rest;
    events.forEach((e) => applyEvent(run.progress, e));
  } finally {
    await handle.close();
  }
}

async function historyOutcome(run: Run): Promise<string | undefined> {
  const file = path.join(run.record.config.cwd, ".nextflow", "history");
  const text = await fs.promises.readFile(file, "utf8").catch(() => "");
  const entry = parseHistory(text).find(
    (e) => e.runName === run.record.runName
  );
  return entry && entry.status !== "-" ? entry.status : undefined;
}

/** Has Nextflow reported anything about the run? */
function hasStarted(run: Run): boolean {
  return !!run.progress.workflow || Object.keys(run.progress.tasks).length > 0;
}

/** A driver job that ended before Nextflow started: its output says why. */
function driverError(run: Run): string {
  let output = "";
  try {
    output = readTail(run.files.output, 8 * 1024)
      .text.trimEnd()
      .split("\n")
      .slice(-15)
      .join("\n");
  } catch {
    // no output at all
  }
  return (
    "The Nextflow driver job ended before the run started." +
    (output
      ? `\n\n${output}`
      : " It wrote no output; check the job in the Workbench Jobs UI.")
  );
}

function statusOf(run: Run, alive: boolean): RunStatus {
  const { progress, record } = run;
  const failure = record.stopRequested ? "stopped" : "failed";
  if (progress.finished) return progress.success ? "succeeded" : failure;
  if (alive) {
    if (progress.workflow || Object.keys(progress.tasks).length)
      return "running";
    const queued = run.jobState === "queued" || run.jobState === "missing";
    return record.mode === "job" && queued ? "queued" : "starting";
  }
  if (record.outcome === "OK") return "succeeded";
  if (record.outcome === "ERR" || record.driverError) return failure;
  return record.stopRequested ? "stopped" : "lost";
}
