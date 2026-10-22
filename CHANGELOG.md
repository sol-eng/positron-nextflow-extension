# Changelog

All notable changes to the Nextflow VS Code extension will be documented here.

See [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## Positron Nextflow

Releases of this fork. Its upstream base is listed with each release; the upstream releases follow below.

### [0.1.0] - 2026-10-22

Based on upstream 1.8.0.

- Run, follow and manage pipelines from the Pipeline Runs view: launch with profiles, parameters and the Workbench cluster and resource profile, then follow the run with live status per process and task. Runs can be stopped, force killed, resumed, run again or cleaned, and single tasks can be cancelled. Runs keep going when the window is reloaded or closed.
- Debug a task in the R or Python console, in its work directory, with its resolved script.
- Open a run's report, timeline and DAG in the Viewer, and its trace in the Data Explorer.
- Show the DAG preview in the Viewer.
- Positron Assistant tools to list runs, explain failed runs, and launch or stop runs.
- Run R and Python process scripts in the console.
- Open trace files and CSV/TSV files in the Data Explorer.
- Sign in to Seqera Cloud with a personal access token.
- Stay inactive while the official Nextflow extension is installed.

Live status needs the nf-workbench plugin 0.2.0 or later ([posit-sdk-nextflow](https://github.com/michaelmayer2/posit-sdk-nextflow)).

## Upstream

## [1.8.0] - 2026-10-12

- Add option for Nextflow 26.10
- Remove convert script to static types command
- Make tree view the default in Project view and bring it to parity with list view (#241)
- Add config preview for a process (#240)
- Highlight the active file in Project view (#120)
- Highlight process script blocks in their own language (#24)
- Add pan and zoom to DAG preview (#46)
- Fix unreadable DAG node labels in dark themes (#236)
- Use the signed-in GitHub session when querying releases (#238)
- Set a Content-Security-Policy on the webviews (#234)

## [1.7.1] - 2026-06-08

- Add syntax highlighting and filtering for Nextflow log files (#197)

## [1.7.0] - 2026-04-29

- Remove type checking setting
- Add option for Nextflow 26.04
- Remove Seqera chat participant, welcome pages

## [1.6.1] - 2026-01-23

- Add option for Nextflow 26.04 preview

## [1.6.0] - 2025-10-23

- Add syntax highlighting for `params` block
- Add syntax highlighting for type annotations
- Add command to convert scripts to static types
- Add setting to enable type checking
- Add option for Nextflow 25.10

## [1.5.2] - 2025-08-21

- Enable authentication in GitHub API requests

## [1.5.1] - 2025-08-06

- Fix font color in Project view (#149)
- Apply theme colors to control nodes in DAG preview

## [1.5.0] - 2025-06-17

- Launch pipeline in Seqera Cloud (#135)
- Add pipeline to Launchpad (#139)
- Bump default language version to 25.04

## [1.4.1] - 2025-05-14

- Check Java version on language server startup (#128)
- Preview error log in run history (#130)

## [1.4.0] - 2025-05-13

- Add 25.04 to language version options
- Generate process containers with Wave

## [1.3.0] - 2025-05-05

- Run history, Pipelines, Datasets, Data Buckets (#110)
- Replace Processes/Workflows view with Project view (#117)
- Add nf-test generation to Project view (#118)

## [1.2.0] - 2025-04-10

- Add extension settings for code completion and formatting
- Add extension setting for error reporting mode
- Add opt-in telemetry (#82)
- Add Seqera auth and webviews (#92)

## [1.1.0] - 2025-02-25

- Download language server on startup (#68)
- Add Seqera chat participant (#77)

## [1.0.4] - 2025-01-21

- Bump language server to [1.0.4](https://github.com/nextflow-io/language-server/releases/tag/v1.0.4)
- Await language server shutdown on deactivate (#58)
- Cleanup TextMate grammars

## [1.0.3] - 2024-12-16

- Bump language server to [1.0.3](https://github.com/nextflow-io/language-server/releases/tag/v1.0.3)
- Stop language server on extension deactivate (#58)
- Add theme colors, export options to DAG preview (#59)
- Rename suppressFutureWarnings -> paranoidWarnings
- Support offline DAG previews (#64)
- Replace webpack with esbuild, remove gradle (#66)

## [1.0.2] - 2024-11-25

- Bump language server to [1.0.2](https://github.com/nextflow-io/language-server/releases/tag/v1.0.2)
- Support links from DAG preview to source files

## [1.0.1] - 2024-11-12

- Bump language server to [1.0.1](https://github.com/nextflow-io/language-server/releases/tag/v1.0.1)

## [1.0.0] - 2024-10-28

- Language server and client

## [0.3.3] - 2024-03-29

- Update publishing automation to also push to the Open VSX Registry.

## [0.3.2] - 2024-03-25

- Updated Nextflow logo

## [0.3.1] - 2022-04-13

## [0.3.0] - 2020-09-17

## [0.2.0] - 2020-02-22

## [0.1.1] - 2018-05-12

## [0.1.0] - 2018-01-30

- Initial release
