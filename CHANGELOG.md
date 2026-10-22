# Changelog

All notable changes to Positron Nextflow are documented here. See [Keep a Changelog](https://keepachangelog.com/) for how this file is structured.

Positron Nextflow is a fork of the [Nextflow extension for VS Code](https://github.com/nextflow-io/vscode-language-nextflow). Each release lists the upstream revision it is based on; see upstream's [changelog](https://github.com/nextflow-io/vscode-language-nextflow/blob/main/CHANGELOG.md) for the changes in those releases.

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
