// Shows the DAG preview in Positron's Viewer pane instead of an editor tab.

import * as vscode from "vscode";

import { buildDagPreview } from "../languageServer/utils/buildDagPreview";
import { tryAcquirePositronApi } from "./index";

// Clicking a process in the DAG follows a `command:` link to its source. The
// Viewer's webview cannot run command links, so they are posted back instead.
const CLICK_BRIDGE = `
  const vscodeApi = acquireVsCodeApi();
  document.addEventListener("click", (event) => {
    const link = event.target.closest && event.target.closest("a");
    const href = link && (link.getAttribute("href") || link.getAttribute("xlink:href"));
    if (href && href.startsWith("command:")) {
      event.preventDefault();
      event.stopPropagation();
      vscodeApi.postMessage({ type: "command", href });
    }
  }, true);
`;

// the only command the DAG links to
const ALLOWED_COMMAND = "nextflow.openFileFromWebview";

/** Returns false when not running in Positron, so the caller falls back. */
export function previewDagInViewer(
  context: vscode.ExtensionContext,
  content: string,
  name: string
): boolean {
  const api = tryAcquirePositronApi();
  if (!api) return false;
  const mediaPath = vscode.Uri.joinPath(context.extensionUri, "media");
  const panel = api.window.createPreviewPanel(
    "nextflow.dagPreview",
    `DAG: ${name}`,
    true,
    { enableScripts: true, localResourceRoots: [mediaPath] }
  );
  const mermaidLibUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(mediaPath, "mermaid.min.js")
  );
  const html = buildDagPreview(
    content,
    name,
    mermaidLibUri,
    panel.webview.cspSource
  );
  // reuse the page's script nonce, which its CSP allows
  const nonce = html.match(/nonce="([^"]+)"/)?.[1];
  panel.webview.html = html.replace(
    "</body>",
    `<script nonce="${nonce}">${CLICK_BRIDGE}</script></body>`
  );
  panel.webview.onDidReceiveMessage((message) => {
    if (message?.type !== "command" || typeof message.href !== "string") return;
    const [, id, query] = message.href.match(/^command:([^?]+)\??(.*)$/) ?? [];
    if (id !== ALLOWED_COMMAND) return;
    let args: unknown[] = [];
    try {
      args = query ? JSON.parse(decodeURIComponent(query)) : [];
    } catch {
      return;
    }
    vscode.commands.executeCommand(id, ...args);
  });
  return true;
}
