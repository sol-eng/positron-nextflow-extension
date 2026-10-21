// Opens a run's HTML reports in Positron's Viewer pane, and its trace in the
// Data Explorer.

import * as fs from "fs";
import * as vscode from "vscode";
import type { PositronApi } from "@posit-dev/positron";

import type { RunStore } from "./store";
import type { RunNode } from "./tree";

type Report = "report" | "timeline" | "dag";

const TITLES: Record<Report, string> = {
  report: "execution report",
  timeline: "timeline",
  dag: "DAG"
};

export function activateReports(
  context: vscode.ExtensionContext,
  api: PositronApi,
  store: RunStore
) {
  const open = (kind: Report) => (node?: RunNode) => {
    const run = node && store.get(node.run.files.dir);
    if (!run) return;
    const file = run.files[kind];
    if (!fs.existsSync(file)) {
      vscode.window.showInformationMessage(
        `The ${TITLES[kind]} of ${run.record.runName} is written when the run finishes.`
      );
      return;
    }
    api.window.previewHtml(file);
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "nextflow.positron.runs.openReport",
      open("report")
    ),
    vscode.commands.registerCommand(
      "nextflow.positron.runs.openTimeline",
      open("timeline")
    ),
    vscode.commands.registerCommand(
      "nextflow.positron.runs.openDag",
      open("dag")
    ),
    vscode.commands.registerCommand(
      "nextflow.positron.runs.openTrace",
      (node?: RunNode) => {
        const run = node && store.get(node.run.files.dir);
        if (!run || !fs.existsSync(run.files.trace)) return;
        vscode.commands.executeCommand(
          "nextflow.positron.openInDataExplorer",
          vscode.Uri.file(run.files.trace)
        );
      }
    )
  );
}
