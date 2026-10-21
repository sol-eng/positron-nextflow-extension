import * as vscode from "vscode";

// The fork contributes the same languages, settings, commands and views as the
// official extension, so the two cannot run side by side: whichever activates
// second fails to register its commands, and both would start a language
// server for the same files. The manifest has no way to declare a conflict, so
// it is enforced here instead.
const UPSTREAM_ID = "nextflow.nextflow";

/**
 * Returns true, and offers to remove the official extension, when it is
 * installed and enabled. The fork should not activate in that case.
 */
export function hasConflictingExtension(): boolean {
  if (!vscode.extensions.getExtension(UPSTREAM_ID)) return false;
  promptToResolveConflict();
  return true;
}

async function promptToResolveConflict() {
  const uninstall = "Uninstall Nextflow";
  const show = "Show Extension";
  const choice = await vscode.window.showWarningMessage(
    "Positron Nextflow replaces the official Nextflow extension and is disabled while both are installed.",
    uninstall,
    show
  );
  if (choice === uninstall) {
    await vscode.commands.executeCommand(
      "workbench.extensions.uninstallExtension",
      UPSTREAM_ID
    );
    const reload = "Reload Window";
    const next = await vscode.window.showInformationMessage(
      "Reload the window to activate Positron Nextflow.",
      reload
    );
    if (next === reload) {
      vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  } else if (choice === show) {
    vscode.commands.executeCommand(
      "workbench.extensions.action.showExtensionsWithIds",
      [UPSTREAM_ID]
    );
  }
}
