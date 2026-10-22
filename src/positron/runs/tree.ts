import * as path from "path";
import * as vscode from "vscode";

import {
  summarize,
  totals,
  type ProcessSummary,
  type TaskState
} from "./model";
import { isActive, type Run, type RunStatus, type RunStore } from "./store";

export type RunNode =
  | { kind: "run"; run: Run }
  | { kind: "process"; run: Run; summary: ProcessSummary }
  | { kind: "task"; run: Run; task: TaskState }
  | { kind: "note"; run: Run; text: string };

const RUN_ICONS: Record<RunStatus, [string, string?]> = {
  queued: ["clock", "testing.iconQueued"],
  starting: ["loading~spin"],
  running: ["sync~spin", "charts.blue"],
  succeeded: ["pass", "testing.iconPassed"],
  failed: ["error", "testing.iconFailed"],
  stopped: ["circle-slash", "testing.iconSkipped"],
  lost: ["question", "testing.iconQueued"]
};

const TASK_ICONS: Record<TaskState["status"], [string, string?]> = {
  NEW: ["circle-outline"],
  SUBMITTED: ["clock", "testing.iconQueued"],
  RUNNING: ["sync~spin", "charts.blue"],
  COMPLETED: ["pass", "testing.iconPassed"],
  CACHED: ["history", "testing.iconPassed"],
  FAILED: ["error", "testing.iconFailed"],
  ABORTED: ["circle-slash", "testing.iconSkipped"]
};

function icon([id, color]: [string, string?]) {
  return new vscode.ThemeIcon(
    id,
    color ? new vscode.ThemeColor(color) : undefined
  );
}

/** Where a run's driver runs, e.g. "Workbench job 123 on Kubernetes". */
export function driverLabel(run: Run): string {
  const { mode, jobId, driver } = run.record;
  if (mode !== "job") return "in the session that started it";
  return `Workbench job ${jobId ?? "?"}${driver?.cluster ? ` on ${driver.cluster}` : ""}`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function runDuration(run: Run): string {
  const start = Date.parse(run.record.startedAt);
  const end = run.record.finishedAt
    ? Date.parse(run.record.finishedAt)
    : Date.now();
  return formatDuration(end - start);
}

const TASK_ORDER: Record<TaskState["status"], number> = {
  FAILED: 0,
  ABORTED: 1,
  RUNNING: 2,
  SUBMITTED: 3,
  NEW: 4,
  COMPLETED: 5,
  CACHED: 6
};

export class RunsTreeProvider implements vscode.TreeDataProvider<RunNode> {
  private readonly changed = new vscode.EventEmitter<RunNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly store: RunStore) {
    // the run node identity changes on every refresh, so redraw everything
    store.onDidChange(() => this.changed.fire(undefined));
  }

  getChildren(node?: RunNode): RunNode[] {
    if (!node) return this.store.all().map((run) => ({ kind: "run", run }));
    if (node.kind === "run") {
      const children: RunNode[] = summarize(node.run.progress).map(
        (summary) => ({
          kind: "process",
          run: node.run,
          summary
        })
      );
      if (!node.run.record.withEvents) {
        children.unshift({
          kind: "note",
          run: node.run,
          text: "Only completed tasks are shown. Install the nf-workbench plugin for live status."
        });
      }
      const error = node.run.progress.errorMessage;
      if (error && node.run.status === "failed") {
        children.unshift({ kind: "note", run: node.run, text: error });
      }
      return children;
    }
    if (node.kind === "process") {
      return Object.values(node.run.progress.tasks)
        .filter((task) => task.process === node.summary.name)
        .sort(
          (a, b) =>
            TASK_ORDER[a.status] - TASK_ORDER[b.status] || a.taskId - b.taskId
        )
        .map((task) => ({ kind: "task", run: node.run, task }));
    }
    return [];
  }

  getTreeItem(node: RunNode): vscode.TreeItem {
    switch (node.kind) {
      case "run":
        return runItem(node.run);
      case "process":
        return processItem(node.run, node.summary);
      case "task":
        return taskItem(node.run, node.task);
      case "note": {
        const [first] = node.text.trim().split("\n");
        const item = new vscode.TreeItem(first);
        item.iconPath = new vscode.ThemeIcon("info");
        item.tooltip = new vscode.MarkdownString().appendCodeblock(node.text);
        return item;
      }
    }
  }

  getParent(node: RunNode): RunNode | undefined {
    if (node.kind === "run") return undefined;
    return { kind: "run", run: node.run };
  }
}

function runItem(run: Run): vscode.TreeItem {
  const { total, done, failed } = totals(run.progress);
  const item = new vscode.TreeItem(
    run.record.runName,
    isActive(run)
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed
  );
  item.id = run.files.dir;
  const parts = [
    run.status,
    total ? `${done}/${total}` : undefined,
    failed ? `${failed} failed` : undefined,
    runDuration(run)
  ];
  item.description = parts.filter(Boolean).join(" · ");
  item.iconPath = icon(RUN_ICONS[run.status]);
  item.contextValue = `run.${run.status}`;
  const { config } = run.record;
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**${run.record.runName}** — ${run.status}\n\n`);
  tooltip.appendMarkdown(
    `Script: \`${path.relative(config.cwd, config.script) || config.script}\`\n\n`
  );
  tooltip.appendMarkdown(`Launch dir: \`${config.cwd}\`\n\n`);
  if (config.profiles.length)
    tooltip.appendMarkdown(`Profiles: \`${config.profiles.join(",")}\`\n\n`);
  if (config.workbench?.cluster)
    tooltip.appendMarkdown(
      `Workbench cluster: \`${config.workbench.cluster}\`\n\n`
    );
  tooltip.appendMarkdown(`Driver: ${driverLabel(run)}\n\n`);
  if (run.progress.workflow?.sessionId)
    tooltip.appendMarkdown(`Session: \`${run.progress.workflow.sessionId}\``);
  item.tooltip = tooltip;
  return item;
}

function processItem(run: Run, summary: ProcessSummary): vscode.TreeItem {
  const item = new vscode.TreeItem(
    summary.name,
    vscode.TreeItemCollapsibleState.Collapsed
  );
  item.id = `${run.files.dir}#${summary.name}`;
  const done = summary.succeeded + summary.cached;
  const parts = [
    `${done}/${summary.total}`,
    summary.running ? `${summary.running} running` : undefined,
    summary.failed ? `${summary.failed} failed` : undefined,
    summary.aborted ? `${summary.aborted} aborted` : undefined,
    summary.retried ? `${summary.retried} retried` : undefined
  ];
  item.description = parts.filter(Boolean).join(" · ");
  item.iconPath = summary.failed
    ? icon(TASK_ICONS.FAILED)
    : summary.running
      ? icon(TASK_ICONS.RUNNING)
      : done === summary.total
        ? icon(TASK_ICONS.COMPLETED)
        : icon(TASK_ICONS.SUBMITTED);
  item.contextValue = "process";
  return item;
}

function taskItem(run: Run, task: TaskState): vscode.TreeItem {
  const label = task.name.startsWith(task.process)
    ? task.name
        .slice(task.process.length)
        .trim()
        .replace(/^\((.*)\)$/, "$1") || task.name
    : task.name;
  const item = new vscode.TreeItem(label);
  item.id = `${run.files.dir}#task${task.taskId}`;
  const elapsed =
    task.start && (task.complete || isActive(run))
      ? formatDuration((task.complete ?? Date.now()) - task.start)
      : undefined;
  const parts = [
    task.status.toLowerCase(),
    task.exit !== undefined && task.exit !== 0
      ? `exit ${task.exit}`
      : undefined,
    task.attempt > 1 ? `attempt ${task.attempt}` : undefined,
    elapsed
  ];
  item.description = parts.filter(Boolean).join(" · ");
  item.iconPath = icon(TASK_ICONS[task.status]);
  item.contextValue = `task.${task.status.toLowerCase()}${task.workdir ? ".workdir" : ""}`;
  item.tooltip = [
    task.name,
    task.hash && `Hash: ${task.hash}`,
    task.nativeId && `Job: ${task.nativeId}`,
    task.workdir && `Work dir: ${task.workdir}`
  ]
    .filter(Boolean)
    .join("\n");
  if (task.workdir) {
    item.command = {
      command: "nextflow.positron.runs.showTask",
      title: "Open Task Dashboard",
      arguments: [{ kind: "task", run, task }]
    };
  }
  return item;
}
