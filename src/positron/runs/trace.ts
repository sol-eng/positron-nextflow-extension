// Fallbacks for runs without the events plugin: the trace file, which has a
// row for each completed or cached task, and `.nextflow/history`, which has
// the outcome of each run.

import { updateTask, type RunProgress, type TaskStatus } from "./model";

const TRACE_STATUSES = new Set(["COMPLETED", "FAILED", "ABORTED", "CACHED"]);

/** Fold the rows of a tab-separated trace file into `progress`. */
export function applyTraceFile(progress: RunProgress, text: string) {
  const [header, ...rows] = text.split(/\r?\n/);
  if (!header) return;
  const columns = header.split("\t");
  for (const row of rows) {
    if (!row.trim()) continue;
    const cells = row.split("\t");
    const field = (name: string) => {
      const value = cells[columns.indexOf(name)];
      return value === undefined || value === "-" ? undefined : value;
    };
    const taskId = Number(field("task_id"));
    if (!Number.isFinite(taskId)) continue;
    const status = field("status");
    const exit = Number(field("exit"));
    updateTask(progress, {
      taskId,
      name: field("name") ?? `task ${taskId}`,
      hash: field("hash"),
      nativeId: field("native_id"),
      workdir: field("workdir"),
      status: TRACE_STATUSES.has(status ?? "")
        ? (status as TaskStatus)
        : undefined,
      exit: Number.isFinite(exit) ? exit : undefined
    });
  }
}

export type HistoryEntry = {
  timestamp: string;
  duration: string;
  runName: string;
  /** `OK`, `ERR`, or `-` while running */
  status: string;
  revisionId: string;
  sessionId: string;
  command: string;
};

/** Parse `.nextflow/history`, one tab-separated line per run. */
export function parseHistory(text: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split("\t");
    if (cells.length < 7) continue;
    const [timestamp, duration, runName, status, revisionId, sessionId] = cells;
    entries.push({
      timestamp,
      duration,
      runName,
      status,
      revisionId,
      sessionId,
      command: cells.slice(6).join("\t")
    });
  }
  return entries;
}
