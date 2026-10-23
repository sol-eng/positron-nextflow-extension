// Runs the Nextflow driver as a Posit Workbench Job through the launcher CLI,
// so a run outlives the session that started it. The job gets credentials of
// its own from Workbench, which its Nextflow process uses for every task job
// it submits, so none are passed to it. Submit, status and stop are the only
// operations needed; another scheduler (e.g. Slurm) would provide the same.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { execFile, type RunEnvironment } from "./env";
import {
  buildDriverScript,
  buildRunArgs,
  buildRunConfig,
  parseJobStatus,
  type JobState,
  type RunFiles
} from "./launchArgs";
import { writeRecord, type RunRecord } from "./runner";

export type DriverJobOptions = NonNullable<RunRecord["driver"]>;

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
  const args = [
    "submit",
    "--cluster",
    options.cluster,
    "--name",
    `nf-driver-${record.runName}`,
    "--cpus",
    String(options.cpus),
    "--mem-mb",
    String(options.memoryMb)
  ];
  if (options.image) args.push("--container", options.image);
  args.push(driver);
  const output = await execFile(environment.launcherCli, args, {
    cwd: files.dir,
    env: environment.env,
    timeout: 60000
  });
  const jobId = output.trim();
  if (!jobId) throw new Error("the launcher did not return a job id");
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
    const output = await execFile(environment.launcherCli, ["status"], {
      env: environment.env,
      timeout: 60000
    });
    return parseJobStatus(output, jobId);
  } catch {
    // the launcher is unreachable: keep the last known state
    return undefined;
  }
}

let gracefulSupported: Promise<boolean> | undefined;

/** `kill --graceful` arrived with launcher 0.3.0. */
function supportsGraceful(environment: RunEnvironment): Promise<boolean> {
  gracefulSupported ??= execFile(environment.launcherCli, ["kill", "--help"], {
    env: environment.env
  }).then(
    (help) => help.includes("--graceful"),
    () => false
  );
  return gracefulSupported;
}

/**
 * Stop the driver job. A graceful stop sends SIGTERM, so Nextflow cancels its
 * tasks; it falls back to a forced stop with launchers older than 0.3.0,
 * which leaves the task jobs to the orphan sweep. Returns whether it was
 * graceful.
 */
export async function stopDriverJob(
  environment: RunEnvironment,
  jobId: string,
  graceful: boolean
): Promise<boolean> {
  const useGraceful = graceful && (await supportsGraceful(environment));
  await execFile(
    environment.launcherCli,
    ["kill", ...(useGraceful ? ["--graceful"] : []), jobId],
    { env: environment.env, timeout: 60000 }
  );
  return useGraceful;
}

export async function cancelJobs(environment: RunEnvironment, ids: string[]) {
  if (!ids.length) return;
  await execFile(environment.launcherCli, ["kill", ...ids], {
    env: environment.env,
    timeout: 60000
  });
}
