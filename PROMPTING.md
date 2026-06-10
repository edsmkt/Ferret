# PROMPTING.md — Getting Reliable Results Out of Ferret

How you phrase the prompt and design the schema changes what comes back. Everything below was observed in real test runs against the default model (`deepseek-v4-flash`); other models will differ in degree, not direction.

## The basics

A Ferret request is `prompt` + `schema`. The prompt says what to find; the schema says what shape to return it in. The agent searches, fetches pages, and answers when it has enough — or when it runs out of budget (`MAX_FETCHES`) or time (`deadline_ms`).

Two rules of thumb before anything else:

1. **Put facts in the prompt, instructions about *how* to research too.** The agent follows prompt instructions well — but only if they're concrete.
2. **Put structure in the schema.** Types, enums, and `required` are validated after the run, with one retry round to fix problems. A constraint expressed in the schema is enforced; the same constraint expressed in prose is merely suggested.

## Scope control: "do only this one thing"

The agent is instructed to follow scope restrictions exactly. This works, but be explicit and absolute:

```
Check ONLY the page https://example.com/pricing. Do not search the web.
Do not fetch any other page. Report whether they advertise a free trial.
```

Tested result: exactly one fetch, zero searches. Vague scoping ("look at their pricing page") leaves the agent free to search and navigate — which is usually what you want, but not when you're paying for determinism.

## Dead pages and recovery

You don't need to write fallback instructions. If a URL is dead (404/410/401), the agent recovers on its own, in this order: find the live page on the same site (search or homepage links), then fall back to other reliable sources. Tested with an un-coached prompt pointing at a dead URL: it found the live page and answered from the primary source.

One thing worth knowing: the agent is explicitly warned that third-party aggregators (review sites, pricing trackers) go stale. We tested the naive "find it anywhere" framing and it returned a price from a plan that no longer exists. The shipped behavior prefers primary sources — don't undo that in your prompt by saying "any source is fine."

## Honesty instructions: the empty-string experiment

We tested "if you can't verify, return an empty string" under a starved fetch budget. The findings matter if you care about verified-vs-inferred data:

| Phrasing | What actually happened |
|----------|------------------------|
| Soft: *"if you cannot verify, return an empty string — do not guess"* | **No empty strings.** The model became more conservative instead: unverifiable criteria flipped to `met: false`, evidence hedged honestly. Search snippets still counted as "verification." |
| Strict: *"evidence MUST be exactly `\"\"` unless the fact appears on a page you actually fetched. Search snippets do NOT count."* | **Literal compliance — over-applied.** All evidence fields came back empty, including ones that *were* verifiable from a fetched page. Booleans got less coherent. |

Takeaways:

- The model obeys mechanical, absolute rules literally (and bluntly). Soft rules get reinterpreted as "be more careful."
- **The better pattern is a verification enum**, not empty strings:

```json
{
  "verification": {
    "type": "string",
    "enum": ["verified_on_page", "search_snippet_only", "not_found"]
  }
}
```

Enums are schema-validated (illegal values trigger the retry round), the model fills them coherently, and downstream you can filter rows by verification level instead of parsing hedged prose.

## Schema design rules

- **`required` + empty string = validation failure.** The validator treats `""` and `null` in required fields as missing and spends the retry round pushing the model to fill them. If a field is legitimately sometimes-empty (enterprise pricing, optional data), either leave it out of `required` or declare it nullable:

```json
{ "price_monthly_usd": { "type": ["number", "null"] } }
```

- **Declare types and mean them.** `"type": "number"` is enforced — a model answer of `"about 120"` triggers a retry. This is what keeps Clay number columns clean at scale.
- **Use `description` on fields.** It's rendered into the system prompt: `{ "type": "string", "description": "2-3 sentence summary, no marketing language" }` works.
- Leftover problems after the retry don't fail the request — they're reported in `agent_log` as `schema_issues`. Check for that key when QA-ing bulk runs.

## Budget and deadline interplay

- `MAX_FETCHES` (default 10) caps searches + page fetches. Cached re-reads are free.
- `deadline_ms` (default 120000) caps wall-clock time. Whichever runs out first forces the agent to answer with what it has.
- **Running out never errors.** The agent returns complete JSON — but evidence quality degrades from *verified* to *inferred*. Tested at `MAX_FETCHES=2` on a 4-criterion qualification: every field came back filled, and the model honestly flagged what it hadn't fetched. The `sources` array and `agent_log` tell you which answers were verified.
- Verification-heavy prompts need budget. If you ask the agent to verify N criteria, it needs roughly N+2 fetches (search, navigate, verify). An honesty instruction doesn't create verification capacity — it only changes how the gap is reported.

## Auditing results

Every response includes:

- `sources` — pages the agent actually read. An answer with one source was less cross-checked than one with three.
- `agent_log` — every search and fetch, in order, with status and cost. `schema_retry` entries mean the first answer had problems; `schema_issues` on the `done` entry means some survived.
- `tokens_in` / `tokens_out` — multiply by your provider's rates for per-row cost.

For bulk runs (Clay tables), keep `sources` and `schema_issues` as columns. Filtering "rows where evidence came from one source and schema_issues is non-empty" is your QA queue.

## Recipes

Ready-to-paste request bodies for common GTM tasks are in [examples/](examples/) — pricing pages, case studies, tech stack detection, ICP qualification, and strict single-page checks.
