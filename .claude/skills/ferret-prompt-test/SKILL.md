---
name: ferret-prompt-test
description: Test and iteratively improve a prompt + schema for Ferret (the self-hosted research agent in this repo) by running it against diverse real inputs, diagnosing failures from the agent_log, and fixing the prompt until results are reliable. Use when the user wants to build, test, or improve a Ferret prompt, or says a Ferret column/workflow is returning bad results.
---

# Ferret Prompt Test

Iterate a Ferret prompt to production quality using a simple loop: **run → diagnose from logs → fix → re-run**. Two or three rounds is normally enough.

## Setup (once per session)

- Find the worker URL: ask the user for their deployed URL (`https://ferret.<subdomain>.workers.dev`), or run `wrangler dev --port 8799` from the repo root and test against `http://localhost:8799`.
- Auth: if `WORKER_AUTH` is set in `.dev.vars`, source it and send the `x-worker-key` header. Never print the key.
- Read `PROMPTING.md` in the repo root before diagnosing — it documents the tested prompt/schema rules this skill applies.
- Request shape:

```bash
source .dev.vars 2>/dev/null
curl -s -X POST "$FERRET_URL" \
  -H 'Content-Type: application/json' -H "x-worker-key: $WORKER_AUTH" \
  -d @payload.json
```

Payload: `{ "prompt", "schema", "deadline_ms", "max_fetches" }`. For thorough testing use `deadline_ms: 0` and `max_fetches: 14`; tighten both once the prompt works.

## The loop

### 1. Draft

If the user brings a prompt, start from it. If they bring a goal, draft prompt + schema applying PROMPTING.md from the start:

- Defining constraints as **hard rules in priority order**, not prose
- Schema with `required` + real types; nullable (`["number","null"]`) for legitimately-absent fields
- A `verification` enum (`verified_on_page` / `search_snippet_only` / `not_found`) on any factual claim that matters
- If outputs include URLs: "fetch each URL you output to verify it before finalizing"

### 2. Test against 3 diverse inputs

Pick 3 real companies spanning the variance that breaks prompts: one well-known, one mid/obscure, one edge case (weird niche, non-US, tiny site). Run all three (sequential curl calls, save each response to `/tmp/`).

### 3. Manual check — establish ground truth yourself

For each input, independently research the load-bearing fields using YOUR OWN tools (web search, page fetch) — do not look at Ferret's answer first, and do not reuse Ferret's sources as your starting point. You are the control group; if you start from Ferret's output you'll anchor on it.

Then grade Ferret's result field-by-field against your ground truth:

| Grade | Meaning |
|-------|---------|
| match | Ferret's value agrees with what you found |
| mismatch | Ferret is wrong — note what the correct value is and which source proves it |
| unverifiable | You couldn't determine it either — don't count against Ferret, but flag if Ferret claimed it confidently |

A run passes only if every load-bearing field is `match`. Plausible-but-wrong is the failure mode this step exists to catch — a result can look clean, validate against the schema, and still be stale or fabricated (we caught a $24.16 price for a plan that no longer existed exactly this way).

### 4. Diagnose failures from the logs — not from vibes

For each mismatch, read in this order:

| Signal | Question it answers |
|--------|--------------------|
| `agent_log` queries + `purpose` fields | What did it look for, and why? Wasted searches (revenue hunting, repeated angles) = prompt sends it down holes |
| `sources` | Did the answer come from primary pages or search snippets? |
| `schema_issues` / `schema_retry` | Schema fighting the model (required + legitimately-empty, type mismatches) |
| `done` entry: `fetches_used` vs budget, deadline notes | Did it run out of budget/time before verifying? |
| `tokens_in`/`out`, `duration_ms` | Cost per row at scale |

Common failure → fix patterns (all field-tested):

- **Stale third-party data** → add "prefer the company's own pages; aggregators go stale"
- **Unverified URLs in output** → add mandatory verify-by-fetch rule + verification enum
- **Budget burned on unfindable facts** (revenue, headcount of tiny companies) → "estimate from signals you already have; do NOT search for X"
- **Wandering on scoped tasks** → "Check ONLY …. Do not search." (absolute phrasing)
- **Required fields forced into guesses** → make them nullable or use the enum instead of empty-string instructions

### 5. Fix and re-run

Change the **prompt/schema only** — never tune Ferret's system prompt in `worker.js` for one use case. Re-run the same 3 inputs and repeat the manual check on fields that changed. Pass = all 3 runs have every load-bearing field graded `match`, verified, schema-clean.

### 6. Deliver

Hand back: final payload JSON (ready for n8n/script/HTTP), a one-line note on recommended `max_fetches`/`deadline_ms` for this task's weight, the final grade table (3 inputs × load-bearing fields), and what was changed between rounds and why (the log evidence).

## Rules

- Test with real companies, never invented ones.
- One variable at a time when a round fails — change the prompt, not the model/budget, unless logs show budget was the binding constraint.
- If two rounds don't fix it, the task may need a stronger model — say so instead of prompt-tweaking forever (model swap is documented in AGENT.md).
- Each run costs real (small) money — 3 inputs × 3 rounds ≈ $0.05–0.15 at DeepSeek rates. Don't run 10-input matrices.
