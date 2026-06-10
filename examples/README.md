# Examples — GTM Research Recipes

Ready-to-paste request bodies for common GTM research tasks. Each works as a Clay HTTP Request column body, an n8n HTTP node, or a raw `curl` payload.

In Clay, replace the hardcoded values with `{{Company Name}}` / `{{Website}}` column references — Clay resolves them before sending.

| Recipe | What it finds |
|--------|---------------|
| [pricing-page.json](pricing-page.json) | Pricing page URL, plans, free trial |
| [case-studies.json](case-studies.json) | Case study page + named customers |
| [tech-stack.json](tech-stack.json) | Tools detectable from the website |
| [icp-qualifier.json](icp-qualifier.json) | Qualify a company against your ICP |
| [single-page-check.json](single-page-check.json) | Strict scope: check ONE page, nothing else |

## Usage

```bash
curl -X POST https://ferret.<your-subdomain>.workers.dev \
  -H "Content-Type: application/json" \
  -H "x-worker-key: $WORKER_AUTH" \
  -d @examples/pricing-page.json
```

For the full guide — scope control, verification enums, schema design rules, budget interplay — see [PROMPTING.md](../PROMPTING.md).

## Tips

- **Always set `deadline_ms`** when calling from Clay (~45000) or n8n — the agent wraps up before your HTTP timeout instead of erroring.
- **Use `required` + types in the schema.** Ferret validates the output against them and retries once on problems — this is what keeps a 10K-row table clean.
- **To restrict scope**, say it explicitly in the prompt ("check ONLY this page", "do not search") — the agent is instructed to follow scope restrictions exactly.
- **Audit with `sources`** — every response lists the pages the agent actually read.
