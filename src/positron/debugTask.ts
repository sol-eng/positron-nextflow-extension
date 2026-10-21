// Re-creates a task's environment in the console: the working directory is
// set to the task's work directory, where its inputs are staged, and its
// resolved script (with Nextflow variables substituted) is opened for
// stepping through with the console's own Cmd+Enter.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { PositronApi } from "@posit-dev/positron";

import { chdirCode, shebangLanguage } from "./embeddedBlock";
import { waitForRuntime } from "./runEmbeddedCode";
import type { TaskState } from "./runs/model";
import type { RunNode } from "./runs/tree";

async function debugTask(api: PositronApi, task: TaskState) {
  if (!task.workdir) return;
  const scriptFile = path.join(task.workdir, ".command.sh");
  let script: string;
  try {
    script = await fs.promises.readFile(scriptFile, "utf8");
  } catch {
    vscode.window.showWarningMessage(
      `${task.name} has no script in ${task.workdir}; its work directory may have been cleaned.`
    );
    return;
  }
  const [first] = script.split("\n");
  const language = shebangLanguage(first);
  if (!language) {
    // a shell script: open a terminal where it ran instead
    const terminal = vscode.window.createTerminal({
      name: `Task: ${task.name}`,
      cwd: task.workdir
    });
    terminal.show();
    await vscode.window.showTextDocument(vscode.Uri.file(scriptFile), {
      preview: true
    });
    return;
  }
  if (!(await waitForRuntime(api, language))) {
    vscode.window.showErrorMessage(
      `No ${language === "r" ? "R" : "Python"} interpreter was found to debug ${task.name}.`
    );
    return;
  }
  await api.runtime.executeCode(
    language,
    chdirCode(language, task.workdir),
    true,
    false
  );
  // .command.sh is the final script, so it has no Nextflow escapes to undo;
  // only the shebang is dropped
  const body = script.split("\n").slice(1).join("\n");
  const document = await vscode.workspace.openTextDocument({
    language,
    content: `# ${task.name} (${task.hash ?? ""})\n# Work directory: ${task.workdir}\n\n${body.trim()}\n`
  });
  await vscode.window.showTextDocument(document);
}

export function activateDebugTask(
  context: vscode.ExtensionContext,
  api: PositronApi
) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "nextflow.positron.runs.debugTask",
      (node?: RunNode) => node?.kind === "task" && debugTask(api, node.task)
    )
  );
}
