// Starts `nextflow run` as a detached process and persists what is needed to
// follow and control it after a window reload.

import * as cp from "child_process";
import * as fs from "fs";

import { execFile } from "./env";
import {
  buildRunArgs,
  buildRunConfig,
  isNextflowRun,
  type LaunchConfig,
  type RunFiles
} from "./launchArgs";

export type RunRecord = {
  runName: string;
  config: LaunchConfig;
  /** plugins the pipeline declares, for Run Again */
  declaredPlugins: string[];
  withEvents: boolean;
  /** where the driver runs; runs from before this field ran locally */
  mode?: "local" | "job";
  /** the driver's Workbench job, for `mode: "job"` */
  jobId?: string;
  driver?: {
    cluster: string;
    image?: string;
    cpus: number;
    memoryMb: number;
    javaHome?: string;
  };
  pid?: number;
  /** process group of the run and its local tasks */
  pgid?: number;
  startedAt: string;
  finishedAt?: string;
  /** the run's outcome in `.nextflow/history` */
  outcome?: string;
  stopRequested?: "stop" | "kill";
};

export function readRecord(files: RunFiles): RunRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(files.record, "utf8"));
  } catch {
    return undefined;
  }
}

export function writeRecord(files: RunFiles, record: RunRecord) {
  fs.writeFileSync(files.record, JSON.stringify(record, null, 2));
}

// Starts "$@" in the background with its output appended to $1 and prints
// its pid. The shell exits right away, so the run is adopted by init.
const LAUNCH_SCRIPT =
  'out="$1"; shift; "$@" >>"$out" 2>&1 </dev/null & echo $!';

/**
 * Start the run so that it is not a descendant of the extension host, which
 * Positron kills on window close or reload. It also runs in its own session,
 * so it is not sent the SIGHUP that would abort it.
 */
export async function startRun(
  nextflow: string,
  env: NodeJS.ProcessEnv,
  files: RunFiles,
  record: RunRecord,
  plugins: string[]
): Promise<void> {
  fs.mkdirSync(files.dir, { recursive: true });
  fs.writeFileSync(
    files.config,
    buildRunConfig(record.config, files, record.withEvents)
  );
  const args = buildRunArgs(record.config, files, record.runName, plugins);
  const output = await new Promise<string>((resolve, reject) => {
    const shell: cp.ChildProcess = cp.spawn(
      "/bin/sh",
      ["-c", LAUNCH_SCRIPT, "sh", files.output, nextflow, ...args],
      {
        cwd: record.config.cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    record.pgid = shell.pid;
    shell.stdout!.on("data", (d) => (stdout += d));
    shell.stderr!.on("data", (d) => (stderr += d));
    shell.on("error", reject);
    shell.on("close", (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`))
    );
  });
  const pid = Number(output.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`could not start ${nextflow}: ${output}`);
  }
  record.pid = pid;
  writeRecord(files, record);
}

/** Is the run's process still alive, and not a reused pid? */
export async function isRunAlive(record: RunRecord): Promise<boolean> {
  if (!record.pid || record.finishedAt) return false;
  try {
    process.kill(record.pid, 0);
  } catch {
    return false;
  }
  const command = await processCommand(record.pid);
  return command === undefined || isNextflowRun(command, record.runName);
}

export async function processCommand(pid: number): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  return execFile("ps", ["-o", "command=", "-p", String(pid)]).then(
    (out) => out.trim(),
    () => ""
  );
}

/**
 * SIGTERM lets Nextflow cancel its running tasks before it exits. SIGKILL
 * also goes to the run's process group, which includes locally running
 * tasks.
 */
export function signalRun(record: RunRecord, signal: "SIGTERM" | "SIGKILL") {
  if (!record.pid) return;
  const targets = [record.pid];
  if (signal === "SIGKILL" && record.pgid) targets.unshift(-record.pgid);
  for (const pid of targets) {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}
