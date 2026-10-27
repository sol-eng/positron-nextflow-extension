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
  "nextflow.run.headless.cluster": "Local",
  "nextflow.telemetry.enabled": false,
  "workbench.startupEditor": "none",
  "telemetry.telemetryLevel": "off"
}
JSON
export E2E_RESULT="$tmp/result.json"
# a stand-in for the Workbench API, presented to the extension as this session's
# server, for the runs whose Nextflow driver is a Workbench job
python3 "$here/fake_workbench.py" >"$tmp/fake-url" &
fake_pid=$!
disown "$fake_pid"
trap 'kill "$fake_pid" 2>/dev/null; rm -rf "$tmp"' EXIT
for _ in $(seq 50); do [ -s "$tmp/fake-url" ] && break; sleep 0.1; done
export POSIT_PRODUCT=WORKBENCH RS_SERVER_ADDRESS="$(cat "$tmp/fake-url")" RS_SESSION_RPC_COOKIE=fake-cookie
unset PWB_SESSION_RUNTIME_DIR WORKBENCH_SERVER WORKBENCH_API_KEY
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
