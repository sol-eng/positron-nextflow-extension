---
name: nextflow-runs
description: Inspect, explain, start, resume and stop the Nextflow pipeline runs shown in Positron's Pipeline Runs view (Positron Nextflow extension), including runs whose tasks run as Posit Workbench jobs. Use for questions such as "why did my Nextflow run fail?", "which tasks are still running?", "what's the status of my pipeline?", "run / resume this pipeline", or "stop the run".
license: MIT
---

# Nextflow pipeline runs in Positron

The Positron Nextflow extension starts and follows Nextflow runs, and keeps each run's state: per-process and per-task status, Nextflow's error report, and each task's work directory. Ask the extension through the commands below instead of exploring files or processes in a shell. It already knows which run is which and where everything is.

Run each command with the `positronCommand` tool. Every command returns JSON.

| Command id                                   | Arguments                                                                                                                                                  | Does                                                                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nextflow.positron.assistant.listRuns`       | none                                                                                                                                                       | The runs started from Positron in this workspace, most recent first: `runName`, `status`, `script`, `profiles`, times, and task `totals`. Read-only. |
| `nextflow.positron.assistant.runStatus`      | `[runName]` (optional; defaults to the most recent run)                                                                                                    | One run in detail; see below. Read-only.                                                                                                             |
| `nextflow.positron.assistant.launchPipeline` | `[{ "script": "main.nf", "profiles": ["test", "docker"], "params": { "input": "samples.csv" }, "resumeRunName": "..." }]`, where only `script` is required | Starts a run, which then appears in Pipeline Runs. `resumeRunName` resumes an earlier run from its cached tasks. Returns the new run's `runName`.    |
| `nextflow.positron.assistant.stopRun`        | `[runName]` (optional; defaults to the most recent run)                                                                                                    | Stops a running run: Nextflow cancels its tasks, including Workbench jobs.                                                                           |

Starting and stopping runs changes the user's work, so the user is asked to approve them. Only start, resume or stop a run when the user asked for it.

To start a run, use `launchPipeline`, never `nextflow run` in a shell. A run started in a shell does not show in Pipeline Runs, and its status cannot be followed. `script` may be relative to the workspace folder. `params` are the pipeline's parameters, as given with `--name value` on the command line.

## Explaining a failed run

1. Call `runStatus`, with the `runName` the user means if they named one, from `listRuns`.
2. Read the result:
   - `status`: `queued`, `starting`, `running`, `succeeded`, `failed`, `stopped`, or `lost` (ended without a known outcome, e.g. killed).
   - `errorMessage`: Nextflow's error report for the run.
   - `failedTasks`: for each task, its `name` (process and tag), `exit` code, `attempt`, `workdir`, and `stderr`, the end of its `.command.err`. The cause of a failure is usually there.
   - `failedTasksNotShown` / `runningTasksNotShown`: how many more tasks there are than were listed.
   - `processes`: per-process counts; `totals` for the whole run.
   - `runningTasks`: tasks still running, with their `jobId` (a Workbench job id, or a process id for local tasks).
3. Explain the cause in terms of the process and its inputs. Quote the relevant lines, and suggest a fix in the pipeline, its parameters or config, or the environment.

If `stderr` is not enough, read the task's files in its `workdir`: `.command.sh` (the script as run), `.command.out`, `.command.err`, `.command.log`, and `.exitcode`. Each run's own files are in `.nextflow/positron/<runName>/` under its launch directory: `output.log` (Nextflow's console output), `nextflow.log`, and `events.ndjson`.

## Status questions

For "is it done?" or "what's running?", call `runStatus` and report `status`, `totals`, and `runningTasks`. Runs keep going while the user works. Call `runStatus` again rather than relying on an earlier answer.
