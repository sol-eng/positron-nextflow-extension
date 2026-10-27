// The interactive "Run Pipeline" flow: pick the script, profiles, params and
// Workbench settings, remembering the previous answers per script.

import * as path from "path";
import * as vscode from "vscode";

import { workbenchApi, type DriverJobOptions } from "./driverJob";
import type { Cluster } from "./workbenchApi";
import { nextflowConfig, runSetting, type RunEnvironment } from "./env";
import {
  formatParams,
  parseParams,
  resolveDriverMode,
  type LaunchConfig
} from "./launchArgs";

export type LaunchPlan = {
  config: LaunchConfig;
  /** plugins the pipeline declares with the chosen profiles */
  declaredPlugins: string[];
  /** run the driver as a Workbench job with these options, else locally */
  driver?: DriverJobOptions;
};

const lastConfigKey = (script: string) => `nextflow.positron.launch:${script}`;

export async function pickLaunch(
  context: vscode.ExtensionContext,
  environment: RunEnvironment,
  uri?: vscode.Uri
): Promise<LaunchPlan | undefined> {
  const script = await pickScript(uri);
  if (!script) return undefined;
  const cwd = path.dirname(script);
  const previous = context.workspaceState.get<LaunchConfig>(
    lastConfigKey(script)
  );

  const chosenProfiles = await pickProfiles(environment, cwd, previous);
  if (!chosenProfiles) return undefined;

  const params = await pickParams(cwd, previous);
  if (!params) return undefined;

  const resolved = await withProgress("Reading the pipeline's config...", () =>
    nextflowConfig(
      environment,
      cwd,
      chosenProfiles.length ? ["-profile", chosenProfiles.join(",")] : []
    )
  );
  const declaredPlugins: string[] = (resolved?.plugins ?? []).map(String);
  let workbench: LaunchConfig["workbench"];
  const usesWorkbench =
    resolved?.process?.executor === "workbench" ||
    declaredPlugins.some((p) => p.startsWith("nf-workbench"));
  if (usesWorkbench) {
    const picked = await pickWorkbench(
      environment,
      resolved?.workbench?.cluster,
      previous?.workbench
    );
    if (picked === null) return undefined;
    workbench = picked;
  }

  const driver = await pickDriver(
    environment,
    workbench?.cluster ?? resolved?.workbench?.cluster
  );
  if (driver === null) return undefined;

  const config: LaunchConfig = {
    script,
    cwd,
    profiles: chosenProfiles,
    paramsFile: params.paramsFile,
    params: params.params,
    workbench,
    extraArgs: vscode.workspace
      .getConfiguration("nextflow.run")
      .get<string[]>("extraArgs", [])
  };
  await context.workspaceState.update(lastConfigKey(script), config);
  return { config, declaredPlugins, driver };
}

let workbenchWorks: Promise<boolean> | undefined;

/**
 * A driver job can be submitted from a Workbench session whose credentials
 * the Workbench API accepts. The job then runs with Workbench credentials of
 * its own.
 */
export function driverJobAvailable(
  environment: RunEnvironment
): Promise<boolean> {
  if (!environment.inWorkbench) return Promise.resolve(false);
  workbenchWorks ??= Promise.resolve()
    .then(() => workbenchApi(environment).whoami())
    .then(
      () => true,
      () => {
        workbenchWorks = undefined;
        return false;
      }
    );
  return workbenchWorks;
}

/** The driver job's options from the settings, given its cluster. */
export function driverOptions(
  environment: RunEnvironment,
  cluster: string
): DriverJobOptions {
  return {
    cluster,
    // Workbench sets PWB_SESSION_CONTAINER_IMAGE in sessions
    image:
      runSetting("headless.image", "") ||
      environment.env.PWB_SESSION_CONTAINER_IMAGE ||
      undefined,
    cpus: runSetting("headless.cpus", 2),
    memoryMb: runSetting("headless.memory", 4096),
    javaHome:
      vscode.workspace.getConfiguration("nextflow").get<string>("java.home") ||
      undefined
  };
}

/**
 * Where the driver runs. Resolves to the job's options, to undefined to run
 * it in this session, or to null if cancelled.
 */
async function pickDriver(
  environment: RunEnvironment,
  pipelineCluster?: string
): Promise<DriverJobOptions | undefined | null> {
  const setting = runSetting<string>("driver", "auto");
  const available = await driverJobAvailable(environment);
  if (setting === "job" && !available) {
    vscode.window.showWarningMessage(
      "Running Nextflow as a Workbench Job needs a Positron session on Posit Workbench with a working launcher CLI; it runs in this session instead."
    );
  }
  const { mode, ask } = resolveDriverMode(setting, available);
  if (mode === "local") return undefined;
  if (ask) {
    const job = {
      label: "$(cloud) As a Workbench Job",
      description: "keeps running when this session is suspended or stopped",
      mode: "job"
    };
    const local = {
      label: "$(vm) In this session",
      description: "stops with the session",
      mode: "local"
    };
    const picked = await vscode.window.showQuickPick([job, local], {
      title: "Run Pipeline: Where should Nextflow run?",
      ignoreFocusOut: true
    });
    if (!picked) return null;
    if (picked.mode === "local") return undefined;
  }
  let cluster = pipelineCluster || runSetting("headless.cluster", "");
  if (!cluster) {
    const clusters = await withProgress("Listing Workbench clusters...", () =>
      listClusters(environment)
    );
    if (!clusters?.length) return undefined;
    const picked =
      clusters.length === 1
        ? clusters[0]
        : (
            await vscode.window.showQuickPick(
              clusters.map((c) => ({ label: c.name, cluster: c })),
              {
                title: "Run Pipeline: Cluster for the Nextflow driver",
                ignoreFocusOut: true
              }
            )
          )?.cluster;
    if (!picked) return null;
    cluster = picked.name;
  }
  return driverOptions(environment, cluster);
}

async function pickScript(uri?: vscode.Uri): Promise<string | undefined> {
  if (uri?.fsPath.endsWith(".nf")) return uri.fsPath;
  const active = vscode.window.activeTextEditor?.document.uri;
  if (
    active?.scheme === "file" &&
    active.fsPath.endsWith(".nf") &&
    !active.fsPath.endsWith(".nf.test")
  ) {
    return active.fsPath;
  }
  const found = await vscode.workspace.findFiles(
    "**/main.nf",
    "**/{work,.nextflow,node_modules,.git}/**",
    50
  );
  if (found.length === 1) return found[0].fsPath;
  if (found.length > 1) {
    const picked = await vscode.window.showQuickPick(
      found.map((f) => ({ label: vscode.workspace.asRelativePath(f), uri: f })),
      { title: "Run Pipeline: Entry script", ignoreFocusOut: true }
    );
    return picked?.uri.fsPath;
  }
  const chosen = await vscode.window.showOpenDialog({
    title: "Select the pipeline's entry script",
    filters: { Nextflow: ["nf"] }
  });
  return chosen?.[0].fsPath;
}

/**
 * Reading the profiles starts a JVM, which can take a while, so the picker is
 * shown straight away and filled in when they are known.
 */
function pickProfiles(
  environment: RunEnvironment,
  cwd: string,
  previous?: LaunchConfig
): Promise<string[] | undefined> {
  const quickPick = vscode.window.createQuickPick();
  quickPick.title = "Run Pipeline: Profiles";
  quickPick.placeholder = "Reading the pipeline's profiles...";
  quickPick.canSelectMany = true;
  quickPick.ignoreFocusOut = true;
  quickPick.busy = true;
  quickPick.enabled = false;
  quickPick.show();
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string[] | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
      quickPick.dispose();
    };
    quickPick.onDidAccept(() =>
      done(quickPick.selectedItems.map((item) => item.label))
    );
    quickPick.onDidHide(() => done(undefined));
    readProfiles(environment, cwd).then((profiles) => {
      if (settled) return;
      if (!profiles.length) {
        done([]);
        return;
      }
      quickPick.items = profiles.map((label) => ({ label }));
      quickPick.selectedItems = quickPick.items.filter((item) =>
        previous?.profiles.includes(item.label)
      );
      quickPick.placeholder = "Select the profiles to use, or none";
      quickPick.busy = false;
      quickPick.enabled = true;
    });
  });
}

async function readProfiles(
  environment: RunEnvironment,
  cwd: string
): Promise<string[]> {
  // `config -a` keeps the profiles block, which the resolved config drops
  const config = await nextflowConfig(environment, cwd, ["-a"]);
  return Object.keys(config?.profiles ?? {});
}

async function pickParams(
  cwd: string,
  previous?: LaunchConfig
): Promise<Pick<LaunchConfig, "params" | "paramsFile"> | undefined> {
  type Item = vscode.QuickPickItem & { action: string };
  const items: Item[] = [];
  if (previous && (previous.params.length || previous.paramsFile)) {
    items.push({
      label: "$(history) Same as last time",
      description: previous.paramsFile
        ? path.relative(cwd, previous.paramsFile)
        : formatParams(previous.params),
      action: "previous"
    });
  }
  items.push(
    { label: "$(dash) No parameters", action: "none" },
    {
      label: "$(edit) Enter parameters...",
      description: "--input samples.csv --outdir results",
      action: "enter"
    },
    {
      label: "$(file) Use a params file...",
      description: "JSON or YAML",
      action: "file"
    }
  );
  const picked = await vscode.window.showQuickPick(items, {
    title: "Run Pipeline: Parameters",
    ignoreFocusOut: true
  });
  if (!picked) return undefined;
  if (picked.action === "previous") {
    return { params: previous!.params, paramsFile: previous!.paramsFile };
  }
  if (picked.action === "none") return { params: [] };
  if (picked.action === "enter") {
    const value = await vscode.window.showInputBox({
      title: "Run Pipeline: Parameters",
      prompt: "Parameters as on the Nextflow command line",
      value: previous ? formatParams(previous.params) : "",
      ignoreFocusOut: true
    });
    return value === undefined ? undefined : { params: parseParams(value) };
  }
  const file = await vscode.window.showOpenDialog({
    title: "Select a params file",
    defaultUri: vscode.Uri.file(cwd),
    filters: { Params: ["json", "yaml", "yml"] }
  });
  return file ? { params: [], paramsFile: file[0].fsPath } : undefined;
}

/**
 * Returns the Workbench settings to override, undefined to keep the
 * pipeline's own, or null if cancelled.
 */
async function pickWorkbench(
  environment: RunEnvironment,
  configured?: string,
  previous?: LaunchConfig["workbench"]
): Promise<LaunchConfig["workbench"] | null> {
  const clusters = await withProgress("Listing Workbench clusters...", () =>
    listClusters(environment)
  );
  if (!clusters) return undefined;
  type Item = vscode.QuickPickItem & { cluster?: Cluster };
  const keep: Item = {
    label: "$(settings) Use the pipeline's setting",
    description: configured ? `cluster ${configured}` : "no cluster set"
  };
  const items: Item[] = [
    keep,
    ...clusters.map((cluster) => ({
      label: cluster.name,
      description: cluster.name === previous?.cluster ? "last used" : undefined,
      cluster
    }))
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: "Run Pipeline: Workbench cluster",
    ignoreFocusOut: true
  });
  if (!picked) return null;
  if (!picked.cluster) return undefined;
  const { name, resourceProfiles } = picked.cluster;
  if (!resourceProfiles.length) return { cluster: name };
  const profile = await vscode.window.showQuickPick(
    [
      { label: "$(settings) Cluster default", value: undefined },
      ...resourceProfiles.map((p) => ({
        label: p,
        description: p === previous?.resourceProfile ? "last used" : undefined,
        value: p
      }))
    ],
    { title: `Run Pipeline: Resource profile on ${name}`, ignoreFocusOut: true }
  );
  if (!profile) return null;
  return { cluster: name, resourceProfile: profile.value };
}

export async function listClusters(
  environment: RunEnvironment
): Promise<Cluster[] | undefined> {
  try {
    return await workbenchApi(environment).clusters();
  } catch (e) {
    vscode.window.showWarningMessage(
      `Could not list Workbench clusters; using the pipeline's setting. ${e instanceof Error ? e.message : e}`
    );
    return undefined;
  }
}

function withProgress<T>(title: string, task: () => Promise<T>): Thenable<T> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    task
  );
}
