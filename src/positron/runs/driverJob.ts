// Runs the Nextflow driver as a Posit Workbench Job through the Workbench API,
// so a run outlives the session that started it. The job gets credentials of
// its own from Workbench, which its Nextflow process uses for every task job
// it submits, so none are passed to it. Submit, status and stop are the only
// operations needed; another scheduler (e.g. Slurm) would provide the same.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { RunEnvironment } from "./env";
import {
  buildDriverScript,
  buildRunArgs,
  buildRunConfig,
  type JobState,
  type RunFiles
} from "./launchArgs";
import { writeRecord, type RunRecord } from "./runner";
import { WorkbenchApi } from "./workbenchApi";

export type DriverJobOptions = NonNullable<RunRecord["driver"]>;

/** The Workbench API with the credentials runs are started with. */
export function workbenchApi(environment: RunEnvironment): WorkbenchApi {
  return new WorkbenchApi(environment.env);
}

/** The JVM heap: most of the job's memory, leaving room for the JVM itself. */
function heapMb(memoryMb: number): number {
  return Math.max(512, Math.floor(memoryMb * 0.75));
}

export async function submitDriverJob(
  environment: RunEnvironment,
  files: RunFiles,
  record: RunRecord,
  plugins: string[],
  options: DriverJobOptions
): Promise<void> {
  fs.mkdirSync(files.dir, { recursive: true });
  fs.writeFileSync(
    files.config,
    buildRunConfig(record.config, files, record.withEvents)
  );
  const driver = path.join(files.dir, "driver.sh");
  fs.writeFileSync(
    driver,
    buildDriverScript({
      nextflow: environment.nextflow!,
      args: buildRunArgs(record.config, files, record.runName, plugins),
      cwd: record.config.cwd,
      output: files.output,
      home: os.homedir(),
      user: os.userInfo().username,
      nxfHome: environment.env.NXF_HOME ?? path.join(os.homedir(), ".nextflow"),
      xmxMb: heapMb(options.memoryMb),
      javaHome: options.javaHome
    }),
    { mode: 0o755 }
  );
  const jobId = await workbenchApi(environment).launchJob({
    cluster: options.cluster,
    name: `nf-driver-${record.runName}`,
    exe: "/bin/bash",
    args: [driver],
    workingDirectory: files.dir,
    container: options.image ? { image: options.image } : undefined,
    resourceLimits: [
      { type: "cpuCount", value: String(options.cpus) },
      { type: "memory", value: String(options.memoryMb) }
    ]
  });
  record.jobId = jobId;
  record.mode = "job";
  record.driver = options;
  writeRecord(files, record);
}

export async function driverJobState(
  environment: RunEnvironment,
  jobId: string
): Promise<JobState | undefined> {
  try {
    return await workbenchApi(environment).jobState(jobId);
  } catch {
    // Workbench is unreachable: keep the last known state
    return undefined;
  }
}

/**
 * Stop the driver job. A graceful stop sends SIGTERM, so Nextflow cancels its
 * tasks; a forced one leaves the task jobs to the orphan sweep. Returns
 * whether it was graceful.
 */
export async function stopDriverJob(
  environment: RunEnvironment,
  jobId: string,
  graceful: boolean
): Promise<boolean> {
  await workbenchApi(environment).stopJob(jobId, graceful);
  return graceful;
}

/** Stop task jobs, best-effort: a job may have ended already. */
export async function cancelJobs(environment: RunEnvironment, ids: string[]) {
  if (!ids.length) return;
  await workbenchApi(environment).stopJobs(ids);
}
