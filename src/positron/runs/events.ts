// Parses the NDJSON events written by the nf-workbench plugin's
// `workbench.eventsFile` and folds them into a RunProgress.

import {
  NO_EXIT,
  updateTask,
  type RunProgress,
  type TaskStatus,
  type WorkflowInfo
} from "./model";

export type RunEvent = {
  event: string;
  utcTime?: string;
  trace?: Record<string, unknown>;
  workflow?: WorkflowInfo;
};

/**
 * Split appended file content into complete events. A trailing partial line
 * is returned as `rest`, to be prepended to the next chunk.
 */
export function parseEventChunk(
  rest: string,
  chunk: string
): { events: RunEvent[]; rest: string } {
  const text = rest + chunk;
  const lines = text.split("\n");
  const tail = lines.pop() ?? "";
  const events: RunEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // a corrupt line is skipped rather than stalling the run's status
    }
  }
  return { events, rest: tail };
}

const STATUS_FOR_EVENT: Record<string, TaskStatus> = {
  task_submitted: "SUBMITTED",
  task_started: "RUNNING",
  task_cached: "CACHED"
};

export function applyEvent(progress: RunProgress, event: RunEvent) {
  if (event.workflow) {
    progress.workflow = { ...progress.workflow, ...event.workflow };
  }
  if (event.trace) applyTrace(progress, event.event, event.trace);
  const error =
    event.workflow?.errorReport || event.workflow?.errorMessage || undefined;
  if (event.event === "error" || event.event === "completed") {
    progress.errorMessage = error ?? progress.errorMessage;
  }
  if (event.event === "completed") {
    progress.finished = true;
    progress.success = event.workflow?.success ?? false;
  }
}

function applyTrace(
  progress: RunProgress,
  name: string,
  trace: Record<string, unknown>
) {
  const taskId = Number(trace.task_id);
  if (!Number.isFinite(taskId)) return;
  const exit = numberOr(trace.exit);
  const status =
    STATUS_FOR_EVENT[name] ??
    (name === "task_completed"
      ? completedStatus(trace.status, exit)
      : undefined);
  updateTask(progress, {
    taskId,
    name: stringOr(trace.name),
    process: stringOr(trace.process),
    hash: stringOr(trace.hash),
    status,
    exit: exit === NO_EXIT ? undefined : exit,
    nativeId: trace.native_id == null ? undefined : String(trace.native_id),
    workdir: stringOr(trace.workdir),
    attempt: numberOr(trace.attempt),
    submit: positive(trace.submit),
    start: positive(trace.start),
    complete: positive(trace.complete),
    cpus: positive(trace.cpus),
    memory: positive(trace.memory)
  });
}

function completedStatus(status: unknown, exit?: number): TaskStatus {
  if (status === "COMPLETED" || status === "FAILED" || status === "ABORTED")
    return status;
  return exit === 0 ? "COMPLETED" : "FAILED";
}

function stringOr(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberOr(value: unknown): number | undefined {
  const n = Number(value);
  return value == null || value === "" || !Number.isFinite(n) ? undefined : n;
}

function positive(value: unknown): number | undefined {
  const n = numberOr(value);
  return n && n > 0 ? n : undefined;
}
