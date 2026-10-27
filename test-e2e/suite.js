// Runs inside Positron's extension host (--extensionTestsPath): drives the
// extension through its commands against test-e2e/pipeline, and writes what
// it saw to $E2E_RESULT. See test-e2e/run.sh.
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
const active = (r) => ["queued", "starting", "running"].includes(r.status);

async function runOf(runName) {
  const runs = await vscode.commands.executeCommand(
    "nextflow.positron.runs.list"
  );
  return runs.find((r) => r.runName === runName);
}

async function waitFor(runName, done, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const run = await runOf(runName);
    if (run && done(run)) return run;
    if (Date.now() > until) return run;
    await sleep(1000);
  }
}

const node = (run) => ({ kind: "run", run: { files: { dir: run.dir } } });

/** Call the stand-in Workbench API directly, e.g. its debug_calls. */
function callFake(method) {
  const http = require("http");
  const body = JSON.stringify({ method, kwparams: {} });
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${process.env.RS_SERVER_ADDRESS}/api/${method}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-RS-Session-Server-RPC-Cookie": process.env.RS_SESSION_RPC_COOKIE
        }
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve(JSON.parse(text).result));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

exports.run = async function () {
  const script = path.join(
    vscode.workspace.workspaceFolders[0].uri.fsPath,
    "main.nf"
  );
  try {
    const ext = vscode.extensions.getExtension("posit.positron-nextflow");
    check("extension found", ext);
    await ext.activate();

    // a run that succeeds, and its reports with a way back
    const started = await vscode.commands.executeCommand(
      "nextflow.positron.runs.launchConfig",
      { script }
    );
    check("launch returned a run", started && started.runName, started);
    const done = await waitFor(started.runName, (r) => !active(r), 180000);
    check("run succeeded", done.status === "succeeded", {
      status: done.status,
      error: done.errorMessage
    });
    for (const id of [
      "openReport",
      "openTimeline",
      "openDag",
      "showRunDashboard"
    ])
      await vscode.commands.executeCommand(
        `nextflow.positron.runs.${id}`,
        node(done)
      );
    check("report, timeline, DAG and dashboard opened", true);

    // Posit Assistant: the skill and the agent commands, the way it reaches them
    const ai = acquirePositronApi().ai;
    const roots =
      typeof ai.getAgentSkillRoots === "function"
        ? await ai.getAgentSkillRoots()
        : [];
    const root = roots.find((r) => r.endsWith("assistant-skills"));
    check(
      "skill root registered",
      root && fs.existsSync(path.join(root, "nextflow-runs", "SKILL.md")),
      roots
    );
    const allowed = await ai.getAgentAllowedCommands();
    const ours = Object.fromEntries(
      allowed
        .filter((c) => c.id.startsWith("nextflow.positron.assistant."))
        .map((c) => [c.id.split(".").pop(), c])
    );
    check(
      "agent commands listed",
      ["listRuns", "runStatus", "launchPipeline", "stopRun"].every(
        (n) => ours[n]
      ),
      Object.keys(ours)
    );
    check(
      "read-only flags",
      ours.listRuns?.readOnly === true &&
        ours.runStatus?.readOnly === true &&
        !ours.launchPipeline?.readOnly &&
        !ours.stopRun?.readOnly
    );
    const launched = await ai.validateAndExecuteCommand(
      "nextflow.positron.assistant.launchPipeline",
      [{ script: "main.nf", params: { fail: true } }]
    );
    const failing = launched.ok && JSON.parse(launched.result);
    check("assistant launches a run", failing && failing.runName, launched);
    await waitFor(failing.runName, (r) => !active(r), 180000);
    const status = await ai.validateAndExecuteCommand(
      "nextflow.positron.assistant.runStatus",
      [failing.runName]
    );
    const parsed = status.ok && JSON.parse(status.result);
    const task = parsed && parsed.failedTasks && parsed.failedTasks[0];
    check(
      "assistant sees why it failed",
      parsed.status === "failed" &&
        task &&
        (task.stderr || "").includes("reference genome not found"),
      parsed && {
        status: parsed.status,
        failedTasks: parsed.failedTasks,
        error: parsed.errorMessage
      }
    );
    check(
      "result fits the assistant",
      status.result.length < 32000,
      status.result.length
    );
    const listed = await ai.validateAndExecuteCommand(
      "nextflow.positron.assistant.listRuns",
      []
    );
    check(
      "assistant lists runs",
      listed.ok &&
        JSON.parse(listed.result).some((r) => r.runName === failing.runName)
    );

    // the Nextflow driver as a Workbench job, against test-e2e/fake_workbench.py
    // (which runs it as a local process): submitted, followed and stopped
    // through the Workbench API
    const config = vscode.workspace.getConfiguration("nextflow.run");
    await config.update("driver", "job", vscode.ConfigurationTarget.Global);
    await sleep(500);
    const headless = await vscode.commands.executeCommand(
      "nextflow.positron.runs.launchConfig",
      { script }
    );
    check(
      "a headless run is submitted as a Workbench job",
      headless && headless.driverJobId,
      headless
    );
    const headlessDone = await waitFor(
      headless.runName,
      (r) => !active(r),
      240000
    );
    check("the headless run succeeds", headlessDone.status === "succeeded", {
      status: headlessDone.status,
      error: headlessDone.errorMessage
    });
    const slow = await vscode.commands.executeCommand(
      "nextflow.positron.runs.launchConfig",
      { script, params: [["sleep", "120"]] }
    );
    await waitFor(slow.runName, (r) => r.status === "running", 120000);
    await vscode.commands.executeCommand(
      "nextflow.positron.runs.stop",
      node(slow)
    );
    const stoppedRun = await waitFor(slow.runName, (r) => !active(r), 120000);
    const calls = await callFake("debug_calls");
    const launches = calls
      .filter((c) => c.method === "launch_job")
      .map((c) => c.kwparams.job);
    const stops = calls
      .filter((c) => c.method === "stop_job")
      .map((c) => c.kwparams);
    check(
      "driver jobs are launched with their spec",
      launches.length === 2 &&
        launches.every(
          (j) =>
            j.name.startsWith("nf-driver-") &&
            j.exe === "/bin/bash" &&
            j.args[0].endsWith("/driver.sh") &&
            j.cluster === "Local"
        ),
      launches
    );
    check(
      "a stopped headless run is stopped gracefully",
      stoppedRun.status === "stopped" &&
        stops.some(
          (s) => s.job_id === slow.driverJobId && s.force_quit === false
        ),
      { status: stoppedRun.status, stops }
    );
    check(
      "job status comes from the Workbench API",
      calls.some((c) => c.method === "get_session")
    );
    await config.update("driver", undefined, vscode.ConfigurationTarget.Global);
  } catch (e) {
    check("no exception", false, String((e && e.stack) || e));
  }
  fs.writeFileSync(process.env.E2E_RESULT, JSON.stringify(results, null, 2));
};
