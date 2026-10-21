// The state of a pipeline run, built from the events that the nf-workbench
// plugin writes (see events.ts) or, without the plugin, from the trace file
// (see trace.ts). Kept free of `vscode` so it can be unit tested.

export type TaskStatus =
  | "NEW"
  | "SUBMITTED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "ABORTED"
  | "CACHED";

export type TaskState = {
  taskId: number;
  /** e.g. `SQUARE (2)` */
  name: string;
  /** e.g. `SQUARE` */
  process: string;
  hash?: string;
  status: TaskStatus;
  exit?: number;
  nativeId?: string;
  workdir?: string;
  attempt: number;
  submit?: number;
  start?: number;
  complete?: number;
};

export type WorkflowInfo = {
  runName?: string;
  sessionId?: string;
  launchDir?: string;
  workDir?: string;
  success?: boolean;
  exitStatus?: number | null;
  errorMessage?: string | null;
  /** Nextflow's explanation of the failure */
  errorReport?: string | null;
};

export type RunProgress = {
  tasks: Record<number, TaskState>;
  workflow?: WorkflowInfo;
  /** a `completed` event was seen */
  finished: boolean;
  success?: boolean;
  errorMessage?: string;
};

export type ProcessSummary = {
  name: string;
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  cached: number;
  failed: number;
  /** stopped by Nextflow, e.g. after another task failed */
  aborted: number;
  /** failed attempts that were retried */
  retried: number;
};

/** Nextflow reports a task that has not exited yet with this exit code. */
export const NO_EXIT = 2147483647;

const RANK: Record<TaskStatus, number> = {
  NEW: 0,
  SUBMITTED: 1,
  RUNNING: 2,
  COMPLETED: 3,
  FAILED: 3,
  ABORTED: 3,
  CACHED: 3
};

export function emptyProgress(): RunProgress {
  return { tasks: {}, finished: false };
}

export function isTerminal(status: TaskStatus): boolean {
  return RANK[status] === 3;
}

/** `SQUARE (2)` → `SQUARE`, `ALIGN:STAR (s1)` → `ALIGN:STAR` */
export function processOf(name: string): string {
  return name.replace(/\s*\(.*\)\s*$/, "");
}

/**
 * Merge a task update into the progress. Status only moves forward, so a late
 * `task_started` cannot undo a `task_completed`.
 */
export function updateTask(
  progress: RunProgress,
  update: Partial<TaskState> & { taskId: number }
) {
  const current = progress.tasks[update.taskId];
  const defaults: Omit<TaskState, "taskId"> = {
    name: "",
    process: "",
    status: "NEW",
    attempt: 1
  };
  const next = {
    ...defaults,
    ...current,
    ...stripUndefined(update)
  } as TaskState;
  if (current && RANK[update.status ?? current.status] < RANK[current.status]) {
    next.status = current.status;
  }
  if (!next.process) next.process = processOf(next.name);
  progress.tasks[update.taskId] = next;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined)
  ) as Partial<T>;
}

/** Per-process counts, in the order processes were first seen. */
export function summarize(progress: RunProgress): ProcessSummary[] {
  const byProcess = new Map<string, TaskState[]>();
  const tasks = Object.values(progress.tasks).sort(
    (a, b) => a.taskId - b.taskId
  );
  for (const task of tasks) {
    const list = byProcess.get(task.process) ?? [];
    list.push(task);
    byProcess.set(task.process, list);
  }
  return [...byProcess].map(([name, list]) => {
    // only the latest attempt of a task counts towards its outcome
    const latest = new Map<string, TaskState>();
    for (const task of list) {
      const seen = latest.get(task.name);
      if (!seen || task.attempt >= seen.attempt) latest.set(task.name, task);
    }
    const summary: ProcessSummary = {
      name,
      total: latest.size,
      pending: 0,
      running: 0,
      succeeded: 0,
      cached: 0,
      failed: 0,
      aborted: 0,
      retried: list.length - latest.size
    };
    for (const task of latest.values()) {
      if (task.status === "COMPLETED") summary.succeeded++;
      else if (task.status === "CACHED") summary.cached++;
      else if (task.status === "FAILED") summary.failed++;
      else if (task.status === "ABORTED") summary.aborted++;
      else if (task.status === "RUNNING") summary.running++;
      else summary.pending++;
    }
    return summary;
  });
}

export function totals(progress: RunProgress) {
  const all = summarize(progress);
  const sum = (key: keyof Omit<ProcessSummary, "name">) =>
    all.reduce((n, p) => n + p[key], 0);
  const done = sum("succeeded") + sum("cached");
  return {
    total: sum("total"),
    done,
    failed: sum("failed"),
    running: sum("running")
  };
}

/**
 * Once a run has ended, tasks it never reported as finished (e.g. after the
 * run was killed) did not complete either.
 */
export function abortUnfinished(progress: RunProgress) {
  for (const task of Object.values(progress.tasks)) {
    if (!isTerminal(task.status)) task.status = "ABORTED";
  }
}
