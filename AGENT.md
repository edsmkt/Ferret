# AGENT.md — Customization Guide

This file is for AI coding agents (Claude Code, Cursor, Copilot, etc.) helping you customize Ferret. It explains the architecture so your agent can swap providers without breaking the tool-calling loop.

## Architecture

```
worker.js (single file, ~350 lines)
│
├── Entry point: export default { fetch() }
│   └── Validates input, calls research()
│
├── research() — Main agent loop
│   ├── Builds system prompt from user's prompt + schema
│   ├── Calls DeepSeek with tools: [fetch_page, web_search]
│   ├── Loops: if DeepSeek calls a tool → execute → feed result back
│   ├── Stops when: DeepSeek returns JSON (no tool calls) or MAX_FETCHES hit
│   └── Returns { result, agent_log, scrape_credits_total }
│
├── execTool() — Tool dispatcher
│   ├── "web_search" → webSearch()
│   └── "fetch_page" → fetchPage()
│
├── webSearch() — Google search
│   └── Currently: RapidAPI Google Search
│
├── fetchPage() — Tiered page fetching
│   ├── Tier 1: nativeFetch() — free CF edge fetch
│   ├── Tier 2: cfBrowserFetch() — CF Browser Rendering API
│   └── Tier 3-5: scrapeDo() — scrape.do standard/render/super
│
├── deepseek() — LLM API call with retry
│
└── Schema rendering (renderSchema, renderSchemaField)
    └── Converts JSON Schema to human-readable field descriptions for the LLM
```

## How to Swap the Search Provider

Replace the `webSearch()` function. It must:
1. Accept `(query, env, n, log)` — query string, env bindings, max results, agent log array
2. Return a string of search results (the LLM reads this as text)
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
  // ... parse organic_results, format as text
}
```

### To swap to Serper.dev

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

Then add `SERPER_API_KEY` to `.dev.vars` and `wrangler secret put SERPER_API_KEY`.

### To swap to Scrapingdog

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

## How to Swap the Page Scraper

The `fetchPage()` function is a cascade. To add or replace a tier, edit `fetchPage()`:

```js
async function fetchPage(url, env, log) {
  // Tier 1: Native fetch (free, always available)
  let text = await nativeFetch(url, log);
  if (text) return text;

  // Tier 2: Your custom scraper here
  text = await yourScraper(url, env, log);
  if (text) return text;

  // Tier 3+: Fallbacks...
  return `(could not fetch ${url})`;
}
```

Each scraper function must:
1. Accept `(url, env, log)`
2. Return a **text string** (stripped of HTML) or empty string `""` if it failed
3. Push a log entry: `{ step: "fetch_page", url, via: "your-scraper", status, cost, chars }`

### To add ScrapingBee

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

## How to Swap the LLM

Replace `deepseek()` and update the payload format. The function must:
1. Accept an OpenAI-compatible chat completion payload
2. Return the response JSON with `choices[0].message`
3. Support `tools` (function calling) and `response_format: { type: "json_object" }`

### To use OpenAI

```js
async function llmCall(payload, env) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error("openai " + r.status);
      return await r.json();
    } catch (e) {
      if (a === 3) throw e;
      await new Promise(s => setTimeout(s, 2 ** a * 500));
    }
  }
}
```

Then update the `MODEL` env var to `gpt-4o-mini` or whatever model you want, and rename `deepseek()` calls to `llmCall()`.

DeepSeek uses the OpenAI-compatible API format, so most providers (OpenAI, Groq, Together, OpenRouter) are drop-in replacements — just change the URL and API key.

## Environment Variables Reference

| Variable | Used By | Required |
|----------|---------|----------|
| `DEEPSEEK_API_KEY` | `deepseek()` | Yes |
| `RAPIDAPI_KEY` | `webSearch()` | Yes (or swap provider) |
| `SCRAPE_DO_TOKEN` | `scrapeDo()` | No (fallback scraper) |
| `CF_ACCOUNT_ID` | `cfBrowserFetch()` | No (CF Browser Rendering) |
| `CF_API_TOKEN` | `cfBrowserFetch()` | No (CF Browser Rendering) |
| `WORKER_AUTH` | Entry point | No (endpoint protection) |
| `MODEL` | `research()` | No (default: deepseek-chat) |
| `MAX_FETCHES` | `research()` | No (default: 8) |
| `MAX_TOKENS` | `research()` | No (default: 4000) |
