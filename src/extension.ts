import * as vscode from "vscode";

import { activateLanguageServer, stopLanguageServer } from "./languageServer";
import { activateTelemetry, deactivateTelemetry } from "./telemetry";
import { activateWebview } from "./webview";
import { activateAuth, AuthProvider } from "./auth";
import { activateNextflowLog } from "./nextflowLog";
// Positron:
import {
  activatePositron,
  hasConflictingExtension,
  isPositron
} from "./positron";

export function activate(context: vscode.ExtensionContext) {
  // Positron: stand down while the official extension is also installed
  if (hasConflictingExtension()) return;
  const trackEvent = activateTelemetry(context);
  const authProvider = new AuthProvider(context);
  activateAuth(context, authProvider);
  activateLanguageServer(context, trackEvent);
  activateWebview(context, authProvider);
  activateNextflowLog(context);
  // Positron:
  if (isPositron()) activatePositron(context);
}

export function deactivate(
  context: vscode.ExtensionContext
): Promise<[void, void]> {
  return Promise.all([deactivateTelemetry(context), stopLanguageServer()]);
}
