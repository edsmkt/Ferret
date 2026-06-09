# Ferret

Get the Claygent experience with your existing stack, outside of Clay.

A simple, open-source web research agent. Send a prompt + JSON Schema, get structured data back. Runs on Cloudflare Workers.

**You need four things:**
- A **Scraping API** (or just use Cloudflare's free native fetch)
- A **SERP API** (search engine — Google, Bing, Exa, Yandex, etc.)
- An **LLM API** (any provider with tool calling)
- A **Cloudflare account** (free tier works)

Point your coding agent (Claude Code, Codex, Cursor) to [AGENT.md](AGENT.md) and tell it to fit Ferret to your stack.

## How It Works

```
POST { prompt, schema }
        │
        ▼
   ┌─────────┐
   │   LLM    │──── web_search (search engine) ───► search results
   │  agent   │──── fetch_page ───► native fetch ───► CF Browser ───► scraping API
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
| 3+ | Scraping API fallback (JS rendering, proxies) | Varies |

Most pages resolve at tier 1. Ships with scrape.do as the fallback scraper, but you can replace it with your preferred provider (Zenrows, ScrapingBee, Spider.cloud, etc.) — ideally one with JS rendering and proxies for hard-to-reach sites.

## Prerequisites

You need three things:

### 1. Cloudflare account (free)

1. Sign up at [cloudflare.com](https://dash.cloudflare.com/sign-up)
2. Install Wrangler (Cloudflare's CLI):
   ```bash
   npm install -g wrangler
   ```
3. Log in:
   ```bash
   wrangler login
   ```
4. Find your **Account ID** — run `wrangler whoami` or find it in the Cloudflare dashboard URL: `dash.cloudflare.com/<account-id>/...`

The free Workers plan gives you 100,000 requests/day. Paid plan ($5/mo) unlocks higher limits and Browser Rendering.

### 2. LLM API key

Get an API key from any OpenAI-compatible provider:

| Provider | Sign up | Cost |
|----------|---------|------|
| [DeepSeek](https://platform.deepseek.com/) (default) | platform.deepseek.com | ~$0.14/M input, $0.28/M output |
| [OpenRouter](https://openrouter.ai/) | openrouter.ai | Varies by model, many free models |
| [OpenAI](https://platform.openai.com/) | platform.openai.com | ~$0.15/M input (gpt-4o-mini) |
| [Groq](https://console.groq.com/) | console.groq.com | Free tier available |
| [Together](https://api.together.xyz/) | api.together.xyz | ~$0.18/M input (Llama 3.3 70B) |

If you use a provider other than DeepSeek, see [AGENT.md](AGENT.md) to swap the URL (one line change).

### 3. Search API key

Get a RapidAPI key for Google Search:

1. Sign up at [rapidapi.com](https://rapidapi.com/)
2. Subscribe to one of the [search providers](#rapidapi-providers) listed below
3. Your API key is in the RapidAPI dashboard under **Apps → default-application → Authorization**

## Quick Start

```bash
git clone https://github.com/edsmkt/Ferret.git
cd Ferret

# Set your secrets (LLM API — works with any OpenAI-compatible provider)
echo "DEEPSEEK_API_KEY=sk-your-key" > .dev.vars
echo "RAPIDAPI_KEY=your-rapidapi-key" >> .dev.vars

# Optional (fallback scraping — see scrape.do pricing below)
echo "SCRAPE_DO_TOKEN=your-token" >> .dev.vars

# Run locally
wrangler dev

# Deploy to Cloudflare
wrangler deploy
```

After deploying, your worker runs at `https://ferret.<your-subdomain>.workers.dev`.

### Setting secrets for production

Local development reads from `.dev.vars`. For production, set secrets via Wrangler:

```bash
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put RAPIDAPI_KEY
wrangler secret put SCRAPE_DO_TOKEN        # optional
wrangler secret put WORKER_AUTH            # optional — protect your endpoint
```

### Optional: Cloudflare Browser Rendering

This enables Tier 2 page fetching — a headless browser on Cloudflare's edge for JS-heavy sites. Requires the Workers paid plan ($5/mo).

1. Go to **Cloudflare dashboard → My Profile → API Tokens → Create Token**
2. Create a **Custom Token** with the permission: **Account → Browser Rendering → Edit**
3. Set the secrets:
   ```bash
   # For local dev, add to .dev.vars:
   echo "CF_ACCOUNT_ID=your-account-id" >> .dev.vars
   echo "CF_API_TOKEN=your-token" >> .dev.vars

   # For production:
   wrangler secret put CF_ACCOUNT_ID
   wrangler secret put CF_API_TOKEN
   ```

If not configured, Ferret simply skips this tier — native fetch → scrape.do still works.

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

### AI-Powered Search & Retrieval

These aren't traditional SERP scrapers — they're AI-native search APIs that return cleaner, more relevant results. Good alternatives if you want higher quality over raw Google results.

| Provider | Pricing | Free Tier | Notes |
|----------|---------|-----------|-------|
| [Exa](https://exa.ai/pricing) | From $0.10/1K searches | 1,000 free searches/mo | Neural search engine. Returns clean content, not just links. Great for finding similar companies or specific content types. |
| [Tavily](https://tavily.com/#pricing) | From $0.05/1K searches | 1,000 free searches/mo | Built for AI agents. Returns pre-extracted content with each result — less need for follow-up page fetches. |
| [Jina AI Reader](https://jina.ai/reader/) | From $0.02/1K pages | Free tier available | Not a search engine — converts any URL to clean markdown. Use as a `fetch_page` replacement or alongside search. `r.jina.ai/<url>` returns markdown directly. |

To swap providers, give [AGENT.md](AGENT.md) to your coding agent (Claude Code, Codex, Cursor, etc.) and ask it to swap to your preferred provider. It has the architecture map, contracts, and drop-in code for each component.

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

#### Other Scraping Options

| Provider | Pricing | Notes |
|----------|---------|-------|
| [Crawl4AI](https://github.com/unclecode/crawl4ai) | Free (open source) | Self-hosted async web crawler. Returns clean markdown. Run it on your own server and point `fetchPage()` at it. |
| [Spider.cloud](https://spider.cloud/) | From $0.10/1K pages | Fast managed scraper with JS rendering, anti-bot bypass, and markdown output. Good drop-in for scrape.do. |
| [Jina AI Reader](https://jina.ai/reader/) | Free tier available | `r.jina.ai/<url>` returns any page as clean markdown — zero config, works as a one-liner `fetch_page` replacement. |

## Cost Comparison

### Claygent
- Locked to Clay — can only use inside Clay tables
- No control over which LLM, search API, or scraper it uses

### Ferret (self-hosted)
- **Search:** $0.04-$1.00 per 1K searches depending on provider
- **Page fetching:** Usually free (native fetch). Fallback scraping ~1-25 credits when needed
- **LLM:** DeepSeek at ~$0.14/M input tokens, $0.28/M output tokens
- **Hosting:** Cloudflare Workers free tier (100K requests/day) or $5/mo paid

Typical cost per research call: **$0.001 - $0.01** depending on how many searches/pages the agent needs.

## License

MIT

---

*Ferret is an open-source alternative to Claygent, Clay's AI web research agent. If you're looking for a self-hosted Claygent replacement that works with any LLM, any search API, and any scraper — this is it.*
