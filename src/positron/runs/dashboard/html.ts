// The dashboard page shown in the Viewer. One page renders either a task or
// a run from JSON data, and re-renders in place when the extension posts an
// update. Everything is rendered client-side and escaped there.

import { randomUUID } from "crypto";

/**
 * JSON that is safe inside a <script type="application/json"> element: only a
 * `</script>` in the data could end it early, so `<` is escaped.
 */
export function scriptJson(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export function dashboardHtml(data: unknown, cspSource: string): string {
  const nonce = randomUUID();
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src ${cspSource} 'unsafe-inline'`,
    "img-src data:"
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${STYLE}</style>
</head>
<body>
<main id="root"></main>
<script nonce="${nonce}" id="data" type="application/json">${scriptJson(data)}</script>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}

const STYLE = `
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 0 12px 24px;
    line-height: 1.4;
  }
  h1 { font-size: 1.3em; margin: 14px 0 2px; word-break: break-word; }
  h2 { font-size: 1.05em; margin: 18px 0 6px; }
  .sub { color: var(--vscode-descriptionForeground); margin-bottom: 10px; word-break: break-all; }
  .badge {
    display: inline-block; padding: 1px 8px; border-radius: 9px; font-size: 0.85em;
    color: var(--vscode-editor-background); font-weight: 600; vertical-align: middle;
  }
  .ok { background: var(--vscode-testing-iconPassed, #3fb950); }
  .bad { background: var(--vscode-testing-iconFailed, #f85149); }
  .run { background: var(--vscode-charts-blue, #388bfd); }
  .wait { background: var(--vscode-charts-yellow, #d29922); }
  .off { background: var(--vscode-disabledForeground, #8b949e); }
  .facts { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 8px 0; }
  .facts dt { color: var(--vscode-descriptionForeground); }
  .facts dd { margin: 0; word-break: break-all; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
  button, .link {
    border: none; padding: 4px 10px; cursor: pointer; font: inherit;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  a, .linkish { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  a:hover, .linkish:hover { text-decoration: underline; }
  details { border: 1px solid var(--vscode-panel-border, #8884); margin: 8px 0; }
  summary { padding: 6px 8px; cursor: pointer; display: flex; gap: 8px; align-items: baseline; }
  summary .title { font-weight: 600; }
  summary .meta { color: var(--vscode-descriptionForeground); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  summary .open { margin-left: auto; }
  pre {
    margin: 0; padding: 8px; overflow: auto; max-height: 420px;
    font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size);
    background: var(--vscode-textCodeBlock-background); white-space: pre-wrap; word-break: break-all;
  }
  .note { color: var(--vscode-descriptionForeground); padding: 4px 8px; font-style: italic; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid var(--vscode-panel-border, #8883); vertical-align: top; }
  th { color: var(--vscode-descriptionForeground); font-weight: normal; }
  td.num { text-align: right; white-space: nowrap; }
  .bar { height: 6px; background: var(--vscode-progressBar-background, #388bfd33); opacity: 0.25; position: relative; min-width: 80px; }
  .bar span { position: absolute; top: 0; bottom: 0; left: 0; }
  .fail-item { margin: 8px 0; }
  .empty { color: var(--vscode-descriptionForeground); }
`;

// Runs in the webview. Kept as plain JavaScript in a string.
const SCRIPT = String.raw`
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("root");
  let data = JSON.parse(document.getElementById("data").textContent);
  const opened = new Map();

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const post = (message) => vscode.postMessage(message);
  const bytes = (n) => {
    if (n === undefined || n === null) return undefined;
    const units = ["B", "KB", "MB", "GB", "TB"];
    let v = n, u = 0;
    while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
    return (v < 10 && u > 0 ? v.toFixed(1) : Math.round(v)) + " " + units[u];
  };
  const duration = (ms) => {
    if (ms === undefined || ms === null) return undefined;
    const s = Math.round(ms / 1000);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    return m < 60 ? m + "m " + (s % 60) + "s" : Math.floor(m / 60) + "h " + (m % 60) + "m";
  };
  const badgeClass = (status) => ({
    COMPLETED: "ok", CACHED: "ok", succeeded: "ok",
    FAILED: "bad", ABORTED: "off", failed: "bad", stopped: "off", lost: "off",
    RUNNING: "run", running: "run", starting: "wait", SUBMITTED: "wait", NEW: "wait"
  }[status] || "off");
  const badge = (status) => '<span class="badge ' + badgeClass(status) + '">' + esc(String(status).toLowerCase()) + "</span>";
  const facts = (rows) => '<dl class="facts">' + rows.filter((r) => r[1] !== undefined && r[1] !== null && r[1] !== "")
    .map((r) => "<dt>" + esc(r[0]) + "</dt><dd>" + (r[2] ? r[1] : esc(r[1])) + "</dd>").join("") + "</dl>";

  function renderTask(d) {
    const t = d.task, dir = d.dir;
    const failed = t.status === "FAILED" || t.status === "ABORTED";
    const usage = dir.usage || {};
    const actions = [
      d.runDir ? '<button data-msg="run">← ' + esc(d.runName) + "</button>" : "",
      d.canDebug ? '<button class="primary" data-msg="debug">Debug in Console</button>' : "",
      d.canCancel ? '<button data-msg="cancel">Cancel Task</button>' : "",
      dir.exists ? '<button data-msg="terminal">Terminal in Work Dir</button>' : "",
      t.workdir ? '<button data-msg="copy">Copy Work Dir Path</button>' : ""
    ].join("");
    let html = "<h1>" + esc(t.name) + " " + badge(t.status) + "</h1>" +
      '<div class="sub">' + esc(t.process) + (t.hash ? " · " + esc(t.hash) : "") + "</div>" +
      '<div class="actions">' + actions + "</div>" +
      facts([
        ["Exit code", t.exit ?? dir.exitCode],
        ["Attempt", t.attempt > 1 ? t.attempt : undefined],
        ["Duration", duration(t.start ? (t.complete || d.now) - t.start : undefined)],
        ["Job", t.nativeId],
        ["CPUs", [t.cpus && "requested " + t.cpus, usage.cpuPercent !== undefined && "used " + usage.cpuPercent.toFixed(0) + "%"].filter(Boolean).join(", ")],
        ["Memory", [t.memory && "requested " + bytes(t.memory), usage.peakRssBytes !== undefined && "peak " + bytes(usage.peakRssBytes)].filter(Boolean).join(", ")],
        ["I/O", usage.readCharsBytes !== undefined ? "read " + bytes(usage.readCharsBytes) + ", written " + bytes(usage.writeCharsBytes) : undefined],
        ["Work dir", t.workdir]
      ]);
    if (!dir.exists) {
      return html + '<p class="empty">The work directory ' + (t.workdir ? "does not exist; it may have been cleaned, or the task has not started yet." : "is not known yet.") + "</p>";
    }
    for (const section of d.sections) {
      const f = dir.files.find((x) => x.name === section.name);
      if (!f) continue;
      const key = "file:" + f.name;
      const open = opened.has(key) ? opened.get(key) : section.open && (f.size > 0 || f.name === ".command.sh");
      const body = f.size === 0 ? '<div class="note">Empty.</div>' :
        (f.truncated ? '<div class="note">Showing the last ' + esc(bytes(f.text.length)) + " of " + esc(bytes(f.size)) + ".</div>" : "") +
        "<pre>" + esc(f.text) + "</pre>";
      html += '<details data-key="' + esc(key) + '"' + (open ? " open" : "") + "><summary>" +
        '<span class="title">' + esc(f.label) + "</span>" +
        '<span class="meta">' + esc(f.description) + " · " + esc(f.name) + " · " + esc(bytes(f.size)) + "</span>" +
        '<span class="open linkish" data-open="' + esc(f.path) + '">Open in editor</span>' +
        "</summary>" + body + "</details>";
    }
    html += "<h2>Outputs</h2>" + entries(dir.outputs, false) + (dir.outputsTruncated ? '<div class="note">Only the first entries are shown.</div>' : "");
    html += "<h2>Inputs</h2>" + entries(dir.inputs, true);
    return html;
  }

  function entries(list, inputs) {
    if (!list.length) return '<div class="empty">' + (inputs ? "No staged inputs." : "No outputs (yet).") + "</div>";
    return "<table><tr><th>Name</th><th>" + (inputs ? "Source" : "Size") + "</th></tr>" + list.map((e) =>
      "<tr><td style=\"padding-left:" + (8 + e.depth * 16) + 'px">' +
      (e.isDirectory ? "📁 " + esc(e.name.split("/").pop()) : '<span class="linkish" data-open="' + esc(e.path) + '">' + esc(e.name.split("/").pop()) + "</span>") +
      "</td><td" + (inputs ? "" : ' class="num"') + ">" + (inputs ? esc(e.target || "(missing)") : e.isDirectory ? "" : esc(bytes(e.size))) + "</td></tr>").join("") + "</table>";
  }

  function renderRun(d) {
    const r = d.run;
    const reports = d.reports.map((k) => '<button data-report="' + esc(k) + '">' + esc({ report: "Report", timeline: "Timeline", dag: "DAG", trace: "Trace" }[k]) + "</button>").join("");
    let html = "<h1>" + esc(r.runName) + " " + badge(r.status) + "</h1>" +
      '<div class="sub">' + esc(r.script) + "</div>" +
      '<div class="actions">' + reports + '<button data-msg="output">Output</button><button data-msg="log">.nextflow.log</button></div>' +
      facts([
        ["Tasks", r.totals.total ? r.totals.done + " of " + r.totals.total + " done" + (r.totals.failed ? ", " + r.totals.failed + " failed" : "") + (r.totals.running ? ", " + r.totals.running + " running" : "") : "none yet"],
        ["Duration", d.duration],
        ["Profiles", (r.profiles || []).join(", ")],
        ["Workbench cluster", d.cluster],
        ["Session", r.sessionId],
        ["Started", r.startedAt && new Date(r.startedAt).toLocaleString()]
      ]);
    if (!r.liveStatus) html += '<div class="note">Only completed tasks are shown: the nf-workbench plugin is not installed.</div>';
    if (r.errorMessage && r.status === "failed") {
      html += "<h2>Error</h2><pre>" + esc(r.errorMessage) + "</pre>";
    }
    html += "<h2>Processes</h2>";
    if (!r.processes.length) {
      html += '<div class="empty">No tasks yet.</div>';
    } else {
      html += "<table><tr><th>Process</th><th>Progress</th><th>Done</th><th>Running</th><th>Failed</th><th>Retried</th></tr>" +
        r.processes.map((p) => {
          const done = p.succeeded + p.cached;
          const pct = p.total ? Math.round((done / p.total) * 100) : 0;
          return "<tr><td>" + esc(p.name) + '</td><td><div class="bar" style="opacity:1;background:var(--vscode-panel-border,#8884)"><span style="width:' + pct + '%;background:' + (p.failed ? "var(--vscode-testing-iconFailed,#f85149)" : "var(--vscode-testing-iconPassed,#3fb950)") + '"></span></div></td>' +
            '<td class="num">' + done + " / " + p.total + '</td><td class="num">' + (p.running || "") + '</td><td class="num">' + (p.failed || "") + '</td><td class="num">' + (p.retried || "") + "</td></tr>";
        }).join("") + "</table>";
    }
    if (d.failed.length) {
      html += "<h2>Failed tasks</h2>" + d.failed.map((f) =>
        '<div class="fail-item"><span class="linkish" data-task="' + f.taskId + '">' + esc(f.name) + "</span>" +
        (f.exit !== undefined ? " · exit " + esc(f.exit) : "") + (f.stderr ? "<pre>" + esc(f.stderr) + "</pre>" : "") + "</div>").join("");
    }
    if (d.running.length) {
      html += "<h2>Running</h2><div>" + d.running.map((f) => '<span class="linkish" data-task="' + f.taskId + '">' + esc(f.name) + "</span>").join(" · ") + "</div>";
    }
    return html;
  }

  function render() {
    const scroll = window.scrollY;
    root.innerHTML = data.kind === "task" ? renderTask(data) : renderRun(data);
    window.scrollTo(0, scroll);
  }

  root.addEventListener("toggle", (event) => {
    const el = event.target;
    if (el.tagName === "DETAILS" && el.dataset.key) opened.set(el.dataset.key, el.open);
  }, true);
  root.addEventListener("click", (event) => {
    const el = event.target.closest("[data-open],[data-task],[data-msg],[data-report]");
    if (!el) return;
    if (el.dataset.open) { event.preventDefault(); post({ type: "open", path: el.dataset.open }); }
    else if (el.dataset.task) post({ type: "task", taskId: Number(el.dataset.task) });
    else if (el.dataset.report) post({ type: "action", action: el.dataset.report });
    else post({ type: "action", action: el.dataset.msg });
  });
  window.addEventListener("message", (event) => {
    if (event.data && event.data.type === "update") {
      if (event.data.data.kind !== data.kind || event.data.data.id !== data.id) opened.clear();
      data = event.data.data;
      render();
    }
  });
  render();
})();
`;
