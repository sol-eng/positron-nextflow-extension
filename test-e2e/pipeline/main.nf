// The pipeline test-e2e/suite.js drives inside Positron.
params.fail = false
params.sleep = 0

process SAY {
  input: val x
  output: path "out_${x}.txt"
  script:
  if (params.fail && x == 2)
    """
    echo 'reference genome not found: genome.fa' >&2
    exit 1
    """
  else
    """
    sleep ${params.sleep}
    echo hello ${x} > out_${x}.txt
    """
}

workflow { SAY(channel.of(1, 2)) }
