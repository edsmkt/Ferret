# Ferret

Open-source Claygent alternative. Deploy a web research agent on Cloudflare Workers.

Send a prompt + JSON Schema, get structured data back. Ferret searches Google, scrapes websites, and uses any LLM with tool calling (DeepSeek, GPT-4o, Claude, Gemini, Llama — anything OpenAI-compatible) to return exactly the JSON you asked for.

Works as a Clay HTTP Request column, n8n webhook target, or standalone API.

## Why

Claygent charges 2 Clay credits per row. If you're running 10,000 rows, that's 20,000 credits gone on research alone.

Ferret does the same thing on your own infrastructure:
- **Any LLM with tool calling + JSON mode** — DeepSeek, GPT-4o, Claude, Gemini, Llama, Mistral, or any OpenAI-compatible API
- **Native Cloudflare fetch** for page scraping (free)
- **Your own search API** (from $0.04/1K searches)
- **Fully open** — swap any provider, model, or scraper

## How It Works

```
POST { prompt, schema }
        │
        ▼
   ┌─────────┐
   │ DeepSeek │──── web_search (RapidAPI Google) ───► Google results
   │  agent   │──── fetch_page ───► native fetch ───► CF Browser ───► scrape.do
   │  loop    │
   └────┬─────┘
        │
        ▼
  { structured JSON matching your schema }
```

The LLM decides what to search and what pages to read. It calls tools autonomously until it has enough information, then returns JSON matching your schema.

Page fetching cascades through 5 tiers to minimize cost:

| Tier | Method | Cost |
|------|--------|------|
| 1 | Native `fetch()` from Cloudflare edge | Free |
| 2 | Cloudflare Browser Rendering | Browser seconds (no external credits) |
| 3 | scrape.do standard | 1 credit |
| 4 | scrape.do render (JS) | 5 credits |
| 5 | scrape.do super (headless) | 25 credits |

Most pages resolve at tier 1. scrape.do is rarely needed.

## Quick Start

```bash
git clone https://github.com/edsmkt/Ferret.git
cd Ferret

# Set your secrets (LLM API — works with any OpenAI-compatible provider)
echo "DEEPSEEK_API_KEY=sk-your-key" > .dev.vars
echo "RAPIDAPI_KEY=your-rapidapi-key" >> .dev.vars

# Optional (fallback scraping)
echo "SCRAPE_DO_TOKEN=your-token" >> .dev.vars

# Optional (Cloudflare Browser Rendering)
echo "CF_ACCOUNT_ID=your-account-id" >> .dev.vars
echo "CF_API_TOKEN=your-cf-token" >> .dev.vars

# Run locally
wrangler dev

# Deploy
wrangler deploy
```

## API

### Request

```
POST /
Content-Type: application/json
```

```json
{
  "prompt": "Research Acme GmbH. Find what they do, their pricing, and who the CEO is.",
  "schema": {
    "type": "object",
    "required": ["company", "what_they_do", "ceo"],
    "properties": {
      "company": { "type": "string" },
      "what_they_do": { "type": "string", "description": "1-2 sentence summary" },
      "pricing_url": { "type": "string" },
      "ceo": { "type": "string" },
      "employee_count": { "type": "integer" }
    }
  }
}
```

The `schema` field accepts either a **JSON Schema** (with `type`, `properties`, `required`, `description`, `enum`) or a plain **example object** — Ferret handles both.

### Response

```json
{
  "result": {
    "company": "Acme GmbH",
    "what_they_do": "B2B industrial supplies manufacturer based in Munich.",
    "pricing_url": "https://acme.de/pricing",
    "ceo": "Hans Mueller",
    "employee_count": 120
  },
  "agent_log": [
    { "step": "web_search", "query": "Acme GmbH", "via": "rapidapi", "status": 200, "cost": 0 },
    { "step": "fetch_page", "url": "https://acme.de", "via": "native", "status": 200, "cost": 0, "chars": 8000 },
    { "step": "fetch_page", "url": "https://acme.de/about", "via": "native", "status": 200, "cost": 0, "chars": 5200 },
    { "step": "done", "rounds_total": 3, "fetches_used": 4 }
  ],
  "scrape_credits_total": 0,
  "model": "deepseek-chat"
}
```

The `agent_log` shows every step the agent took — every search, every page fetch, which tier handled it, and the cost.

### Using with Clay

Add an **HTTP Request** column in Clay:

- **Method:** POST
- **URL:** `https://ferret.your-subdomain.workers.dev`
- **Headers:** `Content-Type: application/json`
- **Body:**
```json
{
  "prompt": "Research {{Company Name}} at {{Website}}. Classify their industry and find the CEO.",
  "schema": {
    "industry": "string",
    "ceo_name": "string",
    "employee_count": "number"
  }
}
```

Clay resolves `{{placeholders}}` before sending — Ferret receives the full prompt with real values.

### Authentication

Set the `WORKER_AUTH` secret to protect your endpoint:

```bash
wrangler secret put WORKER_AUTH
```

Then include in requests:
```
x-worker-key: your-secret-key
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DEEPSEEK_API_KEY` | Yes | LLM API key. Ships with DeepSeek but works with any OpenAI-compatible provider (OpenRouter, OpenAI, Groq, Together, Mistral) — just swap the URL in `worker.js`. See [AGENT.md](AGENT.md). |
| `RAPIDAPI_KEY` | Yes | RapidAPI key for Google Search |
| `SCRAPE_DO_TOKEN` | No | scrape.do token (fallback scraping) |
| `CF_ACCOUNT_ID` | No | Cloudflare account ID (Browser Rendering) |
| `CF_API_TOKEN` | No | Cloudflare API token with Browser Rendering permission |
| `WORKER_AUTH` | No | Secret key to protect your endpoint |

### Wrangler Vars

| Variable | Default | Description |
|----------|---------|-------------|
| `MODEL` | `deepseek-chat` | LLM model to use |
| `MAX_FETCHES` | `8` | Max tool calls per request |
| `MAX_TOKENS` | `4000` | Max LLM output tokens |

## Search API Providers

Ferret uses RapidAPI Google Search by default. Here are providers ranked by cost:

### RapidAPI Providers

| Provider | Subs | Latency | Uptime | Rate Limit | 100K Cost | Per 1K | Notes |
|----------|------|---------|--------|------------|-----------|--------|-------|
| [ScraperLink](https://rapidapi.com/scraperlink-MN3CUx-kE/api/google-search116/pricing) | 628 | 3,914ms | 100% | 1 req/s | **$20** | **$0.04** | Cheapest but slow, 5s per request. 1 req/s rate limit. |
| [Winbay Tech](https://rapidapi.com/winbay-tech-ai/api/google-search122/pricing) | 180 | 6,501ms | 100% | 10 req/s | **$10** | **$0.10** | Cheap. Low price plan. Bad latency. But 10 req/s rate limit. |
| [Scrappa](https://rapidapi.com/scrappa/api/unlimited-google-search1/pricing) | 221 | 739ms | 100% | 1 req/s | **$25** | **$0.25** | Good speed, but 1 req/s rate limit. |
| [FlyByAPIs](https://rapidapi.com/flybyapi1/api/google-serp-search-api/pricing) | 83 | 435ms | 100% | 10 req/s | **$50** | **$0.50** | Good speed, but 2x Scrappa's cost. But 10 req/s rate limit. |

### Other Providers

| Provider | Plan | 100K Cost | Per 1K | Speed | Notes |
|----------|------|-----------|--------|-------|-------|
| [Scrappa.co](https://scrappa.co/pricing) (PAYG) | $25 Basic (86K credits) | $27 | **$0.29** | N/A | PAYG, credits valid 12 months. 80+ endpoints. $0.20/1K at $1,000 pack |
| [Scrapingdog](https://www.scrapingdog.com/prices/) Light | $90/mo Standard | $45 | **$0.45** | 1.25-1.83s | Basic organic only (position, title, URL, snippet) |
| [Scrapingdog](https://www.scrapingdog.com/prices/) Advanced | $90/mo Standard | $90 | **$0.90** | 1.25-1.83s | Full output: PAA, AI Overview, ads, local pack, related searches |
| [HasData](https://hasdata.com/prices) Light | $99/mo Business | $50 | **$0.50** | 1.75-2.3s | Organic only. 200K searches at $0.50/1K |
| [HasData](https://hasdata.com/prices) Full | $99/mo Business | $99 | **$0.99** | 1.75-2.3s | 15+ features: PAA, AI Overview, ads, local pack, knowledge graph |
| [SearchCans](https://www.searchcans.com/pricing/) (PAYG) | $99 Starter | $75 | **$0.75** | 1-1.5s | PAYG, credits valid 6 months. Zero independent reviews |
| [Serper.dev](https://serper.dev/pricing) (PAYG) | $50 | $100 | **$1.00** | 1.83-2.87s | PAYG, credits valid 6 months. Gets cheaper at 500K+ ($0.50/1K) |

To swap providers, see [AGENT.md](AGENT.md) for instructions on replacing the search and scraping functions.

### Scraping Providers (page fetching fallback)

Ferret uses native Cloudflare fetch first (free). These are fallback options for when sites block direct requests:

| Provider | Plan | Credits | Per 1K | Concurrency | Notes |
|----------|------|---------|--------|-------------|-------|
| [scrape.do](https://scrape.do?fpr=w13vy2) Free | $0/mo | 1,000 | Free | 5 | Good for testing |
| [scrape.do](https://scrape.do?fpr=w13vy2) Hobby | $29/mo | 250K | **$0.11** | 10 | Personal/non-commercial |
| [scrape.do](https://scrape.do?fpr=w13vy2) Pro | $99/mo | 1.25M | **$0.08** | 50 | Teams and power users |
| [scrape.do](https://scrape.do?fpr=w13vy2) Business | $249/mo | 3.5M | **$0.07** | 100 | Dedicated account manager |
| [scrape.do](https://scrape.do?fpr=w13vy2) Advanced | $699/mo | 10M | **$0.06** | 200 | Custom WAF bypass, SLA |

Note: JS rendering (`render=true`) costs 5 credits per call, super mode costs 25 credits. Most pages resolve via free native fetch — scrape.do is rarely needed.

## Cost Comparison

### Claygent (Clay)
- 2 Clay credits per research call
- At scale: expensive, opaque pricing

### Ferret (self-hosted)
- **Search:** $0.04-$1.00 per 1K searches depending on provider
- **Page fetching:** Usually free (native fetch). Fallback scraping ~1-25 credits when needed
- **LLM:** DeepSeek at ~$0.14/M input tokens, $0.28/M output tokens
- **Hosting:** Cloudflare Workers free tier (100K requests/day) or $5/mo paid

Typical cost per research call: **$0.001 - $0.01** depending on how many searches/pages the agent needs.

## License

MIT
