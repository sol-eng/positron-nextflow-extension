import { test } from "node:test";
import * as assert from "node:assert/strict";

import { blockBody, findEmbeddedBlock, toRunnableCode } from "../embeddedBlock";

const script = `process PLOT {
    input:
    path counts

    script:
    """
    #!/usr/bin/env Rscript
    df <- read.csv("\${counts}")
    print(df\\$gene)
    """
}

process FILTER {
    script:
    """
    #!/usr/bin/env python3

    import pandas as pd
    print("done")
    """
}

process SHELL {
    script:
    """
    echo hello
    """
}`.split("\n");

test("finds an R block from any line inside it", () => {
  for (const line of [5, 6, 7, 8, 9]) {
    assert.deepEqual(findEmbeddedBlock(script, line), {
      languageId: "r",
      openLine: 5,
      closeLine: 9
    });
  }
});

test("finds a Python block after an earlier block", () => {
  assert.deepEqual(findEmbeddedBlock(script, 18), {
    languageId: "python",
    openLine: 14,
    closeLine: 19
  });
});

test("ignores shell blocks and lines outside blocks", () => {
  assert.equal(findEmbeddedBlock(script, 26), undefined);
  assert.equal(findEmbeddedBlock(script, 2), undefined);
  assert.equal(findEmbeddedBlock(script, 12), undefined);
});

test("block code drops the shebang and indentation", () => {
  const block = findEmbeddedBlock(script, 18)!;
  assert.deepEqual(toRunnableCode(blockBody(script, block)), {
    code: 'import pandas as pd\nprint("done")',
    hasInterpolation: false
  });
});

test("undoes Nextflow string escapes", () => {
  assert.equal(toRunnableCode("print(df\\$gene)").code, "print(df$gene)");
  assert.equal(toRunnableCode('x <- "a\\\\b"').code, 'x <- "a\\b"');
  assert.equal(toRunnableCode("print(df\\$gene)").hasInterpolation, false);
});

test("flags Nextflow interpolation", () => {
  assert.equal(toRunnableCode('read.csv("${counts}")').hasInterpolation, true);
  assert.equal(toRunnableCode("cat $counts").hasInterpolation, true);
  assert.equal(toRunnableCode("cost <- 5 * 2").hasInterpolation, false);
});
