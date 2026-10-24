#!/bin/bash
# Opens the built app (dist/mac-arm64/Super Face.app) the way a user would, and checks it works:
# the avatar loads, the voice loads (downloading it the first time), and it says a sentence, all
# through its API. A screenshot of the screen goes to dist/smoke.png. Run by the release build, so
# an app that shows nothing is never released.
set -uo pipefail
cd "$(dirname "$0")/.."
app="$(ls -d dist/*/"Super Face.app" | head -1)"
[[ -d "$app" ]] || { echo "no built app in dist/"; exit 1; }
log=dist/smoke.log
# No microphone prompt on a build machine (nobody's there to answer it).
SUPERFACE_NO_MIC=1 "$app/Contents/MacOS/Super Face" > "$log" 2>&1 &
pid=$!
trap 'kill $pid 2>/dev/null' EXIT

health() { curl -s -m 2 http://127.0.0.1:8769/api/health; }
fail() { echo "✗ $*"; health; echo; tail -50 "$log"; screencapture -x dist/smoke.png 2>/dev/null; exit 1; }

# Up to 8 minutes: the first launch downloads the voice model.
for i in $(seq 1 240); do
  h="$(health)"
  if grep -q '"ready":true' <<<"$h"; then break; fi
  if grep -q '"avatar":"failed"\|"state":"failed"' <<<"$h"; then fail "it didn't load"; fi
  kill -0 $pid 2>/dev/null || fail "the app quit"
  (( i % 15 == 0 )) && echo "  waiting… $h"
  sleep 2
done
grep -q '"ready":true' <<<"$(health)" || fail "not ready after 8 minutes"
echo "✓ ready: $(health)"

answer="$(curl -s -m 300 http://127.0.0.1:8769/api/speak -d '{"text": "Hello! The release works. [thumbup]", "wait": true}')"
screencapture -x dist/smoke.png 2>/dev/null || true
grep -q '"state":"done"' <<<"$answer" || fail "it didn't speak: $answer"
echo "✓ spoke: $answer"
said="$(curl -s http://127.0.0.1:8769/api/said?seconds=300)"
grep -q 'The release works' <<<"$said" || fail "what it said isn't logged: $said"
echo "✓ logged what it said"

# The assistant is there, with its own tools (Ollama and Tool Mac Tool Run aren't on the build machine).
a="$(curl -s http://127.0.0.1:8769/api/assistant)"
grep -q '"name":"Ivy"' <<<"$a" || fail "the assistant isn't answering: $a"
t="$(curl -s http://127.0.0.1:8769/api/tools)"
grep -q '"name":"schedule"' <<<"$t" || fail "its tools aren't listed: $t"
s1="$(curl -s http://127.0.0.1:8769/api/schedules -d '{"in_minutes": 60, "task": "Check the release."}')"
grep -q '"id":"s1"' <<<"$s1" || fail "it can't schedule: $s1"
c="$(curl -s http://127.0.0.1:8769/api/schedules/cancel -d '{"id": "s1"}')"
grep -q '"cancelled":\["s1"\]' <<<"$c" || fail "it can't cancel a schedule: $c"
echo "✓ the assistant answers, lists its tools, schedules and cancels"
