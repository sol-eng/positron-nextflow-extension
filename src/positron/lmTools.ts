// Lets AI assistants list, inspect, launch and stop pipeline runs, on top of
// the run manager in ./runs, in two ways:
//
// - Posit Assistant (Positron 2026.07 on) does not use VS Code's language
//   model tools. It runs IDE commands with its `positronCommand` tool, and
//   learns which from skills. The `nextflow.positron.assistant.*` commands
//   (declared with `agent` metadata in package.json) return the results as
//   JSON, and the skill in assistant-skills/ tells it when to use them.
// - Other assistants (e.g. Copilot) use the `nextflow_*` language model tools.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import type { PositronApi } from "@posit-dev/positron";

import {
  describeRun,
  launchConfig,
  stopRun,
  type LaunchInput,
  type Run,
  type RunStore
} from "./runs";
import { readTail } from "./runs/dashboard/taskFiles";
import { registerCommand } from "./runs/log";
import { isTerminal } from "./runs/model";
import { isActive } from "./runs/store";

const STDERR_LINES = 30;
/** Failed tasks described in full; enough to explain a run, and well below
 * the size Posit Assistant accepts from a command (32k characters). */
const MAX_FAILED_TASKS = 10;
const MAX_RUNNING_TASKS = 50;
const MAX_MESSAGE = 4000;

type RunNameInput = { runName?: string };
export type LaunchToolInput = {
  script: string;
  profiles?: string[];
  params?: Record<string, string | number | boolean>;
  resumeRunName?: string;
};

function findRun(store: RunStore, runName?: string): Run | undefined {
  const runs = store.all();
  return runName ? runs.find((r) => r.record.runName === runName) : runs[0];
}

function tail(file: string, lines: number): string | undefined {
  try {
    const { text } = readTail(file, 16 * 1024);
    return text.trimEnd().split("\n").slice(-lines).join("\n") || undefined;
  } catch {
    return undefined;
  }
}

function clip(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  return text.length > MAX_MESSAGE
    ? `${text.slice(0, MAX_MESSAGE)}\n[... ${text.length - MAX_MESSAGE} more characters]`
    : text;
}

export async function listRunsResult(store: RunStore) {
  await store.ready;
  return store.all().map((run) => {
    const { runName, status, script, profiles, startedAt, finishedAt, totals } =
      describeRun(run);
    return {
      runName,
      status,
      script,
      profiles,
      startedAt,
      finishedAt,
      totals
    };
  });
}

export async function runStatusResult(store: RunStore, runName?: string) {
  await store.ready;
  const run = findRun(store, runName);
  if (!run) return { error: `No pipeline run ${runName ?? ""} was found.` };
  const { tasks, ...summary } = describeRun(run);
  const failed = tasks.filter((t) => t.status === "FAILED");
  const running = tasks.filter((t) => !isTerminal(t.status));
  return {
    ...summary,
    errorMessage: clip(summary.errorMessage),
    failedTasks: failed.slice(0, MAX_FAILED_TASKS).map((t) => ({
      name: t.name,
      exit: t.exit,
      attempt: t.attempt,
      workdir: t.workdir,
      stderr: t.workdir
        ? tail(path.join(t.workdir, ".command.err"), STDERR_LINES)
        : undefined
    })),
    failedTasksNotShown: Math.max(0, failed.length - MAX_FAILED_TASKS),
    runningTasks: running
      .slice(0, MAX_RUNNING_TASKS)
      .map((t) => ({ name: t.name, status: t.status, jobId: t.nativeId })),
    runningTasksNotShown: Math.max(0, running.length - MAX_RUNNING_TASKS)
  };
}

export async function launchResult(
  context: vscode.ExtensionContext,
  store: RunStore,
  input: LaunchToolInput,
  followWith: string
) {
  await store.ready;
  if (typeof input?.script !== "string")
    return { error: "Give the pipeline's entry script as `script`." };
  const script = path.isAbsolute(input.script)
    ? input.script
    : path.join(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
        input.script
      );
  if (!fs.existsSync(script)) return { error: `${script} does not exist.` };
  const launch: LaunchInput = {
    script,
    profiles: input.profiles ?? [],
    params: Object.entries(input.params ?? {}).map(([k, v]) => [k, String(v)])
  };
  if (input.resumeRunName) {
    const previous = findRun(store, input.resumeRunName);
    launch.resumeSessionId = previous?.progress.workflow?.sessionId;
    if (!launch.resumeSessionId)
      return {
        error: `Cannot resume ${input.resumeRunName}: its session is unknown.`
      };
  }
  const started = await launchConfig(context, store, launch);
  if (!started)
    return {
      error:
        "The pipeline could not be started; see the notification for details."
    };
  const { tasks: _tasks, processes: _processes, ...summary } = started;
  return {
    ...summary,
    hint: `${followWith} with this runName to follow the run.`
  };
}

export async function stopResult(store: RunStore, runName?: string) {
  await store.ready;
  const run = findRun(store, runName);
  if (!run) return { error: `No pipeline run ${runName ?? ""} was found.` };
  if (!isActive(run))
    return { error: `${run.record.runName} is not running (${run.status}).` };
  await stopRun(store, run);
  return { runName: run.record.runName, stopping: true };
}

/** A run name, also from `{ runName }` as an agent may pass it. */
function stringArg(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  const name = (value as RunNameInput | undefined)?.runName;
  return typeof name === "string" && name ? name : undefined;
}

/** Commands for Posit Assistant's `positronCommand` tool; see the skill. */
function registerAssistantCommands(
  context: vscode.ExtensionContext,
  store: RunStore
): vscode.Disposable[] {
  const json = (value: unknown) => JSON.stringify(value, null, 1);
  const follow = "Run nextflow.positron.assistant.runStatus";
  return [
    registerCommand("nextflow.positron.assistant.listRuns", async () =>
      json(await listRunsResult(store))
    ),
    registerCommand(
      "nextflow.positron.assistant.runStatus",
      async (runName?: unknown) =>
        json(await runStatusResult(store, stringArg(runName)))
    ),
    registerCommand(
      "nextflow.positron.assistant.launchPipeline",
      async (input?: unknown) =>
        json(
          await launchResult(context, store, input as LaunchToolInput, follow)
        )
    ),
    registerCommand(
      "nextflow.positron.assistant.stopRun",
      async (runName?: unknown) =>
        json(await stopResult(store, stringArg(runName)))
    )
  ];
}

function textResult(value: unknown) {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(value, null, 2))
  ]);
}

function registerLanguageModelTools(
  context: vscode.ExtensionContext,
  store: RunStore
): vscode.Disposable[] {
  if (!vscode.lm?.registerTool) return [];
  return [
    vscode.lm.registerTool<Record<string, never>>("nextflow_listRuns", {
      invoke: async () => textResult(await listRunsResult(store))
    }),
    vscode.lm.registerTool<RunNameInput>("nextflow_runStatus", {
      invoke: async ({ input }) =>
        textResult(await runStatusResult(store, input.runName))
    }),
    vscode.lm.registerTool<LaunchToolInput>("nextflow_launchPipeline", {
      prepareInvocation: ({ input }) => {
        const params = Object.entries(input.params ?? {})
          .map(([k, v]) => `--${k} ${v}`)
          .join(" ");
        return {
          invocationMessage: `Launching ${path.basename(input.script)}`,
          confirmationMessages: {
            title: "Run Nextflow pipeline?",
            message: new vscode.MarkdownString(
              `Run \`${input.script}\`` +
                (input.profiles?.length
                  ? ` with profiles \`${input.profiles.join(",")}\``
                  : "") +
                (params ? ` and parameters \`${params}\`` : "") +
                (input.resumeRunName
                  ? `, resuming \`${input.resumeRunName}\``
                  : "") +
                "?"
            )
          }
        };
      },
      invoke: async ({ input }) =>
        textResult(
          await launchResult(context, store, input, "Use nextflow_runStatus")
        )
    }),
    vscode.lm.registerTool<RunNameInput>("nextflow_stopRun", {
      prepareInvocation: ({ input }) => ({
        invocationMessage: `Stopping ${input.runName ?? "the pipeline run"}`,
        confirmationMessages: {
          title: "Stop Nextflow run?",
          message: `Stop ${input.runName ?? "the latest pipeline run"}? Nextflow cancels its running tasks.`
        }
      }),
      invoke: async ({ input }) =>
        textResult(await stopResult(store, input.runName))
    })
  ];
}

/**
 * Make the bundled skills known to Posit Assistant. Positron added
 * `ai.registerAgentSkillRoot` in 2026.07, after the @posit-dev/positron
 * types this builds against, hence the guard.
 */
function registerSkills(
  context: vscode.ExtensionContext,
  api: PositronApi
): vscode.Disposable[] {
  const ai = (api as { ai?: { registerAgentSkillRoot?: unknown } }).ai;
  if (typeof ai?.registerAgentSkillRoot !== "function") return [];
  const root = path.join(context.extensionPath, "assistant-skills");
  return [
    (ai.registerAgentSkillRoot as (root: string) => vscode.Disposable)(root)
  ];
}

export function activateLmTools(
  context: vscode.ExtensionContext,
  api: PositronApi,
  store: RunStore
) {
  context.subscriptions.push(
    ...registerAssistantCommands(context, store),
    ...registerLanguageModelTools(context, store),
    ...registerSkills(context, api)
  );
}
