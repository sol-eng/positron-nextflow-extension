// Locates R and Python code embedded in Nextflow process scripts, and turns
// it into code a Positron console can run. Kept free of `vscode` so it can be
// unit tested with plain Node.

export type EmbeddedLanguage = "r" | "python";

export type EmbeddedBlock = {
  languageId: EmbeddedLanguage;
  /** line of the opening `"""` */
  openLine: number;
  /** line of the closing `"""` */
  closeLine: number;
};

export type RunnableCode = {
  code: string;
  /** the code still contains Nextflow interpolation such as `${x}` or `$x` */
  hasInterpolation: boolean;
};

// The shebangs recognised by syntaxes/nextflow-script-injection.json
const SHEBANGS: [RegExp, EmbeddedLanguage][] = [
  [/^\s*#!.*\bpython[\d.]*\b/, "python"],
  [/^\s*#!.*\b(?:R|Rscript)\b/, "r"]
];

const TRIPLE_QUOTE = /"""/g;

/** The language of a script's shebang line, if it is R or Python. */
export function shebangLanguage(line: string): EmbeddedLanguage | undefined {
  return SHEBANGS.find(([re]) => re.test(line))?.[1];
}

/** Console code that makes `dir` the working directory. */
export function chdirCode(language: EmbeddedLanguage, dir: string): string {
  // a JSON string literal is also a valid R and Python string literal
  const quoted = JSON.stringify(dir);
  return language === "r"
    ? `setwd(${quoted})`
    : `import os; os.chdir(${quoted})`;
}

/**
 * Find the R or Python script block that contains `line`. A block is a
 * `"""` string whose first non-blank line is an R or Python shebang.
 */
export function findEmbeddedBlock(
  lines: string[],
  line: number
): EmbeddedBlock | undefined {
  let openLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const quotes = lines[i].match(TRIPLE_QUOTE)?.length ?? 0;
    for (let q = 0; q < quotes; q++) {
      if (openLine === -1) {
        openLine = i;
        continue;
      }
      const closeLine = i;
      if (line >= openLine && line <= closeLine) {
        const languageId = blockLanguage(lines, openLine, closeLine);
        return languageId ? { languageId, openLine, closeLine } : undefined;
      }
      openLine = -1;
    }
    if (openLine === -1 && i >= line) break;
  }
  return undefined;
}

function blockLanguage(
  lines: string[],
  openLine: number,
  closeLine: number
): EmbeddedLanguage | undefined {
  for (let i = openLine + 1; i < closeLine; i++) {
    if (lines[i].trim() === "") continue;
    return shebangLanguage(lines[i]);
  }
  return undefined;
}

/** The lines strictly between the quotes of `block`. */
export function blockBody(lines: string[], block: EmbeddedBlock): string {
  return lines.slice(block.openLine + 1, block.closeLine).join("\n");
}

/**
 * Prepare script text for the console: drop the shebang, remove the common
 * indentation, and undo the escapes of a Nextflow `"""` string (`\$`, `\\`,
 * `\"`) so that e.g. `df\$col` becomes `df$col`.
 */
export function toRunnableCode(text: string): RunnableCode {
  let lines = text.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first !== -1 && lines[first].trim().startsWith("#!")) {
    lines = lines.slice(first + 1);
  }
  const indents = lines
    .filter((l) => l.trim() !== "")
    .map((l) => l.match(/^\s*/)![0].length);
  const indent = indents.length ? Math.min(...indents) : 0;
  const body = lines.map((l) => l.slice(indent)).join("\n");
  return {
    code: body.replace(/\\([\\$"])/g, "$1").trim(),
    hasInterpolation: /(^|[^\\])\$(\{|[A-Za-z_])/m.test(body)
  };
}
