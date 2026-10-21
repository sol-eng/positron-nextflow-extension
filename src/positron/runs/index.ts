// Launching, following and managing pipeline runs from the "Pipeline Runs"
// view.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import {
  execFile,
  installNextflow,
  nextflowConfig,
  resetRunEnvironment,
  runEnvironment,
  runSetting,
  type RunEnvironment
} from "./env";
import { pickLaunch, type LaunchPlan } from "./launch";
import {
  makeRunName,
  mergePlugins,
  runFiles,
  type LaunchConfig
} from "./launchArgs";
import { isTerminal, summarize, totals, type TaskState } from "./model";
import { trackOutputTerminals, showOutput } from "./output";
import { processCommand, signalRun, startRun, type RunRecord } from "./runner";
import { isActive, RunStore, type Run } from "./store";
import { parseHistory } from "./trace";
import { RunsTreeProvider, runDuration, type RunNode } from "./tree";

export type { Run, RunStore } from "./store";

const SUSPEND_WARNING_KEY = "nextflow.positron.warnedAboutSuspend";

export function activateRuns(context: vscode.ExtensionContext): RunStore {
  const store = new RunStore(context);
  const tree = new RunsTreeProvider(store);
  const view = vscode.window.createTreeView("nextflow.runs", {
    treeDataProvider: tree,
    showCollapseAll: true
  });
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50
  );
  statusBar.command = "nextflow.runs.focus";
  const updateStatusBar = () => {
    const active = store.all().filter(isActive);
    if (!active.length) {
      statusBar.hide();
      return;
    }
    const [run] = active;
    const { done, total, failed } = totals(run.progress);
    statusBar.text = `$(sync~spin) ${run.record.runName} ${done}/${total}${failed ? ` $(error) ${failed}` : ""}${active.length > 1 ? ` (+${active.length - 1})` : ""}`;
    statusBar.tooltip = "Nextflow pipeline runs";
    statusBar.show();
  };
  store.onDidChange(updateStatusBar);
  store.onDidFinish((run) => notifyFinished(run));

  const commands: Record<string, (...args: any[]) => unknown> = {
    "nextflow.positron.runs.run": (uri?: vscode.Uri) =>
      runPipeline(context, store, uri),
    "nextflow.positron.runs.runAgain": (node?: RunNode) =>
      withRun(store, node, (run) => relaunch(context, store, run, false)),
    "nextflow.positron.runs.resume": (node?: RunNode) =>
      withRun(store, node, (run) => relaunch(context, store, run, true)),
    "nextflow.positron.runs.stop": (node?: RunNode) =>
      withRun(store, node, (run) => stopRun(store, run), isActive),
    "nextflow.positron.runs.kill": (node?: RunNode) =>
      withRun(store, node, (run) => killRun(store, run), isActive),
    "nextflow.positron.runs.clean": (node?: RunNode) =>
      withRun(store, node, (run) => cleanRun(run)),
    "nextflow.positron.runs.showOutput": (node?: RunNode) =>
      withRun(store, node, (run) => showOutput(run)),
    "nextflow.positron.runs.openLog": (node?: RunNode) =>
      withRun(store, node, (run) => openFile(run.files.log)),
    "nextflow.positron.runs.remove": (node?: RunNode) =>
      withRun(store, node, (run) => removeRun(store, run)),
    "nextflow.positron.runs.cancelTask": (node: RunNode) =>
      node?.kind === "task" && cancelTask(node.run, node.task),
    "nextflow.positron.runs.showTaskFiles": (node: RunNode) =>
      node?.kind === "task" && showTaskFiles(node.task),
    "nextflow.positron.runs.copyWorkDir": (node: RunNode) =>
      node?.kind === "task" &&
      node.task.workdir &&
      vscode.env.clipboard.writeText(node.task.workdir),
    "nextflow.positron.runs.refresh": () => store.load(),
    "nextflow.positron.runs.diagnostics": () => showDiagnostics(),
    "nextflow.positron.runs.installNextflow": () => installNextflow(),
    // non-interactive entry points, for tests and the Assistant tools
    "nextflow.positron.runs.launchConfig": (config: LaunchInput) =>
      launchConfig(context, store, config),
    "nextflow.positron.runs.list": async () => {
      await store.ready;
      return store.all().map(describeRun);
    }
  };

  context.subscriptions.push(
    store,
    view,
    statusBar,
    trackOutputTerminals(),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("nextflow.run") ||
        e.affectsConfiguration("nextflow.java.home")
      ) {
        resetRunEnvironment();
      }
    }),
    ...Object.entries(commands).map(([id, fn]) =>
      vscode.commands.registerCommand(id, fn)
    )
  );
  store.load();
  return store;
}

/** Resolve the run a command applies to: the node, or a pick from the list. */
async function withRun(
  store: RunStore,
  node: RunNode | undefined,
  action: (run: Run) => unknown,
  filter: (run: Run) => boolean = () => true
) {
  let run = node && "run" in node ? store.get(node.run.files.dir) : undefined;
  if (!run) {
    const runs = store.all().filter(filter);
    if (!runs.length) {
      vscode.window.showInformationMessage(
        "There are no matching pipeline runs."
      );
      return;
    }
    const picked =
      runs.length === 1
        ? { run: runs[0] }
        : await vscode.window.showQuickPick(
            runs.map((r) => ({
              label: r.record.runName,
              description: `${r.status} · ${runDuration(r)}`,
              run: r
            })),
            { title: "Select a pipeline run" }
          );
    run = picked?.run;
  }
  if (run) return action(run);
}

async function readyEnvironment(): Promise<RunEnvironment | undefined> {
  const environment = await runEnvironment();
  if (!environment.nextflow) {
    const install = "Install Nextflow";
    const choice = await vscode.window.showErrorMessage(
      "Nextflow was not found. Install it into ~/.local/bin, or set `nextflow.run.executable`.",
      install,
      "Show Diagnostics"
    );
    if (choice === install) installNextflow();
    else if (choice) showDiagnostics();
    return undefined;
  }
  if (environment.problems.length) {
    const choice = await vscode.window.showErrorMessage(
      environment.problems.join(" "),
      "Show Diagnostics"
    );
    if (choice) showDiagnostics();
    return undefined;
  }
  return environment;
}

async function runPipeline(
  context: vscode.ExtensionContext,
  store: RunStore,
  uri?: vscode.Uri
) {
  const environment = await readyEnvironment();
  if (!environment) return;
  const plan = await pickLaunch(context, environment, uri);
  if (plan) await launch(context, store, environment, plan);
}

export type LaunchInput = Partial<LaunchConfig> & { script: string };

/** Start a run without prompting. Resolves to the run's description. */
export async function launchConfig(
  context: vscode.ExtensionContext,
  store: RunStore,
  input: LaunchInput
) {
  const environment = await readyEnvironment();
  if (!environment) return undefined;
  const config: LaunchConfig = {
    cwd: path.dirname(input.script),
    profiles: [],
    params: [],
    extraArgs: [],
    ...input
  };
  const resolved = await nextflowConfig(
    environment,
    config.cwd,
    config.profiles.length ? ["-profile", config.profiles.join(",")] : []
  );
  const declaredPlugins: string[] = (resolved?.plugins ?? []).map(String);
  const run = await launch(context, store, environment, {
    config,
    declaredPlugins
  });
  return run && describeRun(run);
}

/** A plain description of a run, for tests and the Assistant tools. */
export function describeRun(run: Run) {
  return {
    runName: run.record.runName,
    dir: run.files.dir,
    status: run.status,
    script: run.record.config.script,
    profiles: run.record.config.profiles,
    startedAt: run.record.startedAt,
    finishedAt: run.record.finishedAt,
    sessionId: run.progress.workflow?.sessionId,
    errorMessage: run.progress.errorMessage,
    liveStatus: run.record.withEvents,
    totals: totals(run.progress),
    processes: summarize(run.progress),
    tasks: Object.values(run.progress.tasks)
  };
}

async function relaunch(
  context: vscode.ExtensionContext,
  store: RunStore,
  run: Run,
  resume: boolean
) {
  if (isActive(run)) {
    vscode.window.showInformationMessage(
      `${run.record.runName} is still running.`
    );
    return;
  }
  const environment = await readyEnvironment();
  if (!environment) return;
  const sessionId =
    run.progress.workflow?.sessionId ?? (await sessionFromHistory(run));
  if (resume && !sessionId) {
    vscode.window.showErrorMessage(
      `Cannot resume ${run.record.runName}: its session is unknown.`
    );
    return;
  }
  const config: LaunchConfig = {
    ...run.record.config,
    resumeSessionId: resume ? sessionId : undefined
  };
  await launch(context, store, environment, {
    config,
    declaredPlugins: run.record.declaredPlugins
  });
}

async function sessionFromHistory(run: Run): Promise<string | undefined> {
  const text = await fs.promises
    .readFile(path.join(run.record.config.cwd, ".nextflow", "history"), "utf8")
    .catch(() => "");
  return parseHistory(text).find((e) => e.runName === run.record.runName)
    ?.sessionId;
}

async function launch(
  context: vscode.ExtensionContext,
  store: RunStore,
  environment: RunEnvironment,
  { config, declaredPlugins }: LaunchPlan
): Promise<Run | undefined> {
  const declaresEvents = declaredPlugins.some(
    (p) => p.split("@")[0] === environment.eventsPlugin.split("@")[0]
  );
  const withEvents = declaresEvents || environment.eventsPluginInstalled;
  // -plugins replaces the declared plugins, so it is only passed to add one
  const plugins =
    withEvents && !declaresEvents
      ? mergePlugins(declaredPlugins, environment.eventsPlugin)
      : [];

  const now = new Date();
  let runName = makeRunName(config.script, now);
  for (let i = 1; fs.existsSync(runFiles(config.cwd, runName).dir); i++) {
    runName = makeRunName(config.script, now, String(i));
  }
  const files = runFiles(config.cwd, runName);
  const record: RunRecord = {
    runName,
    config,
    declaredPlugins,
    withEvents,
    startedAt: now.toISOString()
  };

  try {
    await startRun(
      environment.nextflow!,
      environment.env,
      files,
      record,
      plugins
    );
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to start Nextflow: ${e}`);
    return undefined;
  }
  const run = store.add(files, record);
  vscode.commands.executeCommand("nextflow.runs.focus");
  showOutput(run, true);

  if (
    !withEvents &&
    !context.globalState.get("nextflow.positron.warnedAboutEvents")
  ) {
    context.globalState.update("nextflow.positron.warnedAboutEvents", true);
    vscode.window.showInformationMessage(
      `Live task status needs the ${environment.eventsPlugin} plugin, which is not installed. Only completed tasks are shown.`
    );
  }
  if (
    environment.inWorkbench &&
    !context.globalState.get(SUSPEND_WARNING_KEY)
  ) {
    context.globalState.update(SUSPEND_WARNING_KEY, true);
    vscode.window.showInformationMessage(
      "The pipeline runs inside this Workbench session. If the session is suspended or stopped, the run is stopped too."
    );
  }
  return run;
}

export function stopRun(store: RunStore, run: Run) {
  run.record.stopRequested = "stop";
  store.save(run);
  signalRun(run.record, "SIGTERM");
  vscode.window.setStatusBarMessage(
    `Stopping ${run.record.runName}; Nextflow is cancelling its tasks...`,
    5000
  );
}

async function killRun(store: RunStore, run: Run) {
  const confirmed = await confirm(
    `Force kill ${run.record.runName}? Nextflow cannot cancel its tasks, so jobs it submitted may keep running.`,
    "Force Kill"
  );
  if (!confirmed) return;
  run.record.stopRequested = "kill";
  store.save(run);
  signalRun(run.record, "SIGKILL");

  const remote = (await runningTasks(run)).filter((t) => !t.local);
  if (!remote.length) return;
  if (!runSetting("confirm", true)) {
    await killJobs(remote.map((t) => t.task.nativeId!));
    return;
  }
  const cancel = "Cancel Jobs";
  const next = await vscode.window.showWarningMessage(
    `${remote.length} task job(s) may still be running. Cancel them with ${(await runEnvironment()).launcherCli}?`,
    cancel
  );
  if (next === cancel) await killJobs(remote.map((t) => t.task.nativeId!));
}

/** Running tasks with a job id, and whether that id is a local process. */
async function runningTasks(run: Run) {
  const tasks = Object.values(run.progress.tasks).filter(
    (t) => t.nativeId && !isTerminal(t.status)
  );
  return Promise.all(
    tasks.map(async (task) => ({ task, local: await isLocalTask(task) }))
  );
}

async function isLocalTask(task: TaskState): Promise<boolean> {
  const pid = Number(task.nativeId);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const command = await processCommand(pid);
  return (
    !!command &&
    (command.includes(".command.") ||
      (!!task.workdir && command.includes(task.workdir)))
  );
}

async function killJobs(ids: string[]) {
  const environment = await runEnvironment();
  try {
    await execFile(environment.launcherCli, ["kill", ...ids], {
      env: environment.env,
      timeout: 60000
    });
    vscode.window.setStatusBarMessage(`Cancelled ${ids.length} job(s).`, 5000);
  } catch (e) {
    vscode.window.showErrorMessage(`Failed to cancel jobs: ${e}`);
  }
}

async function cancelTask(run: Run, task: TaskState) {
  if (!task.nativeId || isTerminal(task.status)) return;
  const confirmed = await confirm(
    `Cancel ${task.name} (job ${task.nativeId})? Nextflow treats it as a failed task and applies the process's error strategy.`,
    "Cancel Task"
  );
  if (!confirmed) return;
  if (await isLocalTask(task)) {
    try {
      process.kill(Number(task.nativeId), "SIGTERM");
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to cancel ${task.name}: ${e}`);
    }
  } else {
    await killJobs([task.nativeId]);
  }
}

async function cleanRun(run: Run) {
  if (isActive(run)) {
    vscode.window.showInformationMessage(
      `${run.record.runName} is still running.`
    );
    return;
  }
  const environment = await readyEnvironment();
  if (!environment) return;
  const options = { cwd: run.record.config.cwd, env: environment.env };
  let preview: string;
  try {
    preview = await execFile(
      environment.nextflow!,
      ["clean", "-n", run.record.runName],
      options
    );
  } catch (e) {
    vscode.window.showErrorMessage(`nextflow clean failed: ${e}`);
    return;
  }
  const count = preview.split("\n").filter((l) => l.trim()).length;
  if (!count) {
    vscode.window.showInformationMessage(
      `Nothing to clean for ${run.record.runName}.`
    );
    return;
  }
  const confirmed = await confirm(
    `Delete ${count} work directories of ${run.record.runName}? Resuming this run will then recompute those tasks.`,
    "Delete",
    preview.split("\n").slice(0, 10).join("\n")
  );
  if (!confirmed) return;
  try {
    await execFile(
      environment.nextflow!,
      ["clean", "-f", run.record.runName],
      options
    );
    vscode.window.setStatusBarMessage(`Cleaned ${run.record.runName}.`, 5000);
  } catch (e) {
    vscode.window.showErrorMessage(`nextflow clean failed: ${e}`);
  }
}

async function removeRun(store: RunStore, run: Run) {
  if (isActive(run)) {
    vscode.window.showInformationMessage(
      `Stop ${run.record.runName} before removing it.`
    );
    return;
  }
  if (!runSetting("confirm", true)) {
    store.remove(run);
    return;
  }
  const remove = "Remove";
  const removeFiles = "Remove and Delete Reports";
  const choice = await vscode.window.showWarningMessage(
    `Remove ${run.record.runName} from the list?`,
    {
      modal: true,
      detail: `Its logs and reports are in ${run.files.dir}. Work directories are kept; use Clean to delete them.`
    },
    remove,
    removeFiles
  );
  if (!choice) return;
  store.remove(run);
  if (choice === removeFiles)
    await fs.promises.rm(run.files.dir, { recursive: true, force: true });
}

async function showTaskFiles(task: TaskState) {
  if (!task.workdir) return;
  const entries = await fs.promises
    .readdir(task.workdir)
    .catch(() => [] as string[]);
  if (!entries.length) {
    vscode.window.showWarningMessage(
      `The work directory ${task.workdir} is empty or was removed.`
    );
    return;
  }
  const order = [
    ".command.err",
    ".command.log",
    ".command.out",
    ".command.sh",
    ".command.run",
    ".exitcode"
  ];
  const items = entries
    .sort(
      (a, b) =>
        (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) ||
        a.localeCompare(b)
    )
    .map((name) => ({
      label: name,
      description: order.includes(name) ? undefined : "output"
    }));
  const picked = await vscode.window.showQuickPick(items, {
    title: `${task.name}: ${task.workdir}`,
    placeHolder: "Open a file from the task's work directory"
  });
  if (picked) await openFile(path.join(task.workdir, picked.label));
}

async function openFile(file: string) {
  if (!fs.existsSync(file)) {
    vscode.window.showWarningMessage(`${file} does not exist (yet).`);
    return;
  }
  if (fs.statSync(file).isDirectory()) {
    await vscode.commands.executeCommand(
      "revealFileInOS",
      vscode.Uri.file(file)
    );
    return;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(file), {
    preview: true
  });
}

function notifyFinished(run: Run) {
  const { done, total, failed } = totals(run.progress);
  const summary = `${run.record.runName} ${run.status} (${done}/${total} tasks${failed ? `, ${failed} failed` : ""}, ${runDuration(run)}).`;
  const output = "Show Output";
  const report = "Open Report";
  const actions = fs.existsSync(run.files.report) ? [report, output] : [output];
  const show =
    run.status === "succeeded"
      ? vscode.window.showInformationMessage
      : vscode.window.showWarningMessage;
  show(summary, ...actions).then((choice) => {
    if (choice === output) showOutput(run);
    if (choice === report)
      vscode.commands.executeCommand("nextflow.positron.runs.openReport", {
        kind: "run",
        run
      });
  });
}

/** Ask before a destructive action, unless `nextflow.run.confirm` is off. */
async function confirm(
  message: string,
  action: string,
  detail?: string
): Promise<boolean> {
  if (!runSetting("confirm", true)) return true;
  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true, detail },
    action
  );
  return choice === action;
}

let diagnostics: vscode.OutputChannel | undefined;

async function showDiagnostics() {
  resetRunEnvironment();
  const environment = await runEnvironment();
  diagnostics ??= vscode.window.createOutputChannel("Nextflow Runs");
  const lines = [
    `Nextflow: ${environment.nextflow ?? "not found"}${environment.version ? ` (${environment.version})` : ""}`,
    `Java: ${environment.java ?? "not found"}${environment.env.JAVA_HOME ? ` (JAVA_HOME=${environment.env.JAVA_HOME})` : ""}`,
    `Events plugin: ${environment.eventsPlugin} ${environment.eventsPluginInstalled ? "installed" : "not installed"}`,
    `Workbench session: ${environment.inWorkbench ? "yes" : "no"}`,
    `PATH: ${environment.env.PATH}`
  ];
  try {
    const whoami = await execFile(environment.launcherCli, ["whoami"], {
      env: environment.env,
      timeout: 30000
    });
    lines.push(`Launcher (${environment.launcherCli}): ${whoami.trim()}`);
  } catch (e) {
    lines.push(`Launcher (${environment.launcherCli}): unavailable (${e})`);
  }
  if (environment.problems.length)
    lines.push("", "Problems:", ...environment.problems.map((p) => `- ${p}`));
  diagnostics.clear();
  diagnostics.appendLine(lines.join("\n"));
  diagnostics.show();
}
