import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vm from "node:vm";

import { dashboardHtml, scriptJson } from "../runs/dashboard/html";
import {
  isInside,
  parseCommandTrace,
  readTail,
  readTaskDir,
  sectionOrder
} from "../runs/dashboard/taskFiles";
import { pageWithBackButton } from "../runs/htmlPage";

const fixture = (name: string) =>
  fs.readFileSync(path.join("src/positron/test/fixtures", name), "utf8");

function workDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nf-dashboard-"));
  const work = path.join(root, "work", "ab", "cdef");
  fs.mkdirSync(work, { recursive: true });
  const write = (name: string, text: string) =>
    fs.writeFileSync(path.join(work, name), text);
  write(".command.sh", "#!/usr/bin/env Rscript\nx <- 1\n");
  write(".command.err", "Error: sample has no reads\n");
  write(".command.out", "");
  write(".command.run", "#!/bin/bash\n# wrapper\n");
  write(".command.trace", fixture("command.trace"));
  write(".exitcode", "1\n");
  write(".command.begin", "");
  fs.writeFileSync(path.join(root, "gut_1.fq"), "@read\nACGT\n");
  fs.symlinkSync(path.join(root, "gut_1.fq"), path.join(work, "gut_1.fq"));
  fs.mkdirSync(path.join(work, "fastqc_gut_logs", "deep"), { recursive: true });
  fs.writeFileSync(
    path.join(work, "fastqc_gut_logs", "gut_1_fastqc.html"),
    "<html></html>"
  );
  fs.writeFileSync(
    path.join(work, "fastqc_gut_logs", "deep", "hidden.txt"),
    "x"
  );
  fs.writeFileSync(path.join(work, "counts.csv"), "gene,n\na,1\n");
  return { root, work };
}

test("reads a work directory into labelled files, inputs and outputs", () => {
  const { root, work } = workDir();
  try {
    const dir = readTaskDir(work);
    assert.equal(dir.exists, true);
    assert.deepEqual(
      dir.files.map((f) => [f.name, f.label]),
      [
        [".command.sh", "Script"],
        [".command.out", "Output (stdout)"],
        [".command.err", "Error output (stderr)"],
        [".command.trace", "Resource usage"],
        [".command.run", "Nextflow wrapper"]
      ]
    );
    assert.equal(dir.scriptLanguage, "r");
    assert.equal(dir.exitCode, 1);
    assert.equal(
      dir.files.find((f) => f.name === ".command.err")?.text,
      "Error: sample has no reads\n"
    );
    assert.deepEqual(
      dir.inputs.map((i) => [i.name, i.target]),
      [["gut_1.fq", path.join(root, "gut_1.fq")]]
    );
    // outputs go two levels deep and leave out Nextflow's bookkeeping files
    assert.deepEqual(
      dir.outputs.map((o) => [o.name, o.isDirectory, o.depth]),
      [
        ["counts.csv", false, 0],
        ["fastqc_gut_logs", true, 0],
        [path.join("fastqc_gut_logs", "deep"), true, 1],
        [path.join("fastqc_gut_logs", "gut_1_fastqc.html"), false, 1]
      ]
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("reports a missing work directory", () => {
  const dir = readTaskDir(path.join(os.tmpdir(), "does-not-exist-nf"));
  assert.equal(dir.exists, false);
  assert.deepEqual(dir.files, []);
});

test("keeps only the end of a large log, from a line start", () => {
  const { root, work } = workDir();
  try {
    const file = path.join(work, ".command.log");
    const line = "x".repeat(99) + "\n";
    fs.writeFileSync(file, "first\n" + line.repeat(3000) + "last line\n");
    const tail = readTail(file, 1000);
    assert.equal(tail.truncated, true);
    assert.ok(tail.text.length <= 1000);
    assert.ok(tail.text.startsWith("x"));
    assert.ok(tail.text.endsWith("last line\n"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("parses a .command.trace file", () => {
  const usage = parseCommandTrace(fixture("command.trace"))!;
  assert.equal(usage.realtimeMs, 2510);
  assert.equal(usage.cpuPercent?.toFixed(1), "98.7");
  assert.equal(usage.memPercent?.toFixed(1), "1.2");
  assert.equal(usage.peakRssBytes, 153600 * 1024);
  assert.equal(usage.readCharsBytes, 1048576);
  assert.equal(usage.cpuModel, "Intel(R) Xeon(R) CPU @ 2.20GHz");
  assert.equal(parseCommandTrace("not a trace"), undefined);
});

test("leads with the errors of a failed task", () => {
  assert.deepEqual(sectionOrder(true).slice(0, 2), [
    { name: ".command.err", open: true },
    { name: ".command.out", open: false }
  ]);
  assert.equal(sectionOrder(false)[0].name, ".command.sh");
  assert.equal(sectionOrder(false).at(-1)?.name, ".command.run");
});

test("only opens files inside the allowed directory", () => {
  assert.ok(isInside("/w/ab/cd", "/w/ab/cd/out/x.html"));
  assert.ok(!isInside("/w/ab/cd", "/w/ab/cd/../../etc/passwd"));
  assert.ok(!isInside("/w/ab/cd", "/w/ab/cd2/x"));
  assert.ok(!isInside("/w/ab/cd", "/w/ab/cd"));
});

test("embeds log content safely in the page", () => {
  const data = { kind: "task", text: "</script><script>alert(1)</script>" };
  assert.ok(!scriptJson(data).includes("</script>"));
  assert.deepEqual(JSON.parse(scriptJson(data)), data);
  const html = dashboardHtml(data, "vscode-resource:");
  const nonce = html.match(/'nonce-([^']+)'/)?.[1];
  assert.ok(nonce);
  assert.equal(html.match(new RegExp(`nonce="${nonce}"`, "g"))?.length, 2);
  assert.equal(html.split("</script>").length - 1, 2);
});

/** Run the page's script against a stub DOM and return the rendered HTML. */
function renderPage(data: unknown): string {
  const html = dashboardHtml(data, "vscode-resource:");
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1]
  );
  const root = { innerHTML: "", addEventListener: () => {} };
  const sandbox = {
    acquireVsCodeApi: () => ({ postMessage: () => {} }),
    document: {
      getElementById: (id: string) =>
        id === "data" ? { textContent: scripts[0] } : root
    },
    window: { scrollY: 0, scrollTo: () => {}, addEventListener: () => {} }
  };
  vm.runInNewContext(scripts[1], sandbox);
  return root.innerHTML;
}

test("renders a failed task's dashboard with its errors first", () => {
  const { root, work } = workDir();
  try {
    const html = renderPage({
      kind: "task",
      id: "x",
      runName: "rnaseq-1",
      runDir: "/r",
      task: {
        taskId: 3,
        name: "FASTQC (gut)",
        process: "FASTQC",
        status: "FAILED",
        exit: 1,
        attempt: 1,
        workdir: work,
        cpus: 2,
        memory: 2 * 1024 ** 3,
        nativeId: "job-42"
      },
      dir: readTaskDir(work),
      sections: sectionOrder(true),
      canDebug: true,
      canCancel: false,
      now: Date.now()
    });
    assert.ok(html.indexOf("Error output (stderr)") < html.indexOf("Script"));
    assert.match(html, /<details data-key="file:\.command\.err" open>/);
    assert.match(html, /requested 2, used 99%/);
    assert.match(html, /requested 2\.0 GB, peak 150 MB/);
    assert.match(html, /job-42/);
    assert.match(html, /gut_1_fastqc\.html/);
    assert.match(html, /Debug in Console/);
    assert.doesNotMatch(html, /Cancel Task/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("renders a run's dashboard and escapes what it shows", () => {
  const html = renderPage({
    kind: "run",
    id: "/r",
    run: {
      runName: "rnaseq-1",
      status: "failed",
      script: "/p/main.nf",
      profiles: ["test"],
      liveStatus: true,
      errorMessage: "Process <FASTQC> failed",
      totals: { total: 10, done: 8, failed: 1, running: 0 },
      processes: [
        {
          name: "FASTQC",
          total: 4,
          pending: 0,
          running: 0,
          succeeded: 3,
          cached: 0,
          failed: 1,
          aborted: 0,
          retried: 0
        }
      ]
    },
    failed: [
      { taskId: 3, name: "FASTQC (gut)", exit: 1, stderr: "<b>no reads</b>" }
    ],
    running: [],
    reports: ["report", "trace"],
    duration: "3m 2s"
  });
  assert.match(html, /8 of 10 done, 1 failed/);
  assert.match(html, /3 \/ 4/);
  assert.match(html, /data-task="3"/);
  assert.match(html, /&lt;b&gt;no reads&lt;\/b&gt;/);
  assert.match(html, /Process &lt;FASTQC&gt; failed/);
  assert.match(html, /data-report="report"/);
  assert.doesNotMatch(html, /data-report="dag"/);
});

test("an HTML page gets a way back, without Positron's webview defaults", () => {
  const page =
    '<html><head><title>r</title></head><body><a href="#tasks">Tasks</a>' +
    '<img src="plot.png"><img src="data:image/png;base64,AAA"><script src="https://cdn.example/x.js"></script>' +
    '<link rel="stylesheet" href="style/report.css"><script>const s = "<head></body>";</script>' +
    "<main>report</main></body></html>";
  const html = pageWithBackButton(page, {
    backLabel: 'main <"run">',
    resolve: (relative) => `https://webview/dir/${relative}`
  });
  // the reset comes first in the real head, the button before the last </body>
  assert.ok(
    html.startsWith('<html><head><style id="nextflow-positron-reset">')
  );
  assert.ok(
    html.indexOf("nextflow-positron-back") > html.indexOf("<main>report</main>")
  );
  assert.ok(html.endsWith("</body></html>"));
  assert.match(html, /postMessage\(\{ type: "back" \}\)/);
  assert.ok(html.includes("main &#60;&#34;run&#34;&#62;"));
  // files next to the page load from the webview; links, data and remote URLs stay
  assert.ok(html.includes('src="https://webview/dir/plot.png"'));
  assert.ok(html.includes('href="https://webview/dir/style/report.css"'));
  assert.ok(html.includes('href="#tasks"'));
  assert.ok(html.includes('src="data:image/png;base64,AAA"'));
  assert.ok(html.includes('src="https://cdn.example/x.js"'));
});

test("the DAG draws with the bundled mermaid", () => {
  const dag = fs.readFileSync(
    path.join(__dirname, "../src/positron/test/fixtures/dag.html"),
    "utf8"
  );
  const html = pageWithBackButton(dag, {
    backLabel: "back",
    mermaidSrc: "https://webview/media/mermaid.min.js"
  });
  assert.ok(!html.includes("cdn.jsdelivr.net"));
  assert.match(
    html,
    /<script src="https:\/\/webview\/media\/mermaid\.min\.js"><\/script>\n<script>\s*mermaid\.initialize\(/
  );
  assert.match(html, /<pre class="mermaid"/);
});
