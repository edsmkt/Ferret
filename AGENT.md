# AGENT.md — Customization Guide

This file is for AI coding agents (Claude Code, Cursor, Copilot, etc.) helping you customize Ferret. It explains the architecture so your agent can swap any provider without breaking the tool-calling loop.

## Setup Guide (for helping users deploy)

When a user asks you to help them set up Ferret, walk them through these steps:

### 1. Cloudflare account + Wrangler

```bash
# Install Wrangler CLI
npm install -g wrangler

# Login (opens browser)
wrangler login

# Verify — this shows account ID
wrangler whoami
```

Account ID is needed for Browser Rendering (optional). It's in the `wrangler whoami` output or the dashboard URL: `dash.cloudflare.com/<account-id>/...`

### 2. Get API keys

The user needs at minimum:
- **LLM API key** — from DeepSeek, OpenRouter, OpenAI, Groq, Together, or Mistral. See the LLM swap table below for URLs.
- **Search API key** — from RapidAPI. Sign up at rapidapi.com, subscribe to a Google Search provider, get the key from Apps → default-application → Authorization.

Optional:
- **scrape.do token** — sign up at scrape.do, free tier gives 1,000 requests for testing
- **CF Browser Rendering** — requires Workers paid plan ($5/mo). Create a custom API token at Cloudflare dashboard → My Profile → API Tokens with "Account → Browser Rendering → Edit" permission.

### 3. Configure secrets

```bash
# Create .dev.vars for local development
cat > .dev.vars << 'EOF'
DEEPSEEK_API_KEY=sk-your-key
RAPIDAPI_KEY=your-rapidapi-key
SCRAPE_DO_TOKEN=your-token
EOF

# For production, use wrangler secret put:
wrangler secret put DEEPSEEK_API_KEY
wrangler secret put RAPIDAPI_KEY
wrangler secret put SCRAPE_DO_TOKEN
wrangler secret put WORKER_AUTH          # optional — protect the endpoint
```

### 4. Tune MAX_FETCHES — ask the user

`MAX_FETCHES` (default **10**) is the agent's tool-call budget per request: how many searches + page fetches it may spend before it must answer. It is the main depth-vs-cost dial, so **don't silently keep the default — ask the user about their workload** before deploying. Cached re-reads are free and don't count against it.

Ask something like:

> "Ferret caps how many searches and page fetches the agent can make per request (`MAX_FETCHES`, default 10). What will most of your requests look like?
> - **Quick lookups** (find a pricing page, check one fact) → 5 is plenty, runs faster and cheaper
> - **Standard research** (qualify a company, find pricing + case studies) → the default 10 fits
> - **Deep research** (multi-criteria ICP scoring, tech stack audits) → 12–15, and raise `deadline_ms` to match
>
> Also: are you on the Workers free tier? It allows 50 subrequests per invocation, so use 5 there."

Context for the recommendation you give:

| Workload | MAX_FETCHES | Why |
|----------|-------------|-----|
| Quick lookups | 5 | Most answers land in 1–4 fetches; a lower cap stops a confused run sooner |
| Standard GTM research | 10 (default) | Enough for search → navigate → verify on 2–3 pages, with room to recover from dead URLs |
| Deep research | 12–15 | More criteria = more pages; pair with `deadline_ms` ≥ 90000 or the deadline cuts the run first |
| Workers free tier | 5 | 50-subrequest limit per invocation — a worst-case cascade run can exceed it at 10 |

Each fetch costs LLM input tokens (the page content enters the conversation) and possibly scraping credits, so a higher cap raises worst-case cost per row — that matters at 10K-row table scale. The deadline (default 120s) and MAX_FETCHES interact: whichever runs out first ends the research.

Set it in `wrangler.toml` under `[vars]`, or leave the default.

### 5. Deploy

```bash
# Test locally first
wrangler dev

# Deploy to Cloudflare edge
wrangler deploy
```

The worker URL will be `https://ferret.<subdomain>.workers.dev`. Test with:

```bash
curl -X POST https://ferret.<subdomain>.workers.dev \
  -H "Content-Type: application/json" \
  -d '{"prompt": "What does Cloudflare do?", "schema": {"answer": "string"}}'
```

---

## Architecture

```
worker.js (single file, ~350 lines)
│
├── Entry point: export default { fetch() }
│   └── Validates input (needs "prompt"), calls research()
│
├── research() — Main agent loop
│   ├── Builds system prompt from user's prompt + schema
│   ├── Calls LLM with tools: [fetch_page, web_search]
│   ├── Loops: if LLM calls a tool → execute it → feed result back → call LLM again
│   ├── Stops when: LLM returns JSON (no tool calls), MAX_FETCHES hit, or deadline_ms near
│   ├── Validates result against schema (required fields, types, enums) → one retry round
│   ├── Compacts old tool results (>4 rounds back truncated to 2K chars) to cap input tokens
│   ├── On error: returns partial agent_log + error field instead of throwing
│   └── Returns { result, sources, agent_log, scrape_credits_total, tokens_in, tokens_out, duration_ms, model }
│
├── execTool() — Tool dispatcher + per-request cache
│   ├── "web_search" → webSearch() — exact-match query cache
│   ├── "fetch_page" → fetchPage() — URL cache, 8K-char windows via offset param
│   └── Returns { content, cached } — cached calls don't count against MAX_FETCHES
│
├── webSearch() — Google search (currently RapidAPI, swappable)
│
├── fetchPage() — Tiered page fetching
│   ├── Tier 1: nativeFetch() — free Cloudflare edge fetch
│   ├── Tier 2: cfBrowserFetch() — CF Browser Rendering API
│   └── Tier 3-5: scrapeDo() — scrape.do standard/render/super
│
├── LLM call function — currently deepseek(), swappable to any provider
│
└── Schema rendering (renderSchema, renderSchemaField)
    └── Converts JSON Schema to human-readable field descriptions for the LLM
```

## Three things you can swap

Everything is in `worker.js`. Each swap is one function replacement:

| Component | Function to replace | Contract |
|-----------|-------------------|----------|
| **Search** | `webSearch()` | Takes a query, returns numbered text results |
| **Scraping** | `fetchPage()` cascade | Takes a URL, returns plain text |
| **LLM** | `deepseek()` | Takes OpenAI-compatible payload, returns `choices[0].message` |

---

## How to Swap the LLM

Ferret works with **any LLM that supports tool calling and JSON output** via an OpenAI-compatible API. The `deepseek()` function is a simple HTTP call — change the URL and API key for any provider.

### Requirements

The LLM must support:
1. **Tool calling** — `tools` parameter with function definitions, model returns `tool_calls`
2. **JSON mode** — `response_format: { type: "json_object" }` for the final answer

### Drop-in replacements

Every provider below uses the same OpenAI-compatible format. To swap, change the URL, header, and env var name:

```js
// The function signature stays the same — only the internals change
async function llmCall(payload, env) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(LLM_URL, {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.YOUR_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error("llm " + r.status);
      return await r.json();
    } catch (e) {
      if (a === 3) throw e;
      await new Promise(s => setTimeout(s, 2 ** a * 500));
    }
  }
}
```

| Provider | URL | API Key Env Var | Recommended Model |
|----------|-----|-----------------|-------------------|
| DeepSeek (default) | `https://api.deepseek.com/chat/completions` | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1/chat/completions` | `OPENAI_API_KEY` | `gpt-4o-mini` |
| Groq | `https://api.groq.com/openai/v1/chat/completions` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| Together | `https://api.together.xyz/v1/chat/completions` | `TOGETHER_API_KEY` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-4` |
| Mistral | `https://api.mistral.ai/v1/chat/completions` | `MISTRAL_API_KEY` | `mistral-large-latest` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | `GEMINI_API_KEY` | `gemini-2.5-flash` |

After swapping, update `MODEL` in `wrangler.toml` and rename `deepseek()` calls to `llmCall()` in `research()`.

---

## How to Swap the Search Provider

Replace the `webSearch()` function. It must:
1. Accept `(query, env, n, log)` — query string, env bindings, max results, agent log array
2. Return a **string** of search results (the LLM reads this as plain text)
3. Push a log entry to `log` with `{ step: "web_search", query, via, status, cost }`

### Current implementation (RapidAPI)

```js
async function webSearch(q, env, n = 6, log = null) {
  const r = await fetch("https://google-search122.p.rapidapi.com/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-rapidapi-host": "google-search122.p.rapidapi.com",
      "x-rapidapi-key": env.RAPIDAPI_KEY,
    },
    body: JSON.stringify({
      actor: "scraper.google.search",
      input: { q, hl: "en", gl: "us" },
    }),
  });
  // ... parse organic_results, format as numbered text list
}
```

### Drop-in: Serper.dev

```js
async function webSearch(q, env, n = 6, log = null) {
  try {
    const r = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": env.SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q, num: n }),
    });
    if (log) log.push({ step: "web_search", query: (q || "").slice(0, 120), via: "serper", status: r.status, cost: 0 });
    if (!r.ok) return "(search failed: " + r.status + ")";
    const d = await r.json();
    const res = (d.organic || []).slice(0, n);
    return res.length
      ? res.map((x, i) => `${i + 1}. ${x.title} - ${x.link}\n   ${x.snippet || ""}`).join("\n")
      : "(no results)";
  } catch (e) {
    if (log) log.push({ step: "web_search", query: (q || "").slice(0, 120), via: "serper", status: 0, error: String(e).slice(0, 80) });
    return `(search failed: ${e})`;
  }
}
```

### Drop-in: Scrapingdog

```js
async function webSearch(q, env, n = 6, log = null) {
  try {
    const r = await fetch(
      `https://api.scrapingdog.com/google/?api_key=${env.SCRAPINGDOG_KEY}&query=${encodeURIComponent(q)}&results=${n}&country=us`
    );
    if (log) log.push({ step: "web_search", query: (q || "").slice(0, 120), via: "scrapingdog", status: r.status, cost: 0 });
    if (!r.ok) return "(search failed: " + r.status + ")";
    const d = await r.json();
    const res = (d.organic_results || []).slice(0, n);
    return res.length
      ? res.map((x, i) => `${i + 1}. ${x.title} - ${x.link}\n   ${x.snippet || ""}`).join("\n")
      : "(no results)";
  } catch (e) {
    if (log) log.push({ step: "web_search", query: (q || "").slice(0, 120), via: "scrapingdog", status: 0, error: String(e).slice(0, 80) });
    return `(search failed: ${e})`;
  }
}
```

### Key rule

The return value is **plain text** that gets fed into the LLM's conversation. Format it as a numbered list with title, URL, and snippet. The LLM uses the URLs to decide what to `fetch_page` next.

---

## How to Swap the Page Scraper

The `fetchPage()` function is a cascade. To add or replace a tier, edit `fetchPage()`:

```js
async function fetchPage(url, env, log) {
  // Tier 1: Native fetch (free, always available)
  // Returns { text, status } — the status drives the hard-stop below
  const { text: nativeText, status } = await nativeFetch(url, log);
  if (nativeText) return nativeText;

  // Hard stop on 404/410/401 — the page doesn't exist or needs login;
  // escalating to paid tiers can't fix that. KEEP THIS when editing the
  // cascade, it's the main credit-leak guard.
  if (status === 404 || status === 410 || status === 401) {
    return `(page unavailable: ${url} returned HTTP ${status} — do NOT retry this URL)`;
  }

  // Tier 2: Your custom scraper here
  let text = await yourScraper(url, env, log);
  if (text) return text;

  // Tier 3+: Fallbacks...
  return `(could not fetch ${url})`;
}
```

Note: `fetchPage()` returns up to 40K chars; `execTool()` caches the full text per-request and serves it to the LLM in 8K-char windows (the `offset` tool parameter). Failure strings are cached too, so the agent can't re-burn the cascade on a dead URL.

Each scraper function must:
1. Accept `(url, env, log)`
2. Return a **text string** (stripped of HTML) or empty string `""` if it failed
3. Push a log entry: `{ step: "fetch_page", url, via: "your-scraper", status, cost, chars }`

### Drop-in: ScrapingBee

```js
async function scrapingBeeFetch(url, env, log) {
  try {
    const r = await fetch(
      `https://app.scrapingbee.com/api/v1/?api_key=${env.SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=false`
    );
    if (!r.ok) {
      if (log) log.push({ step: "fetch_page", url, via: "scrapingbee", status: r.status, cost: 0, note: "failed" });
      return "";
    }
    const html = await r.text();
    const text = htmlToText(html);
    if (text.length > 100) {
      if (log) log.push({ step: "fetch_page", url, via: "scrapingbee", status: r.status, cost: 1, chars: text.length });
      return text;
    }
    if (log) log.push({ step: "fetch_page", url, via: "scrapingbee", status: r.status, cost: 1, note: `thin (${text.length} chars)` });
    return "";
  } catch (e) {
    if (log) log.push({ step: "fetch_page", url, via: "scrapingbee", status: 0, error: String(e).slice(0, 80) });
    return "";
  }
}
```

### Drop-in: Zenrows

```js
async function zenrowsFetch(url, env, log) {
  try {
    const r = await fetch(
      `https://api.zenrows.com/v1/?apikey=${env.ZENROWS_KEY}&url=${encodeURIComponent(url)}`
    );
    if (!r.ok) {
      if (log) log.push({ step: "fetch_page", url, via: "zenrows", status: r.status, cost: 0, note: "failed" });
      return "";
    }
    const html = await r.text();
    const text = htmlToText(html);
    if (text.length > 100) {
      if (log) log.push({ step: "fetch_page", url, via: "zenrows", status: r.status, cost: 1, chars: text.length });
      return text;
    }
    return "";
  } catch (e) {
    if (log) log.push({ step: "fetch_page", url, via: "zenrows", status: 0, error: String(e).slice(0, 80) });
    return "";
  }
}
```

---

## Environment Variables Reference

| Variable | Used By | Required |
|----------|---------|----------|
| `DEEPSEEK_API_KEY` | `deepseek()` | Yes (or swap LLM) |
| `RAPIDAPI_KEY` | `webSearch()` | Yes (or swap search) |
| `SCRAPE_DO_TOKEN` | `scrapeDo()` | No (fallback scraper) |
| `CF_ACCOUNT_ID` | `cfBrowserFetch()` | No (CF Browser Rendering) |
| `CF_API_TOKEN` | `cfBrowserFetch()` | No (CF Browser Rendering) |
| `WORKER_AUTH` | Entry point | No (endpoint protection) |
| `MODEL` | `research()` | No (default: deepseek-chat) |
| `MAX_FETCHES` | `research()` | No (default: 10 — see "Tune MAX_FETCHES" above) |
| `MAX_TOKENS` | `research()` | No (default: 4000) |

When you swap a provider, add its API key as a new env var and update the function to read from `env.YOUR_NEW_KEY`.
