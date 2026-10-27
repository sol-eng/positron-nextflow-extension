// Opens a run's HTML reports in Positron's Viewer pane, with a button back
// to the run's dashboard, and its trace in the Data Explorer.

import * as fs from "fs";
import * as vscode from "vscode";
import type { PositronApi } from "@posit-dev/positron";

import type { HtmlViewer } from "./htmlViewer";
import { registerCommand } from "./log";
import { withRun } from "./select";
import type { Run, RunStore } from "./store";

type Report = "report" | "timeline" | "dag";

const TITLES: Record<Report, string> = {
  report: "execution report",
  timeline: "timeline",
  dag: "DAG"
};

export function activateReports(
  context: vscode.ExtensionContext,
  _api: PositronApi,
  store: RunStore,
  viewer: HtmlViewer
) {
  const open = (kind: Report) => (node?: unknown) =>
    withRun(store, node, (run) => openReport(run, kind));
  const openReport = (run: Run, kind: Report) => {
    const file = run.files[kind];
    if (!fs.existsSync(file)) {
      vscode.window.showInformationMessage(
        `The ${TITLES[kind]} of ${run.record.runName} is written when the run finishes.`
      );
      return;
    }
    viewer.show({
      file,
      title: `${TITLES[kind][0].toUpperCase()}${TITLES[kind].slice(1)}: ${run.record.runName}`,
      backLabel: `\u2190 ${run.record.runName}`,
      onBack: () =>
        vscode.commands.executeCommand(
          "nextflow.positron.runs.showRunDashboard",
          { kind: "run", run }
        )
    });
  };
  context.subscriptions.push(
    registerCommand("nextflow.positron.runs.openReport", open("report")),
    registerCommand("nextflow.positron.runs.openTimeline", open("timeline")),
    registerCommand("nextflow.positron.runs.openDag", open("dag")),
    registerCommand("nextflow.positron.runs.openTrace", (node?: unknown) =>
      withRun(store, node, (run) => {
        if (!fs.existsSync(run.files.trace)) {
          vscode.window.showInformationMessage(
            `${run.record.runName} has no trace file yet.`
          );
          return;
        }
        return vscode.commands.executeCommand(
          "nextflow.positron.openInDataExplorer",
          vscode.Uri.file(run.files.trace)
        );
      })
    )
  );
}
