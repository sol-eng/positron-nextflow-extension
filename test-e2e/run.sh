#!/bin/bash
# Runs test-e2e/suite.js in Positron, with a throwaway profile and a copy of
# test-e2e/pipeline. Needs `npm run compile` first (it tests build/), and
# NEXTFLOW and JAVA_HOME for a Nextflow 25.10+ with Java 17+.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
editor="${POSITRON_BIN:-/Applications/Positron.app/Contents/MacOS/Positron}"
: "${NEXTFLOW:?set NEXTFLOW to the nextflow executable to test with}"
: "${JAVA_HOME:?set JAVA_HOME to a Java 17 or later}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp -r "$here/pipeline" "$tmp/pipeline"
mkdir -p "$tmp/user/User"
cat >"$tmp/user/User/settings.json" <<JSON
{
  "nextflow.run.executable": "$NEXTFLOW",
  "nextflow.java.home": "$JAVA_HOME",
  "nextflow.run.confirm": false,
  "nextflow.run.driver": "local",
  "nextflow.telemetry.enabled": false,
  "workbench.startupEditor": "none",
  "telemetry.telemetryLevel": "off"
}
JSON
export E2E_RESULT="$tmp/result.json"
# built-in extensions may write logs into the current directory
cd "$tmp"
"$editor" --user-data-dir "$tmp/user" --extensions-dir "$tmp/extensions" \
  --disable-workspace-trust --skip-welcome --new-window \
  --extensionDevelopmentPath="$repo/build" --extensionTestsPath="$here/suite.js" \
  "$tmp/pipeline" >"$tmp/editor.log" 2>&1 || true
if [ ! -f "$E2E_RESULT" ]; then
  echo "no results; editor output:" >&2
  tail -40 "$tmp/editor.log" >&2
  exit 1
fi
node -e '
  const r = require(process.argv[1]);
  for (const c of r) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : "  " + JSON.stringify(c.detail)}`);
  process.exit(r.every((c) => c.ok) ? 0 : 1);
' "$E2E_RESULT"
