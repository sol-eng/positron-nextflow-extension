// Launching, following and managing pipeline runs from the "Pipeline Runs"
// view.

import * as fs from "fs";
import * as os from "os";
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
import {
  cancelJobs,
  stopDriverJob,
  submitDriverJob,
  workbenchApi
} from "./driverJob";
import {
  driverJobAvailable,
  driverOptions,
  pickLaunch,
  type LaunchPlan
} from "./launch";
import {
  makeRunName,
  mergePlugins,
  resolveDriverMode,
  runFiles,
  type LaunchConfig
} from "./launchArgs";
import { isTerminal, summarize, totals, type TaskState } from "./model";
import { trackOutputTerminals, showOutput } from "./output";
import { processCommand, signalRun, startRun, type RunRecord } from "./runner";
import { isActive, RunStore, type Run } from "./store";
import { output, reportErrors } from "./log";
import {
  describeArg,
  resolveRun,
  resolveTask,
  resolveUri,
  withRun
} from "./select";
import { parseHistory } from "./trace";
import { RunsTreeProvider, runDuration } from "./tree";

export type { Run, RunStore } from "./store";

const SUSPEND_WARNING_KEY = "nextflow.positron.warnedAboutSuspend";

export function activateRuns(context: vscode.ExtensionContext): RunStore {
  const store = new RunStore(context);
  const tree = new RunsTreeProvider(store);
  const view = vscode.window.createTreeView("nextflow.runs", {
    treeDataProvider: tree,
    showCollapseAll: true,
    // to delete several runs at once
    canSelectMany: true
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
  store.onDidFinish((run) => {
    notifyFinished(run);
    cancelOrphans(run);
  });

  const commands: Record<string, (...args: any[]) => unknown> = {
    "nextflow.positron.runs.run": (uri?: unknown) =>
      runPipeline(context, store, resolveUri(uri)),
    "nextflow.positron.runs.runAgain": (node?: unknown) =>
      withRun(store, node, (run) => relaunch(context, store, run, false)),
    "nextflow.positron.runs.resume": (node?: unknown) =>
      withRun(store, node, (run) => relaunch(context, store, run, true)),
    "nextflow.positron.runs.stop": (node?: unknown) =>
      withRun(store, node, (run) => stopRun(store, run), isActive),
    "nextflow.positron.runs.kill": (node?: unknown) =>
      withRun(store, node, (run) => killRun(store, run), isActive),
    "nextflow.positron.runs.clean": (node?: unknown) =>
      withRun(store, node, (run) => cleanRun(run)),
    "nextflow.positron.runs.showOutput": (node?: unknown) =>
      withRun(store, node, (run) => showOutput(run)),
    "nextflow.positron.runs.openLog": (node?: unknown) =>
      withRun(store, node, (run) => openFile(run.files.log)),
    "nextflow.positron.runs.remove": (node?: unknown) =>
      withRun(store, node, (run) => removeRun(store, run)),
    // the second argument is the tree's selection, to delete several runs
    "nextflow.positron.runs.delete": async (
      node?: unknown,
      selected?: unknown
    ) => {
      const picked = (
        Array.isArray(selected) && selected.length ? selected : [node]
      )
        .map((n) => resolveRun(store, n))
        .filter((r): r is Run => !!r);
      if (picked.length) return deleteRuns(store, [...new Set(picked)]);
      return withRun(
        store,
        undefined,
        (run) => deleteRuns(store, [run]),
        (r) => !isActive(r)
      );
    },
    "nextflow.positron.runs.cancelTask": (node?: unknown) =>
      withTask(store, node, ({ run, task }) => cancelTask(run, task)),
    "nextflow.positron.runs.showTaskFiles": (node?: unknown) =>
      withTask(store, node, ({ task }) => showTaskFiles(task)),
    "nextflow.positron.runs.copyWorkDir": (node?: unknown) =>
      withTask(
        store,
        node,
        ({ task }) =>
          task.workdir && vscode.env.clipboard.writeText(task.workdir)
      ),
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
      vscode.commands.registerCommand(id, reportErrors(id, fn))
    )
  );
  store.load();
  return store;
}

/** Task commands only come from the tree, so a task node is required. */
function withTask(
  store: RunStore,
  arg: unknown,
  action: (found: { run: Run; task: TaskState }) => unknown
) {
  const found = resolveTask(store, arg);
  if (!found) {
    output().appendLine(`Could not find the task for ${describeArg(arg)}`);
    vscode.window.showWarningMessage(
      "Could not find that task; refresh the Pipeline Runs view and try again."
    );
    return;
  }
  return action(found);
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
  // without prompting: a Workbench job when the setting allows one and its
  // cluster is known, otherwise in this session
  const { mode } = resolveDriverMode(
    runSetting<string>("driver", "auto"),
    await driverJobAvailable(environment)
  );
  const cluster =
    config.workbench?.cluster ??
    resolved?.workbench?.cluster ??
    (runSetting("headless.cluster", "") || undefined);
  const driver =
    mode === "job" && cluster ? driverOptions(environment, cluster) : undefined;
  const run = await launch(context, store, environment, {
    config,
    declaredPlugins,
    driver
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
    driver: run.record.mode === "job" ? "job" : "session",
    driverJobId: run.record.jobId,
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
    declaredPlugins: run.record.declaredPlugins,
    // where the driver ran last time, with the same job options
    driver: run.record.mode === "job" ? run.record.driver : undefined
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
  { config, declaredPlugins, driver }: LaunchPlan
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
    if (driver) {
      await submitDriverJob(environment, files, record, plugins, driver);
    } else {
      record.mode = "local";
      await startRun(
        environment.nextflow!,
        environment.env,
        files,
        record,
        plugins
      );
    }
  } catch (e) {
    vscode.window.showErrorMessage(
      `Failed to ${driver ? "submit the Nextflow driver job" : "start Nextflow"}: ${e instanceof Error ? e.message : e}`
    );
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
  if (driver) {
    vscode.window.setStatusBarMessage(
      `Submitted ${runName} as Workbench job ${record.jobId} on ${driver.cluster}.`,
      8000
    );
  } else if (
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

export async function stopRun(store: RunStore, run: Run) {
  run.record.stopRequested = "stop";
  store.save(run);
  if (run.record.mode === "job" && run.record.jobId) {
    const graceful = await stopDriverJob(
      await runEnvironment(),
      run.record.jobId,
      true
    );
    if (!graceful) {
      vscode.window.showWarningMessage(
        "The launcher CLI cannot stop jobs gracefully (it needs 0.3.0 or later), so the driver was stopped at once; its task jobs are cancelled when it has ended."
      );
      return;
    }
  } else {
    signalRun(run.record, "SIGTERM");
  }
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
  if (run.record.mode === "job" && run.record.jobId) {
    // the task jobs it leaves behind are cancelled once the driver has ended
    await stopDriverJob(await runEnvironment(), run.record.jobId, false);
    return;
  }
  // tell local task processes from task jobs before the kill ends them
  const remote = (await runningTasks(run)).filter((t) => !t.local);
  signalRun(run.record, "SIGKILL");
  if (!remote.length) return;
  if (!runSetting("confirm", true)) {
    await killJobs(remote.map((t) => t.task.nativeId!));
    return;
  }
  const cancel = "Cancel Jobs";
  const next = await vscode.window.showWarningMessage(
    `${remote.length} task job(s) may still be running. Cancel their Workbench jobs?`,
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
    tasks.map(async (task) => ({
      task,
      local: run.record.mode !== "job" && (await isLocalTask(task))
    }))
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
  try {
    await cancelJobs(await runEnvironment(), ids);
    vscode.window.setStatusBarMessage(`Cancelled ${ids.length} job(s).`, 5000);
  } catch (e) {
    vscode.window.showErrorMessage(
      `Failed to cancel jobs: ${e instanceof Error ? e.message : e}`
    );
  }
}

async function cancelTask(run: Run, task: TaskState) {
  if (!task.nativeId || isTerminal(task.status)) return;
  const confirmed = await confirm(
    `Cancel ${task.name} (job ${task.nativeId})? Nextflow treats it as a failed task and applies the process's error strategy.`,
    "Cancel Task"
  );
  if (!confirmed) return;
  if (run.record.mode !== "job" && (await isLocalTask(task))) {
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

/**
 * The work directories `nextflow clean` would delete for a run now. It leaves
 * out those that other runs still use, so this can be empty for a run that
 * still holds references to shared work directories.
 */
async function workDirsToClean(
  environment: RunEnvironment,
  run: Run
): Promise<string[]> {
  try {
    const preview = await execFile(
      environment.nextflow!,
      ["clean", "-n", run.record.runName],
      {
        cwd: run.record.config.cwd,
        env: environment.env
      }
    );
    return preview.split("\n").filter((l) => l.trim());
  } catch {
    // not in Nextflow's history, e.g. a driver that failed before it started
    return [];
  }
}

/**
 * Remove runs from the list and delete their logs and reports and, with
 * `nextflow clean`, their work directories. Nextflow keeps a work directory
 * that another run still uses (e.g. through -resume) until that run is
 * cleaned too. Published results (publishDir) are not touched: other runs
 * may have published to the same place.
 */
async function deleteRuns(store: RunStore, runs: Run[]) {
  const active = runs.filter(isActive);
  if (active.length) {
    vscode.window.showInformationMessage(
      `Stop ${active.map((r) => r.record.runName).join(", ")} before deleting ${active.length === 1 ? "it" : "them"}.`
    );
  }
  const targets = runs.filter((r) => !isActive(r));
  if (!targets.length) return;

  const environment = await runEnvironment();
  const canClean = !!environment.nextflow && !environment.problems.length;
  const workDirs = new Map<Run, string[]>();
  if (canClean) {
    await withProgressNotification(
      "Finding the runs' work directories...",
      async () => {
        for (const run of targets)
          workDirs.set(run, await workDirsToClean(environment, run));
      }
    );
  }
  const dirCount = [...workDirs.values()].reduce(
    (n, dirs) => n + dirs.length,
    0
  );
  const names = targets.map((r) => r.record.runName);
  const what = targets.length === 1 ? names[0] : `${targets.length} runs`;
  const confirmed = await confirm(
    `Delete ${what}?`,
    "Delete",
    [
      `This removes ${targets.length === 1 ? "it" : "them"} from Pipeline Runs and deletes ${targets.length === 1 ? "its" : "their"} logs and reports` +
        (canClean
          ? `${dirCount ? ` and ${dirCount} task work director${dirCount === 1 ? "y" : "ies"}` : ""}.`
          : ". Work directories are kept: Nextflow is not available to clean them."),
      "Published results (e.g. publishDir) are kept, and so are work directories that other runs still use.",
      ...(targets.length > 1 ? ["", ...names] : [])
    ].join("\n")
  );
  if (!confirmed) return;

  const failed: string[] = [];
  for (const run of targets) {
    try {
      // even with nothing to delete now, cleaning releases the run's
      // references, so the last run that shares a work directory deletes it
      if (canClean && (await inHistory(run))) {
        await execFile(
          environment.nextflow!,
          ["clean", "-f", run.record.runName],
          {
            cwd: run.record.config.cwd,
            env: environment.env
          }
        );
      }
      await fs.promises.rm(run.files.dir, { recursive: true, force: true });
      store.remove(run);
    } catch (e) {
      failed.push(
        `${run.record.runName}: ${e instanceof Error ? e.message : e}`
      );
    }
  }
  if (failed.length) {
    vscode.window.showErrorMessage(
      `Could not delete ${failed.length} run(s). If another run in the same launch directory is active, Nextflow's cache is locked until it ends.`,
      { modal: true, detail: failed.join("\n") }
    );
  }
  const deleted = targets.length - failed.length;
  if (deleted) {
    vscode.window.setStatusBarMessage(
      `Deleted ${deleted === 1 ? names[0] : `${deleted} runs`}.`,
      5000
    );
  }
}

async function inHistory(run: Run): Promise<boolean> {
  const text = await fs.promises
    .readFile(path.join(run.record.config.cwd, ".nextflow", "history"), "utf8")
    .catch(() => "");
  return parseHistory(text).some((e) => e.runName === run.record.runName);
}

function withProgressNotification<T>(
  title: string,
  task: () => Promise<T>
): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    task
  );
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

/**
 * A driver job that ended without finishing (stopped at once, killed, or
 * evicted) cannot cancel its tasks; cancel the task jobs it left behind.
 */
async function cancelOrphans(run: Run) {
  const ids = run.orphans ?? [];
  run.orphans = undefined;
  if (!ids.length) return;
  try {
    await cancelJobs(await runEnvironment(), ids);
    vscode.window.setStatusBarMessage(
      `Cancelled ${ids.length} task job(s) that ${run.record.runName} left running.`,
      8000
    );
  } catch (e) {
    vscode.window.showWarningMessage(
      `${run.record.runName} left ${ids.length} task job(s) running, which could not be cancelled: ${e instanceof Error ? e.message : e}`
    );
  }
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

async function showDiagnostics() {
  resetRunEnvironment();
  const environment = await runEnvironment();
  const channel = output();
  const lines = [
    `Nextflow: ${environment.nextflow ?? "not found"}${environment.version ? ` (${environment.version})` : ""}`,
    `Java: ${environment.java ?? "not found"}${environment.env.JAVA_HOME ? ` (JAVA_HOME=${environment.env.JAVA_HOME})` : ""}`,
    `Events plugin: ${environment.eventsPlugin} ${environment.eventsPluginInstalled ? "installed" : "not installed"}`,
    `Workbench session: ${environment.inWorkbench ? "yes" : "no"}`,
    `Driver as a Workbench Job: ${(await driverJobAvailable(environment)) ? `available (setting: ${runSetting("driver", "auto")}, image: ${driverOptions(environment, "-").image ?? "the cluster default"})` : "not available here"}`,
    `PATH: ${environment.env.PATH}`
  ];
  try {
    const { auth, server } = await workbenchApi(environment).whoami();
    lines.push(
      `Workbench API: ${os.userInfo().username} via ${auth} on ${server}`
    );
  } catch (e) {
    lines.push(
      `Workbench API: unavailable (${e instanceof Error ? e.message : e})`
    );
  }
  if (environment.problems.length)
    lines.push("", "Problems:", ...environment.problems.map((p) => `- ${p}`));
  channel.appendLine(lines.join("\n"));
  channel.show();
}
