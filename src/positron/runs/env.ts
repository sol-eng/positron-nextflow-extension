// Resolves what a pipeline run needs from the machine: the `nextflow`
// executable, a Java it accepts, the events plugin, and the launcher CLI.

import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as semver from "semver";
import * as vscode from "vscode";

import { findExecutable } from "../../languageServer/utils/findExecutable";
import { parseNextflowVersion, pickEventsPlugin } from "./launchArgs";

export const MIN_NEXTFLOW_VERSION = "25.10.0";

export type RunEnvironment = {
  nextflow?: string;
  version?: string;
  /** the environment runs are started with */
  env: NodeJS.ProcessEnv;
  java?: string;
  /** the events plugin with its version, or the setting if none is installed */
  eventsPlugin: string;
  eventsPluginInstalled: boolean;
  /** set inside a Posit Workbench session */
  inWorkbench: boolean;
  problems: string[];
};

const LOCAL_BIN = path.join(os.homedir(), ".local", "bin");

let cached: Promise<RunEnvironment> | undefined;

export function runSetting<T>(key: string, fallback: T): T {
  return (
    vscode.workspace.getConfiguration("nextflow.run").get<T>(key) ?? fallback
  );
}

/** Forget the resolved environment, e.g. after a setting changed. */
export function resetRunEnvironment() {
  cached = undefined;
}

export function runEnvironment(): Promise<RunEnvironment> {
  cached ??= resolve();
  return cached;
}

async function resolve(): Promise<RunEnvironment> {
  const problems: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Nextflow and the launcher CLI are both installed into ~/.local/bin by
  // their setup instructions, which the extension host's PATH may lack. The
  // nf-workbench plugin looks up the launcher on the PATH it inherits.
  const paths = (env.PATH ?? "").split(path.delimiter);
  if (!paths.includes(LOCAL_BIN)) {
    env.PATH = [...paths, LOCAL_BIN].filter(Boolean).join(path.delimiter);
  }

  const java = resolveJava(env, problems);
  const nextflow = findNextflow();
  let version: string | undefined;
  if (nextflow) {
    const output = await execFile(nextflow, ["-version"], { env }).catch(
      (e) => `${e}`
    );
    version = parseNextflowVersion(output);
    if (!version) {
      problems.push(`Could not run \`${nextflow} -version\`: ${output.trim()}`);
    } else if (semver.lt(version, MIN_NEXTFLOW_VERSION)) {
      problems.push(
        `Nextflow ${version} is too old; ${MIN_NEXTFLOW_VERSION} or later is required.`
      );
    }
  } else {
    problems.push("Nextflow was not found.");
  }

  const eventsSetting = runSetting("eventsPlugin", "nf-workbench");
  const eventsPlugin = pickEventsPlugin(eventsSetting, installedPlugins(env));
  return {
    nextflow,
    version,
    env,
    java,
    eventsPlugin: eventsPlugin ?? eventsSetting,
    eventsPluginInstalled: eventsPlugin !== undefined,
    inWorkbench: !!(env.RS_SERVER_URL || env.POSIT_PRODUCT),
    problems
  };
}

function findNextflow(): string | undefined {
  const configured = runSetting("executable", "");
  if (configured) return fs.existsSync(configured) ? configured : undefined;
  const onPath = findExecutable("nextflow");
  if (onPath) return onPath;
  const local = path.join(LOCAL_BIN, "nextflow");
  return fs.existsSync(local) ? local : undefined;
}

/**
 * Nextflow uses JAVA_HOME when it is set, and `java` on the PATH otherwise.
 * A JAVA_HOME pointing at an old Java is dropped when the PATH has a newer
 * one, rather than failing the run.
 */
function resolveJava(
  env: NodeJS.ProcessEnv,
  problems: string[]
): string | undefined {
  const exe = process.platform === "win32" ? "java.exe" : "java";
  const configured = vscode.workspace
    .getConfiguration("nextflow")
    .get<string>("java.home");
  if (configured) {
    env.JAVA_HOME = configured;
    const java = path.join(configured, "bin", exe);
    if (javaMajor(java, env) >= 17) return java;
    problems.push(
      `\`nextflow.java.home\` (${configured}) is not Java 17 or later.`
    );
    return undefined;
  }
  if (env.JAVA_HOME) {
    const java = path.join(env.JAVA_HOME, "bin", exe);
    if (javaMajor(java, env) >= 17) return java;
    const withoutHome = { ...env, JAVA_HOME: undefined };
    const onPath = findExecutable(exe);
    if (onPath && javaMajor(onPath, withoutHome) >= 17) {
      delete env.JAVA_HOME;
      return onPath;
    }
    problems.push(
      `JAVA_HOME (${env.JAVA_HOME}) is not Java 17 or later. Set \`nextflow.java.home\`.`
    );
    return undefined;
  }
  const onPath = findExecutable(exe);
  if (onPath && javaMajor(onPath, env) >= 17) return onPath;
  problems.push("Java 17 or later was not found. Set `nextflow.java.home`.");
  return undefined;
}

function javaMajor(java: string, env: NodeJS.ProcessEnv): number {
  try {
    const result = cp.spawnSync(java, ["-version"], {
      env,
      encoding: "utf8",
      timeout: 10000
    });
    const version = `${result.stderr}${result.stdout}`.match(
      /version "(\d+)(?:\.(\d+))?/
    );
    if (!version) return 0;
    const major = Number(version[1]);
    // Java 8 and earlier report themselves as 1.x
    return major === 1 ? Number(version[2]) : major;
  } catch {
    return 0;
  }
}

/** The plugin directories Nextflow has installed, e.g. `nf-workbench-0.3.0`. */
function installedPlugins(env: NodeJS.ProcessEnv): string[] {
  const dir =
    env.NXF_PLUGINS_DIR ??
    path.join(env.NXF_HOME ?? path.join(os.homedir(), ".nextflow"), "plugins");
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export function execFile(
  file: string,
  args: string[],
  options: cp.ExecFileOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(
      file,
      args,
      { timeout: 120000, maxBuffer: 16 * 1024 * 1024, ...options },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${stderr || error.message}`.trim()));
        else resolve(`${stdout}`);
      }
    );
  });
}

/** Run `nextflow config` in `cwd` and parse its JSON output. */
export async function nextflowConfig(
  environment: RunEnvironment,
  cwd: string,
  args: string[]
): Promise<Record<string, any> | undefined> {
  if (!environment.nextflow) return undefined;
  try {
    const output = await execFile(
      environment.nextflow,
      ["config", ...args, "-o", "json"],
      { cwd, env: environment.env }
    );
    return JSON.parse(output.slice(output.indexOf("{")));
  } catch (e) {
    console.log("Nextflow: `nextflow config` failed:", e);
    return undefined;
  }
}

export function installNextflow() {
  const terminal = vscode.window.createTerminal({ name: "Install Nextflow" });
  terminal.show();
  terminal.sendText(
    `mkdir -p "${LOCAL_BIN}" && cd "${LOCAL_BIN}" && curl -s https://get.nextflow.io | bash && ./nextflow -version`
  );
  // the new executable is picked up the next time a run is started
  resetRunEnvironment();
}
