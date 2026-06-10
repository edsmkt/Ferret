#!/usr/bin/env bash
# Smoke test for Ferret. Runs three known-good prompts against a local or
# deployed instance and checks the response shape.
#
#   ./test.sh                          # tests http://localhost:8799 (wrangler dev)
#   ./test.sh https://ferret.you.workers.dev
#   WORKER_AUTH=secret ./test.sh https://...   # if your endpoint is protected
set -euo pipefail

BASE="${1:-http://localhost:8799}"
AUTH_HEADER=()
[ -n "${WORKER_AUTH:-}" ] && AUTH_HEADER=(-H "x-worker-key: $WORKER_AUTH")

pass=0; fail=0

run_test() {
  local name="$1" body="$2" check="$3"
  local out
  # ${arr[@]+...} guard: bash 3.2 (macOS default) treats empty arrays as unbound under set -u
  out=$(curl -s -X POST "$BASE" -H 'Content-Type: application/json' ${AUTH_HEADER[@]+"${AUTH_HEADER[@]}"} -d "$body")
  if echo "$out" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert 'error' not in d, 'error: ' + str(d.get('error'))
assert d.get('result'), 'empty result'
assert isinstance(d.get('sources'), list), 'missing sources'
assert d.get('tokens_in', 0) > 0, 'missing token usage'
assert d.get('duration_ms', 0) > 0, 'missing duration'
$check
" 2>/tmp/ferret-test-err; then
    echo "PASS  $name (credits: $(echo "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["scrape_credits_total"])'))"
    pass=$((pass+1))
  else
    echo "FAIL  $name — $(cat /tmp/ferret-test-err | tail -1)"
    echo "$out" | head -c 500; echo
    fail=$((fail+1))
  fi
}

echo "Testing $BASE"
echo

run_test "single-page scope (1 fetch, no search)" \
  '{"prompt":"Check ONLY the page https://www.lemlist.com/pricing. Do not search the web. Do not fetch any other page. Report whether they advertise a free trial on that page.","schema":{"type":"object","required":["has_free_trial"],"properties":{"has_free_trial":{"type":"boolean"},"evidence":{"type":"string"}}}}' \
  "assert isinstance(d['result']['has_free_trial'], bool), 'has_free_trial not a boolean'
assert len([e for e in d['agent_log'] if e['step'] == 'web_search']) == 0, 'agent searched despite scope restriction'"

run_test "dead URL stops cascade (0 credits)" \
  '{"prompt":"Fetch the page https://www.notion.com/nonexistent-page-xyz-12345 and report whether it exists. Do not search the web, just fetch that exact URL once, then answer.","schema":{"type":"object","required":["exists"],"properties":{"exists":{"type":"boolean"}}}}' \
  "assert d['scrape_credits_total'] == 0, 'cascade burned credits on a dead URL'
assert d['result']['exists'] == False, 'claimed a nonexistent page exists'"

run_test "GTM research with schema + deadline" \
  '{"prompt":"Research lemlist.com (the cold outreach tool). Find their pricing page and whether they offer a free trial.","schema":{"type":"object","required":["pricing_url","has_free_trial"],"properties":{"pricing_url":{"type":"string"},"has_free_trial":{"type":"boolean"}}},"deadline_ms":60000}' \
  "assert 'lemlist.com' in d['result']['pricing_url'], 'wrong pricing URL'
assert isinstance(d['result']['has_free_trial'], bool), 'has_free_trial not a boolean'
assert len(d['sources']) > 0, 'no sources recorded'"

echo
echo "$pass passed, $fail failed"
exit $fail
