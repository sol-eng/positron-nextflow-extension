# Changelog

All notable changes to Positron Nextflow are documented here. See [Keep a Changelog](https://keepachangelog.com/) for how this file is structured.

Positron Nextflow is a fork of the [Nextflow extension for VS Code](https://github.com/nextflow-io/vscode-language-nextflow). Each release lists the upstream revision it is based on; see upstream's [changelog](https://github.com/nextflow-io/vscode-language-nextflow/blob/main/CHANGELOG.md) for the changes in those releases.

## [Unreleased]

### Added

- Headless runs on Posit Workbench: Run Pipeline can start Nextflow itself as a Workbench Job, so the run keeps going when the session is suspended or stopped, and a later session follows it. The job runs in the session's image by default (`PWB_SESSION_CONTAINER_IMAGE`). It submits the pipeline's tasks with Workbench credentials of its own, which last 7 days.

  - Stop stops the job gracefully, so Nextflow cancels its tasks. This needs posit-workbench-nf-launcher 0.3.0; older launchers stop it at once.
  - Task jobs that a driver left running when it ended without finishing are cancelled.
  - The `nextflow.run.driver` setting (`auto`, `local` or `job`) and the `nextflow.run.headless.*` settings for the cluster, image, CPUs and memory.

- Task dashboard in the Viewer, opened by clicking a task in Pipeline Runs.
  - It shows the task's status, exit code, attempt, duration, Workbench job id, and requested vs used CPU and memory.
  - Its files appear as labelled sections: error output, output, script, combined log, resource usage, and the Nextflow wrapper. A failed task leads with its errors.
  - It lists the task's outputs and staged inputs. HTML outputs, such as FastQC reports, open in the Viewer, CSV/TSV in the Data Explorer, and other files in the editor.
  - Its logs refresh while the task runs.
- Run dashboard in the Viewer, from the dashboard button on a run.
  - It shows per-process progress, failed tasks with the end of their error output, the running tasks, and links to the report, timeline, DAG and trace.

### Fixed

- Headless runs failed at once on Kubernetes with `mkdir: cannot create directory '//.nextflow'`: the driver job's user has no home directory in the container. The driver now sets `HOME`, `USER`, `LOGNAME`, `NXF_HOME` and its `PATH` from the session, as nf-workbench does for task jobs.
- A driver job that ends before Nextflow starts is shown as failed, with the end of its output as the error, instead of as lost.
- Force Kill no longer sends a run's local task processes to the Workbench launcher to be cancelled as jobs.

## [0.1.1] - 2026-10-22

Based on upstream [1.8.1](https://github.com/nextflow-io/vscode-language-nextflow/releases/tag/v1.8.1), at [`c149b5f`](https://github.com/nextflow-io/vscode-language-nextflow/commit/c149b5f).

### Changed

- From upstream 1.8.1: the language server uses a standalone build on Linux and macOS (Apple silicon), so it no longer needs Java there. Old language server versions are removed from the local cache.
- Run Pipeline shows the profile picker straight away while it reads the profiles, and later steps show their progress as a notification.

### Fixed

- Failures in the run commands are shown as an error message, with details in the Nextflow Runs output, instead of failing silently.
- Open Report and the other report commands no longer fail when the clicked run cannot be found; like the other run and task commands, they fall back to a picker. Each command invocation is logged with its argument shape in the Nextflow Runs output.

## [0.1.0] - 2026-10-22

Based on upstream 1.8.0 plus two dependency updates, at [`d5061af`](https://github.com/nextflow-io/vscode-language-nextflow/commit/d5061af) ("Bump katex and mermaid (#248)").

### Added

- Run, follow and manage pipelines from the Pipeline Runs view.
  - Launch with profiles, parameters, and the Workbench cluster and resource profile.
  - Follow the run with live status per process and task.
  - Stop, force kill, resume, run again or clean a run, and cancel single tasks.
  - Runs keep going when the window is reloaded or closed.
- Debug a task in the R or Python console, in its work directory, with its resolved script.
- Open a run's report, timeline and DAG in the Viewer, and its trace in the Data Explorer.
- Show the DAG preview in the Viewer.
- Positron Assistant tools to list runs, explain failed runs, and launch or stop runs.
- Run R and Python process scripts in the console.
- Open trace files and CSV/TSV files in the Data Explorer.
- Sign in to Seqera Cloud with a personal access token.

### Changed

- The extension ID is `posit.positron-nextflow`. It stays inactive while the official `nextflow.nextflow` extension is installed.

Live status needs the nf-workbench plugin 0.2.0 or later, from [posit-sdk-nextflow](https://github.com/michaelmayer2/posit-sdk-nextflow).
