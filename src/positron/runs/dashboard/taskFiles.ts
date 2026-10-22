// Reads a task's work directory into labelled parts for the task dashboard:
// Nextflow's own files, the staged inputs, and the task's outputs. Kept free
// of `vscode` so it can be unit tested.

import * as fs from "fs";
import * as path from "path";

import { shebangLanguage } from "../../embeddedBlock";

export type StandardFile = {
  name: string;
  label: string;
  description: string;
  path: string;
  size: number;
  /** the end of the file, at most `TAIL_BYTES` */
  text: string;
  truncated: boolean;
};

export type DirEntry = {
  /** relative to the work directory */
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
  /** for inputs: where the staged symlink points */
  target?: string;
  depth: number;
};

export type TaskDir = {
  exists: boolean;
  files: StandardFile[];
  inputs: DirEntry[];
  outputs: DirEntry[];
  /** more outputs than `MAX_OUTPUTS` were found */
  outputsTruncated: boolean;
  exitCode?: number;
  usage?: TaskUsage;
  scriptLanguage?: string;
};

export type TaskUsage = {
  realtimeMs?: number;
  cpuPercent?: number;
  memPercent?: number;
  cpuModel?: string;
  peakRssBytes?: number;
  peakVmemBytes?: number;
  rssBytes?: number;
  vmemBytes?: number;
  readCharsBytes?: number;
  writeCharsBytes?: number;
  readBytes?: number;
  writeBytes?: number;
};

export const TAIL_BYTES = 256 * 1024;
export const MAX_OUTPUTS = 200;
const OUTPUT_DEPTH = 2;

/** Nextflow's files in a work directory, in their default order. */
export const STANDARD_FILES: Record<string, [string, string]> = {
  ".command.sh": [
    "Script",
    "The task's script, with Nextflow variables substituted"
  ],
  ".command.out": ["Output (stdout)", "What the script printed"],
  ".command.err": [
    "Error output (stderr)",
    "Errors and warnings the script printed"
  ],
  ".command.log": [
    "Combined log",
    "stdout and stderr together, as the executor captured them"
  ],
  ".command.trace": [
    "Resource usage",
    "CPU, memory and I/O measured while the task ran"
  ],
  ".command.run": [
    "Nextflow wrapper",
    "The script Nextflow ran to stage inputs and run the task"
  ]
};

/** Files Nextflow uses for bookkeeping, not shown as outputs. */
const HIDDEN = new Set([
  ...Object.keys(STANDARD_FILES),
  ".exitcode",
  ".command.begin",
  ".command.env",
  ".command.infile"
]);

/** The last `limit` bytes of a file, decoded as text. */
export function readTail(
  file: string,
  limit = TAIL_BYTES
): { text: string; size: number; truncated: boolean } {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, limit);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    let text = buffer.toString("utf8");
    // drop a partial first line when the file was cut
    if (size > limit) text = text.slice(text.indexOf("\n") + 1);
    return { text, size, truncated: size > limit };
  } finally {
    fs.closeSync(fd);
  }
}

export function readTaskDir(workdir: string): TaskDir {
  const result: TaskDir = {
    exists: false,
    files: [],
    inputs: [],
    outputs: [],
    outputsTruncated: false
  };
  let names: string[];
  try {
    names = fs.readdirSync(workdir).sort();
  } catch {
    return result;
  }
  result.exists = true;

  for (const [name, [label, description]] of Object.entries(STANDARD_FILES)) {
    const file = path.join(workdir, name);
    try {
      result.files.push({
        name,
        label,
        description,
        path: file,
        ...readTail(file)
      });
    } catch {
      // not written (yet), e.g. no .command.trace without metrics
    }
  }

  const script = result.files.find((f) => f.name === ".command.sh");
  const firstLine = script?.text.split("\n", 1)[0] ?? "";
  result.scriptLanguage =
    shebangLanguage(firstLine) ??
    (firstLine.startsWith("#!") ? "shellscript" : undefined);

  const trace = result.files.find((f) => f.name === ".command.trace");
  if (trace) result.usage = parseCommandTrace(trace.text);

  try {
    const code = Number(
      fs.readFileSync(path.join(workdir, ".exitcode"), "utf8").trim()
    );
    if (Number.isFinite(code)) result.exitCode = code;
  } catch {
    // still running
  }

  const outputs: DirEntry[] = [];
  for (const name of names) {
    if (HIDDEN.has(name)) continue;
    const file = path.join(workdir, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      result.inputs.push(inputEntry(name, file));
    } else {
      walk(workdir, file, 0, outputs);
    }
  }
  result.outputsTruncated = outputs.length > MAX_OUTPUTS;
  result.outputs = outputs.slice(0, MAX_OUTPUTS);
  return result;
}

function inputEntry(name: string, file: string): DirEntry {
  let target: string | undefined;
  let size = 0;
  let isDirectory = false;
  try {
    target = fs.readlinkSync(file);
    const stat = fs.statSync(file);
    size = stat.size;
    isDirectory = stat.isDirectory();
  } catch {
    // a dangling link, e.g. its source was removed
  }
  return { name, path: file, size, isDirectory, target, depth: 0 };
}

function walk(root: string, file: string, depth: number, into: DirEntry[]) {
  if (into.length > MAX_OUTPUTS) return;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return;
  }
  into.push({
    name: path.relative(root, file),
    path: file,
    size: stat.isDirectory() ? 0 : stat.size,
    isDirectory: stat.isDirectory(),
    depth
  });
  if (stat.isDirectory() && depth + 1 < OUTPUT_DEPTH) {
    for (const child of fs.readdirSync(file).sort()) {
      walk(root, path.join(file, child), depth + 1, into);
    }
  }
}

/**
 * Parse a `.command.trace` file (`nextflow.trace/v2`): `%cpu` and `%mem` are
 * written as tenths of a percent, memory sizes in KB, and `realtime` in ms.
 */
export function parseCommandTrace(text: string): TaskUsage | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "nextflow.trace/v2") return undefined;
  const values = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const index = line.indexOf("=");
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1));
  }
  const number = (key: string, scale = 1) => {
    const value = Number(values.get(key));
    return values.has(key) && values.get(key) !== "" && Number.isFinite(value)
      ? value * scale
      : undefined;
  };
  return {
    realtimeMs: number("realtime"),
    cpuPercent: number("%cpu", 0.1),
    memPercent: number("%mem", 0.1),
    cpuModel: values.get("cpu_model") || undefined,
    peakRssBytes: number("peak_rss", 1024),
    peakVmemBytes: number("peak_vmem", 1024),
    rssBytes: number("rss", 1024),
    vmemBytes: number("vmem", 1024),
    readCharsBytes: number("rchar"),
    writeCharsBytes: number("wchar"),
    readBytes: number("read_bytes"),
    writeBytes: number("write_bytes")
  };
}

/**
 * The order of the dashboard's sections, and which start open: a failed
 * task leads with its errors, others with the script and its output.
 */
export function sectionOrder(
  failed: boolean
): { name: string; open: boolean }[] {
  const order = failed
    ? [
        ".command.err",
        ".command.out",
        ".command.sh",
        ".command.log",
        ".command.trace",
        ".command.run"
      ]
    : [
        ".command.sh",
        ".command.out",
        ".command.err",
        ".command.log",
        ".command.trace",
        ".command.run"
      ];
  const open = new Set(
    failed ? [".command.err", ".command.sh"] : [".command.sh", ".command.out"]
  );
  return order.map((name) => ({ name, open: open.has(name) }));
}

/** Is `file` inside `dir`? Guards paths the dashboard asks to open. */
export function isInside(dir: string, file: string): boolean {
  const relative = path.relative(path.resolve(dir), path.resolve(file));
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function formatBytes(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return undefined;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
