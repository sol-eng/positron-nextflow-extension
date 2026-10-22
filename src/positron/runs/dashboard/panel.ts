// Shows the task and run dashboards in Positron's Viewer, keeps them up to
// date while the run is active, and handles what the page asks for.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { PositronApi, PreviewPanel } from "@posit-dev/positron";

import { describeRun } from "../index";
import { registerCommand } from "../log";
import { isTerminal, type TaskState } from "../model";
import { resolveTask, withRun } from "../select";
import { isActive, type Run, type RunStore } from "../store";
import { runDuration } from "../tree";
import { dashboardHtml } from "./html";
import { isInside, readTail, readTaskDir, sectionOrder } from "./taskFiles";

type View =
  | { kind: "run"; dir: string }
  | { kind: "task"; dir: string; taskId: number };

const REFRESH_MS = 2000;
const STDERR_LINES = 8;
const DATA_EXPLORER_EXTENSIONS = [".csv", ".tsv", ".parquet", ".parq", ".xlsx"];

export class Dashboard implements vscode.Disposable {
  private panel: PreviewPanel | undefined;
  private view: View | undefined;
  private timer: NodeJS.Timeout | undefined;
  private refreshing = false;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly api: PositronApi,
    private readonly store: RunStore
  ) {
    this.subscription = store.onDidChange((run) => {
      if (this.view && (!run || run.files.dir === this.view.dir))
        this.refresh();
    });
  }

  showRun(run: Run) {
    this.show({ kind: "run", dir: run.files.dir });
  }

  showTask(run: Run, task: TaskState) {
    this.show({ kind: "task", dir: run.files.dir, taskId: task.taskId });
  }

  dispose() {
    this.subscription.dispose();
    clearInterval(this.timer);
    this.panel?.dispose();
  }

  private show(view: View) {
    this.view = view;
    const data = this.data();
    if (!data) return;
    if (!this.panel) {
      this.panel = this.api.window.createPreviewPanel(
        "nextflow.dashboard",
        data.title,
        true,
        {
          enableScripts: true,
          localResourceRoots: []
        }
      );
      this.panel.webview.html = dashboardHtml(
        data,
        this.panel.webview.cspSource
      );
      this.panel.webview.onDidReceiveMessage((message) => this.handle(message));
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.view = undefined;
        clearInterval(this.timer);
        this.timer = undefined;
      });
    } else {
      this.panel.title = data.title;
      this.panel.webview.postMessage({ type: "update", data });
      this.panel.reveal(true);
    }
    // logs grow without events, so re-read them while something is running
    clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh(), REFRESH_MS);
  }

  private refresh() {
    if (!this.panel || !this.view || this.refreshing) return;
    this.refreshing = true;
    try {
      const data = this.data();
      if (data) this.panel.webview.postMessage({ type: "update", data });
      if (!data?.live) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    } finally {
      this.refreshing = false;
    }
  }

  private current(): { run: Run; task?: TaskState } | undefined {
    if (!this.view) return undefined;
    const run = this.store.get(this.view.dir);
    if (!run) return undefined;
    if (this.view.kind === "run") return { run };
    return { run, task: run.progress.tasks[this.view.taskId] };
  }

  private data() {
    const found = this.current();
    if (!found) return undefined;
    const { run, task } = found;
    if (this.view?.kind === "task") {
      if (!task) return undefined;
      return taskData(run, task);
    }
    return runData(run);
  }

  private async handle(message: any) {
    const found = this.current();
    if (!found || typeof message?.type !== "string") return;
    const { run, task } = found;
    switch (message.type) {
      case "open":
        return this.open(run, task, String(message.path ?? ""));
      case "task": {
        const target = run.progress.tasks[Number(message.taskId)];
        if (target) this.showTask(run, target);
        return;
      }
      case "action":
        return this.action(run, task, String(message.action ?? ""));
    }
  }

  private async open(run: Run, task: TaskState | undefined, file: string) {
    const allowed =
      (task?.workdir && isInside(task.workdir, file)) ||
      isInside(run.files.dir, file);
    if (!allowed || !fs.existsSync(file)) return;
    const ext = path.extname(file).toLowerCase();
    if (ext === ".html" || ext === ".htm") {
      this.api.window.previewHtml(fs.realpathSync(file));
    } else if (DATA_EXPLORER_EXTENSIONS.includes(ext)) {
      await vscode.commands.executeCommand(
        "nextflow.positron.openInDataExplorer",
        vscode.Uri.file(fs.realpathSync(file))
      );
    } else {
      await vscode.window.showTextDocument(vscode.Uri.file(file), {
        preview: true
      });
    }
  }

  private async action(run: Run, task: TaskState | undefined, action: string) {
    const runNode = { kind: "run", run };
    const taskNode = task && { kind: "task", run, task };
    switch (action) {
      case "run":
        return this.showRun(run);
      case "debug":
        return (
          taskNode &&
          vscode.commands.executeCommand(
            "nextflow.positron.runs.debugTask",
            taskNode
          )
        );
      case "cancel":
        return (
          taskNode &&
          vscode.commands.executeCommand(
            "nextflow.positron.runs.cancelTask",
            taskNode
          )
        );
      case "copy":
        return task?.workdir && vscode.env.clipboard.writeText(task.workdir);
      case "terminal":
        if (task?.workdir) {
          vscode.window
            .createTerminal({ name: `Task: ${task.name}`, cwd: task.workdir })
            .show();
        }
        return;
      case "output":
        return vscode.commands.executeCommand(
          "nextflow.positron.runs.showOutput",
          runNode
        );
      case "log":
        return vscode.commands.executeCommand(
          "nextflow.positron.runs.openLog",
          runNode
        );
      case "report":
      case "timeline":
      case "dag":
      case "trace": {
        const id = {
          report: "openReport",
          timeline: "openTimeline",
          dag: "openDag",
          trace: "openTrace"
        }[action];
        return vscode.commands.executeCommand(
          `nextflow.positron.runs.${id}`,
          runNode
        );
      }
    }
  }
}

function taskData(run: Run, task: TaskState) {
  const dir = task.workdir ? readTaskDir(task.workdir) : readTaskDir("");
  const failed = task.status === "FAILED" || task.status === "ABORTED";
  return {
    kind: "task" as const,
    id: `${run.files.dir}#task${task.taskId}`,
    title: `Task: ${task.name}`,
    runName: run.record.runName,
    runDir: run.files.dir,
    task,
    dir,
    sections: sectionOrder(failed),
    canDebug: dir.exists,
    canCancel: !!task.nativeId && !isTerminal(task.status),
    now: Date.now(),
    live: isActive(run) && !isTerminal(task.status)
  };
}

function runData(run: Run) {
  const { tasks, ...summary } = describeRun(run);
  const failed = tasks
    .filter((t) => t.status === "FAILED")
    .map((t) => ({
      taskId: t.taskId,
      name: t.name,
      exit: t.exit,
      stderr: t.workdir ? stderrHead(t.workdir) : undefined
    }));
  const running = tasks
    .filter((t) => t.status === "RUNNING")
    .map((t) => ({ taskId: t.taskId, name: t.name }));
  const reports = (["report", "timeline", "dag", "trace"] as const).filter(
    (k) => fs.existsSync(run.files[k])
  );
  return {
    kind: "run" as const,
    id: run.files.dir,
    title: `Run: ${run.record.runName}`,
    run: summary,
    failed,
    running,
    reports,
    duration: runDuration(run),
    cluster: run.record.config.workbench?.cluster,
    live: isActive(run)
  };
}

function stderrHead(workdir: string): string | undefined {
  try {
    const { text } = readTail(path.join(workdir, ".command.err"), 16 * 1024);
    return (
      text.trimEnd().split("\n").slice(-STDERR_LINES).join("\n") || undefined
    );
  } catch {
    return undefined;
  }
}

export function activateDashboard(
  context: vscode.ExtensionContext,
  api: PositronApi,
  store: RunStore
) {
  const dashboard = new Dashboard(api, store);
  context.subscriptions.push(
    dashboard,
    registerCommand("nextflow.positron.runs.showTask", (node?: unknown) => {
      const found = resolveTask(store, node);
      if (!found) {
        vscode.window.showWarningMessage(
          "Could not find that task; refresh the Pipeline Runs view and try again."
        );
        return;
      }
      dashboard.showTask(found.run, found.task);
    }),
    registerCommand(
      "nextflow.positron.runs.showRunDashboard",
      (node?: unknown) => withRun(store, node, (run) => dashboard.showRun(run))
    )
  );
}
