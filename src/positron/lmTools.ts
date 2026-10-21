// Tools that let Positron Assistant list, inspect, launch and stop pipeline
// runs, on top of the run manager in ./runs.

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import {
  describeRun,
  launchConfig,
  stopRun,
  type LaunchInput,
  type Run,
  type RunStore
} from "./runs";
import { isTerminal } from "./runs/model";
import { isActive } from "./runs/store";

const STDERR_LINES = 30;

type RunNameInput = { runName?: string };
type LaunchToolInput = {
  script: string;
  profiles?: string[];
  params?: Record<string, string | number | boolean>;
  resumeRunName?: string;
};

function json(value: unknown) {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(value, null, 2))
  ]);
}

function findRun(store: RunStore, runName?: string): Run | undefined {
  const runs = store.all();
  return runName ? runs.find((r) => r.record.runName === runName) : runs[0];
}

async function tail(file: string, lines: number): Promise<string | undefined> {
  const text = await fs.promises.readFile(file, "utf8").catch(() => undefined);
  return text?.trimEnd().split("\n").slice(-lines).join("\n") || undefined;
}

async function runStatus(run: Run) {
  const { tasks, ...summary } = describeRun(run);
  const failed = tasks.filter((t) => t.status === "FAILED");
  return {
    ...summary,
    failedTasks: await Promise.all(
      failed.map(async (t) => ({
        name: t.name,
        exit: t.exit,
        attempt: t.attempt,
        workdir: t.workdir,
        stderr: t.workdir
          ? await tail(path.join(t.workdir, ".command.err"), STDERR_LINES)
          : undefined
      }))
    ),
    runningTasks: tasks
      .filter((t) => !isTerminal(t.status))
      .map((t) => ({ name: t.name, status: t.status, jobId: t.nativeId }))
  };
}

export function activateLmTools(
  context: vscode.ExtensionContext,
  store: RunStore
) {
  if (!vscode.lm?.registerTool) return;
  context.subscriptions.push(
    vscode.lm.registerTool<Record<string, never>>("nextflow_listRuns", {
      invoke: async () => {
        await store.ready;
        return json(
          store.all().map((run) => {
            const {
              runName,
              status,
              script,
              profiles,
              startedAt,
              finishedAt,
              totals
            } = describeRun(run);
            return {
              runName,
              status,
              script,
              profiles,
              startedAt,
              finishedAt,
              totals
            };
          })
        );
      }
    }),
    vscode.lm.registerTool<RunNameInput>("nextflow_runStatus", {
      invoke: async ({ input }) => {
        await store.ready;
        const run = findRun(store, input.runName);
        if (!run)
          return json({
            error: `No pipeline run ${input.runName ?? ""} was found.`
          });
        return json(await runStatus(run));
      }
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
      invoke: async ({ input }) => {
        await store.ready;
        const script = path.isAbsolute(input.script)
          ? input.script
          : path.join(
              vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
              input.script
            );
        if (!fs.existsSync(script))
          return json({ error: `${script} does not exist.` });
        const launch: LaunchInput = {
          script,
          profiles: input.profiles ?? [],
          params: Object.entries(input.params ?? {}).map(([k, v]) => [
            k,
            String(v)
          ])
        };
        if (input.resumeRunName) {
          const previous = findRun(store, input.resumeRunName);
          launch.resumeSessionId = previous?.progress.workflow?.sessionId;
          if (!launch.resumeSessionId)
            return json({
              error: `Cannot resume ${input.resumeRunName}: its session is unknown.`
            });
        }
        const started = await launchConfig(context, store, launch);
        if (!started)
          return json({
            error:
              "The pipeline could not be started; see the notification for details."
          });
        const { tasks: _tasks, processes: _processes, ...summary } = started;
        return json({
          ...summary,
          hint: "Use nextflow_runStatus with this runName to follow the run."
        });
      }
    }),
    vscode.lm.registerTool<RunNameInput>("nextflow_stopRun", {
      prepareInvocation: ({ input }) => ({
        invocationMessage: `Stopping ${input.runName ?? "the pipeline run"}`,
        confirmationMessages: {
          title: "Stop Nextflow run?",
          message: `Stop ${input.runName ?? "the latest pipeline run"}? Nextflow cancels its running tasks.`
        }
      }),
      invoke: async ({ input }) => {
        await store.ready;
        const run = findRun(store, input.runName);
        if (!run)
          return json({
            error: `No pipeline run ${input.runName ?? ""} was found.`
          });
        if (!isActive(run))
          return json({
            error: `${run.record.runName} is not running (${run.status}).`
          });
        stopRun(store, run);
        return json({ runName: run.record.runName, stopping: true });
      }
    })
  );
}
