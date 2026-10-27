import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { applyEvent, parseEventChunk } from "../runs/events";
import {
  buildDriverScript,
  buildRunArgs,
  orphanedJobIds,
  pickEventsPlugin,
  resolveDriverMode,
  buildRunConfig,
  isNextflowRun,
  makeRunName,
  mergePlugins,
  parseNextflowVersion,
  parseParams,
  runFiles,
  type LaunchConfig
} from "../runs/launchArgs";
import {
  abortUnfinished,
  emptyProgress,
  summarize,
  totals,
  updateTask
} from "../runs/model";
import { applyTraceFile, parseHistory } from "../runs/trace";

// the test bundle runs from the repository root
const fixture = (name: string) =>
  fs.readFileSync(path.join("src/positron/test/fixtures", name), "utf8");

test("folds a real event stream into a finished run", () => {
  const progress = emptyProgress();
  const { events, rest } = parseEventChunk("", fixture("events.ndjson"));
  assert.equal(rest, "");
  events.forEach((e) => applyEvent(progress, e));

  assert.equal(progress.finished, true);
  assert.equal(progress.success, true);
  assert.equal(progress.workflow?.runName, "exotic_hypatia");
  assert.equal(
    progress.workflow?.sessionId,
    "e13c8468-17f9-45fb-abf9-c9990d6a9278"
  );
  assert.deepEqual(totals(progress), {
    total: 3,
    done: 3,
    failed: 0,
    running: 0
  });
  const square = progress.tasks[2];
  assert.equal(square.process, "square");
  assert.equal(square.status, "COMPLETED");
  assert.equal(square.exit, 0);
  assert.match(square.workdir!, /work\/bb\/b13c1e/);
  assert.ok(square.nativeId);
});

test("keeps a partial line until the rest arrives", () => {
  const line = JSON.stringify({
    event: "task_submitted",
    trace: { task_id: 1 }
  });
  const first = parseEventChunk("", line.slice(0, 10));
  assert.deepEqual(first.events, []);
  const second = parseEventChunk(first.rest, line.slice(10) + "\n");
  assert.equal(second.events.length, 1);
  assert.equal(second.rest, "");
});

test("skips corrupt lines", () => {
  const { events } = parseEventChunk("", '{"event":"started"}\nnot json\n');
  assert.equal(events.length, 1);
});

test("status never moves backwards and running exit codes are ignored", () => {
  const progress = emptyProgress();
  const trace = { task_id: 1, name: "A (1)", exit: 2147483647 };
  applyEvent(progress, {
    event: "task_completed",
    trace: { ...trace, status: "FAILED", exit: 1 }
  });
  applyEvent(progress, { event: "task_started", trace });
  assert.equal(progress.tasks[1].status, "FAILED");
  assert.equal(progress.tasks[1].exit, 1);
  assert.equal(progress.tasks[1].process, "A");

  applyEvent(progress, {
    event: "task_started",
    trace: { task_id: 2, name: "B", exit: 2147483647 }
  });
  assert.equal(progress.tasks[2].exit, undefined);
});

test("counts only the latest attempt and reports retries", () => {
  const progress = emptyProgress();
  updateTask(progress, {
    taskId: 1,
    name: "ALIGN (s1)",
    status: "FAILED",
    attempt: 1
  });
  updateTask(progress, {
    taskId: 2,
    name: "ALIGN (s1)",
    status: "COMPLETED",
    attempt: 2
  });
  updateTask(progress, {
    taskId: 3,
    name: "ALIGN (s2)",
    status: "RUNNING",
    attempt: 1
  });
  updateTask(progress, { taskId: 4, name: "QC (s1)", status: "CACHED" });
  assert.deepEqual(summarize(progress), [
    {
      name: "ALIGN",
      total: 2,
      pending: 0,
      running: 1,
      succeeded: 1,
      cached: 0,
      failed: 0,
      aborted: 0,
      retried: 1
    },
    {
      name: "QC",
      total: 1,
      pending: 0,
      running: 0,
      succeeded: 0,
      cached: 1,
      failed: 0,
      aborted: 0,
      retried: 0
    }
  ]);
});

test("records the error and outcome of a failed run", () => {
  const progress = emptyProgress();
  // Nextflow sends `error` after `completed`; the report explains the failure
  applyEvent(progress, {
    event: "completed",
    workflow: {
      success: false,
      errorMessage: null,
      errorReport: "Process `A` failed"
    }
  });
  applyEvent(progress, {
    event: "error",
    workflow: { success: false, errorMessage: null }
  });
  assert.equal(progress.finished, true);
  assert.equal(progress.success, false);
  assert.equal(progress.errorMessage, "Process `A` failed");
});

test("marks unfinished tasks of an ended run as aborted", () => {
  const progress = emptyProgress();
  updateTask(progress, { taskId: 1, name: "A (1)", status: "RUNNING" });
  updateTask(progress, { taskId: 2, name: "A (2)", status: "COMPLETED" });
  abortUnfinished(progress);
  assert.deepEqual(
    [progress.tasks[1].status, progress.tasks[2].status],
    ["ABORTED", "COMPLETED"]
  );
  assert.equal(summarize(progress)[0].aborted, 1);
});

test("reads completed tasks from a real trace file", () => {
  const progress = emptyProgress();
  applyTraceFile(progress, fixture("trace.txt"));
  assert.deepEqual(totals(progress), {
    total: 3,
    done: 3,
    failed: 0,
    running: 0
  });
  assert.equal(progress.tasks[3].name, "sum_squares");
  assert.equal(progress.tasks[3].nativeId, "50955");
});

test("parses a real history file", () => {
  const [entry] = parseHistory(fixture("history"));
  assert.equal(entry.runName, "exotic_hypatia");
  assert.equal(entry.status, "OK");
  assert.equal(entry.sessionId, "e13c8468-17f9-45fb-abf9-c9990d6a9278");
  assert.match(entry.command, /^nextflow -log/);
});

const config: LaunchConfig = {
  script: "/p/main.nf",
  cwd: "/p",
  profiles: ["test", "docker"],
  params: [["input", "samples sheet.csv"]],
  resumeSessionId: "abc",
  workbench: { cluster: "Kube's" },
  extraArgs: ["-stub"]
};

test("builds the run command line", () => {
  const files = runFiles("/p", "main-1");
  const args = buildRunArgs(config, files, "main-1", [
    "nf-schema@2.5.1",
    "nf-workbench@0.2.0"
  ]);
  assert.deepEqual(args.slice(0, 6), [
    "-log",
    files.log,
    "run",
    "/p/main.nf",
    "-name",
    "main-1"
  ]);
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(after("-profile"), "test,docker");
  assert.equal(after("--input"), "samples sheet.csv");
  assert.equal(after("-resume"), "abc");
  assert.equal(after("-plugins"), "nf-schema@2.5.1,nf-workbench@0.2.0");
  assert.equal(after("-c"), "/p/.nextflow/positron/main-1/positron.config");
  assert.equal(args.at(-1), "-stub");
});

test("builds the run config with escaped Groovy strings", () => {
  const text = buildRunConfig(config, runFiles("/p", "main-1"), true);
  assert.match(
    text,
    /eventsFile = '\/p\/\.nextflow\/positron\/main-1\/events\.ndjson'/
  );
  assert.match(text, /cluster = 'Kube\\'s'/);
  assert.doesNotMatch(
    buildRunConfig(config, runFiles("/p", "x"), false),
    /eventsFile/
  );
});

test("adds the events plugin unless the pipeline declares it", () => {
  assert.deepEqual(mergePlugins(["nf-schema@2.5.1"], "nf-workbench@0.2.0"), [
    "nf-schema@2.5.1",
    "nf-workbench@0.2.0"
  ]);
  assert.deepEqual(mergePlugins(["nf-workbench@0.3.0"], "nf-workbench@0.2.0"), [
    "nf-workbench@0.3.0"
  ]);
});

test("makes run names that Nextflow accepts", () => {
  const name = makeRunName("/p/My Pipeline.nf", new Date(2026, 9, 21, 9, 5, 7));
  assert.equal(name, "my-pipeline-20261021-090507");
  assert.match(makeRunName("/p/1.nf", new Date()), /^run-/);
  assert.match(name, /^[a-z](?:[a-z\d]|[-_](?=[a-z\d])){0,79}$/);
});

test("parses params like the Nextflow command line", () => {
  assert.deepEqual(parseParams('--input "a b.csv" --outdir=res --skip --n 3'), [
    ["input", "a b.csv"],
    ["outdir", "res"],
    ["skip", "true"],
    ["n", "3"]
  ]);
});

test("parses the version and recognises its own process", () => {
  assert.equal(
    parseNextflowVersion("      version 26.10.3 build 14229"),
    "26.10.3"
  );
  assert.ok(
    isNextflowRun(
      "java -cp x nextflow.cli.Launcher run main.nf -name main-1",
      "main-1"
    )
  );
  assert.ok(!isNextflowRun("vim main-1", "main-1"));
});

test("builds a driver script that runs without a HOME, as in a job container", () => {
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "nf-driver-"));
  try {
    const home = path.join(dir, "home dir");
    fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
    // a stand-in for nextflow that records how it was called
    const fake = path.join(dir, "fake nextflow");
    fs.writeFileSync(
      fake,
      '#!/bin/bash\nprintf "%s\\n" "$PWD" "$HOME" "$USER" "$LOGNAME" "$NXF_HOME" "${PATH%%:*}" "$NXF_OPTS" "$@"\n',
      { mode: 0o755 }
    );
    const script = buildDriverScript({
      nextflow: fake,
      args: ["run", "main.nf", "--input", "my samples.csv", "--note", "it's"],
      cwd: dir,
      output: path.join(dir, "output.log"),
      home,
      user: "michael",
      nxfHome: path.join(home, ".nextflow"),
      xmxMb: 3072
    });
    assert.match(script, /^#!\/bin\/bash\n/);
    assert.match(script, /\nexec '/);
    const driver = path.join(dir, "driver.sh");
    fs.writeFileSync(driver, script, { mode: 0o755 });
    // an empty environment: no HOME, USER or PATH, like a job whose uid has no passwd entry
    require("child_process").execFileSync("/usr/bin/env", [
      "-i",
      "/bin/bash",
      driver
    ]);
    const lines = fs
      .readFileSync(path.join(dir, "output.log"), "utf8")
      .trimEnd()
      .split("\n");
    assert.equal(fs.realpathSync(lines[0]), fs.realpathSync(dir));
    assert.deepEqual(lines.slice(1), [
      home,
      "michael",
      "michael",
      path.join(home, ".nextflow"),
      path.join(home, ".local", "bin"),
      "-Xms512m -Xmx3072m",
      "run",
      "main.nf",
      "--input",
      "my samples.csv",
      "--note",
      "it's"
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("chooses where the driver runs", () => {
  assert.deepEqual(resolveDriverMode("auto", true), { mode: "job", ask: true });
  assert.deepEqual(resolveDriverMode("auto", false), {
    mode: "local",
    ask: false
  });
  assert.deepEqual(resolveDriverMode("job", true), { mode: "job", ask: false });
  assert.deepEqual(resolveDriverMode("local", true), {
    mode: "local",
    ask: false
  });
});

test("finds the task jobs a run left behind", () => {
  assert.deepEqual(
    orphanedJobIds([
      { status: "RUNNING", nativeId: "1" },
      { status: "SUBMITTED", nativeId: "2" },
      { status: "COMPLETED", nativeId: "3" },
      { status: "RUNNING" }
    ]),
    ["1", "2"]
  );
});

test("uses the newest installed events plugin unless one is pinned", () => {
  const installed = [
    "nf-workbench-0.1.0",
    "nf-workbench-0.3.0",
    "nf-workbench-0.2.0",
    "nf-schema-2.5.1"
  ];
  assert.equal(
    pickEventsPlugin("nf-workbench", installed),
    "nf-workbench@0.3.0"
  );
  assert.equal(
    pickEventsPlugin("nf-workbench@0.2.0", installed),
    "nf-workbench@0.2.0"
  );
  assert.equal(pickEventsPlugin("nf-workbench@0.4.0", installed), undefined);
  // 0.1.0 writes no events
  assert.equal(
    pickEventsPlugin("nf-workbench", ["nf-workbench-0.1.0"]),
    undefined
  );
  assert.equal(pickEventsPlugin("nf-workbench", []), undefined);
});
