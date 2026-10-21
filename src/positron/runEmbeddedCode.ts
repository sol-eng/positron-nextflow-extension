import * as vscode from "vscode";
import type { PositronApi } from "@posit-dev/positron";

import {
  blockBody,
  findEmbeddedBlock,
  toRunnableCode,
  type EmbeddedBlock
} from "./embeddedBlock";

let warnedAboutInterpolation = false;

function documentLines(document: vscode.TextDocument): string[] {
  return document.getText().split(/\r?\n/);
}

function blockAtCursor(
  editor: vscode.TextEditor
): [string[], EmbeddedBlock] | undefined {
  const lines = documentLines(editor.document);
  const block = findEmbeddedBlock(lines, editor.selection.active.line);
  if (!block) {
    vscode.window.showInformationMessage(
      "Place the cursor inside an R or Python process script to run it in the console."
    );
    return undefined;
  }
  return [lines, block];
}

async function execute(
  api: PositronApi,
  block: EmbeddedBlock,
  text: string,
  document: vscode.TextDocument
) {
  const { code, hasInterpolation } = toRunnableCode(text);
  if (!code) return;
  if (hasInterpolation && !warnedAboutInterpolation) {
    warnedAboutInterpolation = true;
    vscode.window.showWarningMessage(
      "This script uses Nextflow variables (e.g. `${x}`), which are sent to the console as written, not substituted."
    );
  }
  if (!(await waitForRuntime(api, block.languageId))) {
    const name = block.languageId === "r" ? "R" : "Python";
    vscode.window.showErrorMessage(
      `No ${name} interpreter was found to run this script in the console.`
    );
    return;
  }
  try {
    await api.runtime.executeCode(
      block.languageId,
      code,
      false,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      document.uri
    );
  } catch (e) {
    // errors raised by the code itself are already shown in the console
    console.log("Nextflow: console execution failed:", e);
  }
}

/**
 * Right after startup Positron may still be discovering interpreters, and
 * executeCode fails until one is registered for the language.
 */
async function waitForRuntime(
  api: PositronApi,
  languageId: string,
  timeoutMs = 30000
): Promise<boolean> {
  const registered = await api.runtime.getRegisteredRuntimes();
  if (registered.some((r) => r.languageId === languageId)) return true;
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Window,
      title: "Waiting for interpreters to be discovered..."
    },
    () =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => done(false), timeoutMs);
        const listener = api.runtime.onDidRegisterRuntime((r) => {
          if (r.languageId === languageId) done(true);
        });
        function done(found: boolean) {
          clearTimeout(timer);
          listener.dispose();
          resolve(found);
        }
      })
  );
}

/** Run the selection, or the current line and move to the next one. */
async function runSelection(api: PositronApi) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const found = blockAtCursor(editor);
  if (!found) return;
  const [lines, block] = found;
  const { selection, document } = editor;

  if (!selection.isEmpty) {
    await execute(api, block, document.getText(selection), document);
    return;
  }

  const line = selection.active.line;
  if (line > block.openLine && line < block.closeLine) {
    await execute(api, block, lines[line], document);
  }
  let next = line + 1;
  while (next < block.closeLine - 1 && lines[next].trim() === "") next++;
  if (next < block.closeLine) {
    const position = new vscode.Position(next, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));
  }
}

/** Run the whole script block around the cursor. */
async function runBlock(api: PositronApi) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const found = blockAtCursor(editor);
  if (!found) return;
  const [lines, block] = found;
  await execute(api, block, blockBody(lines, block), editor.document);
}

export function activateRunEmbeddedCode(
  context: vscode.ExtensionContext,
  api: PositronApi
) {
  context.subscriptions.push(
    vscode.commands.registerCommand("nextflow.positron.runSelection", () =>
      runSelection(api)
    ),
    vscode.commands.registerCommand("nextflow.positron.runBlock", () =>
      runBlock(api)
    )
  );
}
