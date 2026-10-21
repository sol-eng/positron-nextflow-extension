import * as vscode from "vscode";

import { SEQERA_PLATFORM_URL } from "../shared/constants";

const TOKENS_URL = `${SEQERA_PLATFORM_URL}/tokens`;

/**
 * The browser login hands the token back through a redirect that Seqera's
 * server addresses to VS Code, so it does not reach Positron. Offer a
 * personal access token instead, keeping the browser flow as a fallback.
 * Resolves to a token, or to undefined to use the browser flow.
 */
export async function promptForAccessToken(): Promise<string | undefined> {
  const useToken = "Use an access token";
  const useBrowser = "Sign in with the browser";
  const method = await vscode.window.showQuickPick(
    [
      {
        label: useToken,
        detail: `Paste a personal access token created at ${TOKENS_URL}`
      },
      {
        label: useBrowser,
        detail: "May return to VS Code instead of Positron"
      }
    ],
    { title: "Sign in to Seqera Cloud", ignoreFocusOut: true }
  );
  if (!method) throw "User Cancelled";
  if (method.label === useBrowser) return undefined;

  return new Promise<string>((resolve, reject) => {
    const input = vscode.window.createInputBox();
    const openTokens = {
      iconPath: new vscode.ThemeIcon("link-external"),
      tooltip: "Create a token in Seqera Cloud"
    };
    input.title = "Sign in to Seqera Cloud";
    input.prompt = `Paste a personal access token. Create one at ${TOKENS_URL}`;
    input.password = true;
    input.ignoreFocusOut = true;
    input.buttons = [openTokens];
    let accepted = false;
    input.onDidTriggerButton(() =>
      vscode.env.openExternal(vscode.Uri.parse(TOKENS_URL))
    );
    input.onDidAccept(() => {
      const token = input.value.trim();
      if (!token) return;
      accepted = true;
      resolve(token);
      input.dispose();
    });
    input.onDidHide(() => {
      if (!accepted) reject("User Cancelled");
      input.dispose();
    });
    input.show();
  });
}
