/** General-purpose web research agent — Cloudflare Worker (DeepSeek).
 *
 *  POST {
 *    "prompt": "Research Acme GmbH and classify them...",
 *    "schema": { ... },        // JSON Schema or example shape you want back
 *    "deadline_ms": 45000      // optional — agent wraps up early to answer before this
 *  }
 *
 *  fetch_page cascade: native fetch (free) → CF Browser Rendering (browser seconds) → scrape.do (credits).
 *  Returns { "result": {…}, "agent_log": [...steps taken...], "scrape_credits_total": N }
 */

// --- Helpers ---
function jsonResp(obj, s = 200) {
  return new Response(JSON.stringify(obj), {
    status: s,
    headers: {
      "content-type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-worker-key",
    },
  });
}

function parseJson(s) {
  s = (s || "").trim();
  if (s.startsWith("```")) s = s.replace(/^```\w*|```$/g, "").trim();
  try { return JSON.parse(s); } catch (e) {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    return {};
  }
}

function unesc(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Cap is generous (300K chars ≈ 75K tokens — bigger than almost any real
// page's visible text) because pages are cached per-request and the model
// reads them in PAGE_WINDOW slices via the
// fetch_page offset parameter. DeepSeek's 1M-token context and cheap input
// pricing make big windows affordable; compaction keeps old reads small.
// If you swap to a smaller-context LLM (most are 128K-210K), shrink
// PAGE_WINDOW and these caps to match.
function htmlToText(html, cap = 300000) {
  return unesc(
    html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<(nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim().slice(0, cap);
}

function stripMd(md, cap = 300000) {
  return unesc(md).replace(/\s+/g, " ").trim().slice(0, cap);
}

// Same-domain links from raw HTML, so the agent can navigate a site instead
// of guessing paths (htmlToText strips hrefs entirely).
function extractLinks(html, baseUrl, max = 25) {
  const out = new Set();
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  const re = /<a[^>]+href=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) && out.size < max) {
    try {
      const u = new URL(unesc(m[1]), base);
      if (u.host === base.host && /^https?:$/.test(u.protocol)) {
        u.hash = "";
        if (u.href !== base.href) out.add(u.href);
      }
    } catch {}
  }
  return [...out];
}

function withLinks(text, html, url) {
  const links = extractLinks(html, url);
  return links.length ? `${text}\n\nLINKS ON THIS PAGE (same site):\n${links.join("\n")}` : text;
}

// --- Tier 1: Native fetch from Cloudflare edge (free) ---
// Returns { text, status } — the status lets the cascade stop on hard 404/410
// instead of burning paid tiers on a page that doesn't exist.
async function nativeFetch(url, log) {
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; research-agent/1.0)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,de;q=0.8",
      },
      cf: { cacheTtl: 0 },
      redirect: "follow",
    });
    if (!r.ok) {
      if (log) log.push({ step: "fetch_page", url, via: "native", status: r.status, cost: 0, note: "failed" });
      return { text: "", status: r.status };
    }
    const html = await r.text();
    const text = htmlToText(html);
    if (text.length > 100) {
      if (log) log.push({ step: "fetch_page", url, via: "native", status: r.status, cost: 0, chars: text.length });
      return { text: withLinks(text, html, url), status: r.status };
    }
    if (log) log.push({ step: "fetch_page", url, via: "native", status: r.status, cost: 0, note: `thin (${text.length} chars)` });
    return { text: "", status: r.status };
  } catch (e) {
    if (log) log.push({ step: "fetch_page", url, via: "native", status: 0, cost: 0, error: String(e).slice(0, 80) });
    return { text: "", status: 0 };
  }
}

// --- Tier 2: Cloudflare Browser Rendering /content (browser seconds, no scrape.do credits) ---
async function cfBrowserFetch(url, env, log) {
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) return "";
  try {
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/content`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.CF_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url,
          rejectResourceTypes: ["image", "media", "font", "stylesheet"],
          // networkidle2 instead of domcontentloaded — client-rendered SPAs
          // haven't painted content yet at domcontentloaded
          gotoOptions: { waitUntil: "networkidle2", timeout: 20000 },
        }),
      }
    );
    if (!r.ok) {
      if (log) log.push({ step: "fetch_page", url, via: "cf-browser", status: r.status, cost: 0, note: "failed" });
      return "";
    }
    const html = await r.text();
    const text = htmlToText(html);
    if (text.length > 100) {
      if (log) log.push({ step: "fetch_page", url, via: "cf-browser", status: r.status, cost: 0, chars: text.length });
      return withLinks(text, html, url);
    }
    if (log) log.push({ step: "fetch_page", url, via: "cf-browser", status: r.status, cost: 0, note: `thin (${text.length} chars)` });
    return "";
  } catch (e) {
    if (log) log.push({ step: "fetch_page", url, via: "cf-browser", status: 0, cost: 0, error: String(e).slice(0, 80) });
    return "";
  }
}

// --- Tier 3: scrape.do (markdown mode, paid fallback) ---
async function scrapeDo(url, env, mode = "standard", log = null) {
  if (!env.SCRAPE_DO_TOKEN) return [0, ""];
  try {
    let u = `https://api.scrape.do/?token=${env.SCRAPE_DO_TOKEN}&url=${encodeURIComponent(url)}&output=markdown`;
    if (mode === "render") u += "&render=true";
    if (mode === "super") u += "&render=true&super=true";
    const r = await fetch(u, { cf: { cacheTtl: 0 } });
    const cost = +(r.headers.get("scrape.do-request-cost") || 0);
    const remaining = +(r.headers.get("scrape.do-remaining-credits") || 0);
    if (log) log.push({ step: "fetch_page", url, via: `scrape.do(${mode})`, status: r.status, cost, remaining });
    return [r.status, r.ok ? await r.text() : ""];
  } catch (e) {
    if (log) log.push({ step: "fetch_page", url, via: `scrape.do(${mode})`, status: 0, cost: 0, error: String(e).slice(0, 80) });
    return [0, ""];
  }
}

// --- Tiered fetch: native → CF Browser Rendering → scrape.do ---
async function fetchPage(url, env, log) {
  // 1. Native fetch (free)
  const { text: nativeText, status } = await nativeFetch(url, log);
  if (nativeText) return nativeText;

  // Hard stop statuses — escalating won't help: 404/410 the page doesn't
  // exist, 401 it needs credentials proxies can't provide (Notion also uses
  // 401 for nonexistent pages). Blocked (403/429) and thin pages still
  // escalate below, since proxies and rendering do fix those.
  if (status === 404 || status === 410 || status === 401) {
    let host = "", origin = "";
    try { const u = new URL(url); host = u.host; origin = u.origin; } catch {}
    return `(page unavailable: ${url} returned HTTP ${status} — it does not exist or requires login. Do NOT retry this exact URL. Your goal is the INFORMATION, not this page. Recover in this order: 1) find the live page on the same site — web_search "site:${host} <what you're looking for>" or fetch ${origin} and follow the links listed at the end of its content; 2) only if the site itself doesn't have it, use another reliable source — but third-party data is often OUTDATED (pricing and plans change), so prefer the company's own pages.)`;
  }

  // 2. Cloudflare Browser Rendering (browser seconds, handles JS)
  let text = await cfBrowserFetch(url, env, log);
  if (text) return text;

  // 3. scrape.do standard (1 credit)
  let body;
  [, body] = await scrapeDo(url, env, "standard", log);
  text = stripMd(body);
  if (text.length > 100) return text;

  // 4. scrape.do render (5 credits)
  [, body] = await scrapeDo(url, env, "render", log);
  text = stripMd(body);
  if (text.length > 100) return text;

  // 5. scrape.do super (25 credits) — last resort
  [, body] = await scrapeDo(url, env, "super", log);
  text = stripMd(body);
  if (text.length > 100) return text;

  return `(could not fetch ${url} — all methods failed)`;
}

// --- Web search (RapidAPI Google Search) ---
async function webSearch(q, env, n = 6, log = null) {
  try {
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
    if (log) log.push({ step: "web_search", query: (q || "").slice(0, 120), via: "rapidapi", status: r.status, cost: 0 });
    if (!r.ok) return "(search failed: " + r.status + ")";
    const d = await r.json();
    const organic = d.organic_results || d.results || d.organic || [];
    const res = organic.slice(0, n);
    return res.length
      ? res.map((x, i) => `${i + 1}. ${x.title || ""} - ${x.link || x.url || ""}\n   ${x.snippet || x.description || ""}`).join("\n")
      : "(no results)";
  } catch (e) {
    if (log) log.push({ step: "web_search", query: (q || "").slice(0, 120), via: "rapidapi", status: 0, cost: 0, error: String(e).slice(0, 80) });
    return `(search failed: ${e})`;
  }
}

// --- Tool definitions given to the LLM ---
const PAGE_WINDOW = 16000;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "fetch_page",
      description: "Fetch a URL and return its visible text content. Automatically tries the fastest free method first, then falls back to proxy/rendering if needed. Pages are cached for this request — re-reading a page (e.g. with a different offset) is free and does not count against your tool budget.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL to fetch" },
          purpose: { type: "string", description: "One short sentence: what you are looking for on this page. Always provide it — it is recorded in the run log for auditing." },
          offset: { type: "integer", description: "Character offset to continue reading a long page. The first call returns chars 0-16000; if the result says the page continues, call again with the suggested offset." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Google search. Use to find websites, domains, company info, or research any topic.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
      },
    },
  },
];

// caches = { pages: Map<url, fullText>, searches: Map<query, results> } — per-request.
// Returns { content, cached }; cached calls don't count against the fetch budget.
async function execTool(name, args, env, log, caches) {
  if (name === "web_search") {
    const q = (args.query || "").trim();
    const key = q.toLowerCase().replace(/\s+/g, " ");
    if (caches.searches.has(key)) {
      if (log) log.push({ step: "web_search", query: q.slice(0, 120), via: "cache", status: 200, cost: 0 });
      return { content: "(note: you already ran this exact search — same results below, try a DIFFERENT query if these weren't enough)\n" + caches.searches.get(key), cached: true };
    }
    const res = (await webSearch(q, env, 6, log)).slice(0, 10000);
    caches.searches.set(key, res);
    return { content: res, cached: false };
  }

  const url = (args.url || "").trim();
  const key = url.replace(/[?#]+$/, "").replace(/\/+$/, "");
  const offset = Math.max(0, Math.floor(+args.offset || 0));
  const purpose = (args.purpose || "").slice(0, 200) || undefined;
  let full;
  const cached = caches.pages.has(key);
  if (cached) {
    full = caches.pages.get(key);
    if (log) log.push({ step: "fetch_page", url, via: "cache", status: 200, cost: 0, ...(purpose && { purpose }), ...(offset && { offset }) });
  } else {
    // Attach the model's stated intent to the first log entry this fetch
    // produces (the cascade pushes its own per-tier entries).
    const before = log ? log.length : 0;
    full = await fetchPage(url, env, log);
    caches.pages.set(key, full);
    if (log && purpose) {
      for (let i = before; i < log.length; i++) {
        if (log[i].step === "fetch_page") { log[i].purpose = purpose; break; }
      }
    }
  }

  if (offset >= full.length && offset > 0) {
    return { content: `(no content at offset ${offset} — the page is only ${full.length} chars)`, cached };
  }
  let content = full.slice(offset, offset + PAGE_WINDOW);
  if (full.length > offset + PAGE_WINDOW) {
    content += `\n…(page continues — ${full.length} chars total; call fetch_page with offset=${offset + PAGE_WINDOW} to read more, it's cached and free)`;
  }
  return { content, cached };
}

// --- DeepSeek API call with retry ---
async function deepseek(payload, env) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${env.DEEPSEEK_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error("deepseek " + r.status);
      return await r.json();
    } catch (e) {
      if (a === 3) throw e;
      await new Promise(s => setTimeout(s, 2 ** a * 500));
    }
  }
}

// --- Context compaction ---
// Tool results older than the last `keepLast` stay in context but truncated:
// the model has already extracted what it needed, and re-sending six 8K-char
// pages every round makes input tokens grow quadratically.
function compactOldToolResults(msgs, keepLast = 4, cap = 2000) {
  const toolIdxs = [];
  for (let i = 0; i < msgs.length; i++) if (msgs[i].role === "tool") toolIdxs.push(i);
  const old = toolIdxs.slice(0, Math.max(0, toolIdxs.length - keepLast));
  for (const i of old) {
    if (typeof msgs[i].content === "string" && msgs[i].content.length > cap) {
      msgs[i].content = msgs[i].content.slice(0, cap) + "\n…(older tool result truncated — re-fetch the URL if you need it again, cached re-reads are free)";
    }
  }
}

// --- Schema rendering ---
function isJsonSchema(obj) {
  return obj && (obj.type || obj.properties || obj.$schema);
}

function renderSchemaField(key, def, indent = "") {
  const parts = [];
  const req = def._required ? " (REQUIRED)" : "";
  const desc = def.description ? ` — ${def.description}` : "";

  if (def.type === "object" && def.properties) {
    parts.push(`${indent}- "${key}": object${req}${desc}`);
    const reqFields = new Set(def.required || []);
    for (const [k, v] of Object.entries(def.properties)) {
      parts.push(renderSchemaField(k, { ...v, _required: reqFields.has(k) }, indent + "  "));
    }
  } else if (def.type === "array" && def.items) {
    const itemDesc = def.items.type === "object" && def.items.properties
      ? "object[]" : `${def.items.type || "any"}[]`;
    parts.push(`${indent}- "${key}": ${itemDesc}${req}${desc}`);
    if (def.items.type === "object" && def.items.properties) {
      const reqFields = new Set(def.items.required || []);
      for (const [k, v] of Object.entries(def.items.properties)) {
        parts.push(renderSchemaField(k, { ...v, _required: reqFields.has(k) }, indent + "    "));
      }
    }
  } else {
    let constraint = "";
    if (def.enum) constraint = ` [one of: ${def.enum.join(", ")}]`;
    if (def.minimum !== undefined || def.maximum !== undefined) {
      constraint = ` [${def.minimum ?? ""}..${def.maximum ?? ""}]`;
    }
    parts.push(`${indent}- "${key}": ${def.type || "any"}${constraint}${req}${desc}`);
  }
  return parts.join("\n");
}

function renderSchema(schema) {
  if (!isJsonSchema(schema)) {
    return `You MUST return a JSON object matching this exact shape:\n${JSON.stringify(schema, null, 2)}`;
  }

  const lines = ["You MUST return a valid JSON object conforming to this schema:\n"];
  if (schema.description) lines.push(schema.description + "\n");

  const props = schema.properties || {};
  const reqFields = new Set(schema.required || []);
  for (const [k, v] of Object.entries(props)) {
    lines.push(renderSchemaField(k, { ...v, _required: reqFields.has(k) }));
  }

  if (schema.required?.length) {
    lines.push(`\nRequired fields: ${schema.required.join(", ")}`);
  }

  return lines.join("\n");
}

// --- Schema validation of the final result ---
function allowsNull(def) {
  if (!def) return false;
  if (def.nullable) return true;
  const t = def.type;
  return Array.isArray(t) ? t.includes("null") : t === "null";
}

function typeOk(def, v) {
  if (!def || !def.type) return true;
  const types = Array.isArray(def.type) ? def.type : [def.type];
  return types.some(t => {
    if (t === "null") return v === null;
    if (t === "string") return typeof v === "string";
    if (t === "number") return typeof v === "number" && Number.isFinite(v);
    if (t === "integer") return Number.isInteger(v);
    if (t === "boolean") return typeof v === "boolean";
    if (t === "array") return Array.isArray(v);
    if (t === "object") return v !== null && typeof v === "object" && !Array.isArray(v);
    return true;
  });
}

// Walks the schema (including nested objects and arrays of objects) and
// returns human-readable problems: missing required fields, wrong types,
// enum violations. Wrong types matter downstream — a Clay number column
// chokes on "about 120" where 120 was expected.
function findSchemaIssues(schema, obj, path = "") {
  const issues = [];
  if (!schema || typeof obj !== "object" || obj === null || Array.isArray(obj)) return issues;
  const props = schema.properties || {};
  const req = new Set(schema.required || []);

  for (const k of req) {
    const v = obj[k];
    if (v === undefined || ((v === null || v === "") && !allowsNull(props[k]))) {
      issues.push(`${path}${k}: missing required field`);
    }
  }
  for (const [k, def] of Object.entries(props)) {
    const v = obj[k];
    if (v === undefined || (v === null && allowsNull(def))) continue;
    if (!typeOk(def, v)) {
      issues.push(`${path}${k}: expected ${Array.isArray(def.type) ? def.type.join("|") : def.type}, got ${Array.isArray(v) ? "array" : typeof v} (${JSON.stringify(v).slice(0, 60)})`);
      continue;
    }
    if (def.enum && !def.enum.includes(v)) {
      issues.push(`${path}${k}: value ${JSON.stringify(v).slice(0, 60)} is not one of [${def.enum.join(", ")}]`);
    }
    if (def.type === "object" && def.properties && v && typeof v === "object" && !Array.isArray(v)) {
      issues.push(...findSchemaIssues(def, v, path + k + "."));
    } else if (def.type === "array" && def.items?.type === "object" && def.items.properties && Array.isArray(v)) {
      v.forEach((item, i) => issues.push(...findSchemaIssues(def.items, item, `${path}${k}[${i}].`)));
    }
  }
  return issues;
}

// --- Build the system prompt ---
function buildSystemPrompt(userPrompt, schema) {
  let sys = `CRITICAL: Output ONLY a valid JSON object with actual concrete values. Never output type descriptions, schema notation, or placeholder text — only real data.\n\n`;
  sys += userPrompt;
  if (schema) {
    sys += `\n\n${renderSchema(schema)}`;
  }
  sys += `\n\nYou have two tools available:\n- fetch_page: fetch any URL and get its text content (handles proxying and JS rendering automatically; long pages can be paged through with the offset parameter — cached re-reads are free)\n- web_search: Google search\n\nUse them as needed to gather the information required. Don't repeat a search you already ran. Fetched pages end with a list of same-site links — use those to navigate to the page you need instead of guessing URLs. Be a problem solver: if a URL is dead, behind a login, or blocked, your goal is still the INFORMATION. Recover in this order: first find the live page on the SAME site (search "site:domain.com <topic>" or fetch the homepage and follow its links); only if the site itself doesn't have it, use another reliable source. Third-party sites (aggregators, review sites) are often OUTDATED for facts that change — pricing, plans, headcount — so verify on the company's own pages whenever reachable. A trustworthy secondary source beats giving up, but never beats the primary source. If your final answer includes URLs as data (a pricing page, a competitor's website), verify them when budget allows: fetch the page to confirm it is live and is what you claim — never output a guessed URL. If the task restricts scope (e.g. "check only this page", "do not search", "only do X"), follow that restriction EXACTLY — do not take extra steps beyond what was asked. When you have enough, return your final JSON response.`;
  return sys;
}

// --- Main research loop ---
async function research(input, env) {
  // Per-request override (clamped) — one deployed worker can serve both
  // light lookups and deep-research columns.
  const MAX = Math.min(20, Math.max(1, +input.max_fetches || +(env.MAX_FETCHES || 10)));
  const MODEL = env.MODEL || "deepseek-v4-flash";
  const MT = +(env.MAX_TOKENS || 8000);
  const agentLog = [];
  const caches = { pages: new Map(), searches: new Map() };

  // Deadline: wrap up early so callers with HTTP timeouts (Clay ~30-60s)
  // get a result instead of a timeout. Reserve time for the final LLM call.
  // Defaults to DEFAULT_DEADLINE_MS (120s) so a stuck run can't burn tokens
  // for minutes — pass deadline_ms: 0 to disable, or any value to override.
  const started = Date.now();
  const deadline = input.deadline_ms !== undefined
    ? Math.max(0, +input.deadline_ms || 0)
    : +(env.DEFAULT_DEADLINE_MS || 120000);
  const reserve = deadline ? Math.min(12000, Math.floor(deadline * 0.4)) : 0;
  const timeUp = () => deadline > 0 && Date.now() - started > deadline - reserve;

  const systemPrompt = buildSystemPrompt(input.prompt, input.schema);

  let msgs = [
    { role: "system", content: systemPrompt },
    { role: "user", content: "Begin your research and return the JSON result." },
  ];

  let fetches = 0;
  let schemaRetried = false;
  let emptyRetried = false;
  const usage = { in: 0, out: 0 };
  const addUsage = (d) => {
    usage.in += d?.usage?.prompt_tokens || 0;
    usage.out += d?.usage?.completion_tokens || 0;
  };

  const creditsTotal = () => agentLog.filter(e => e.cost).reduce((t, e) => t + e.cost, 0);
  // Pages the agent actually read (first fetch only — cache hits are repeats)
  const sources = () => [...new Set(agentLog.filter(e => e.step === "fetch_page" && e.chars > 0 && e.via !== "cache").map(e => e.url))];
  const finish = (result, extra = {}) => ({
    result,
    sources: sources(),
    agent_log: agentLog,
    scrape_credits_total: creditsTotal(),
    tokens_in: usage.in,
    tokens_out: usage.out,
    duration_ms: Date.now() - started,
    model: MODEL,
    ...extra,
  });

  // Everything below returns via finish() — including on error, so the
  // agent_log survives for debugging instead of being lost to the caller's catch.
  try {

  agentLog.push({ step: "llm_call", round: 1, note: "initial" });
  let d = await deepseek({ model: MODEL, max_tokens: MT, messages: msgs, tools: TOOLS }, env);
  addUsage(d);

  for (let round = 0; round < MAX + 2; round++) {
    const m = d.choices[0].message;

    if (m.tool_calls && m.tool_calls.length) {
      msgs.push(m);
      for (const tc of m.tool_calls) {
        let a = {};
        try { a = JSON.parse(tc.function.arguments || "{}"); } catch {}
        // Hard cap: the model can issue several tool calls per round, so
        // enforce the budget per-call, not per-round. Every tool_call id
        // still gets a tool message (the API requires it).
        if (fetches >= MAX || timeUp()) {
          msgs.push({
            role: "tool", tool_call_id: tc.id,
            content: timeUp()
              ? "(deadline reached — stop researching and return your final JSON now)"
              : "(tool budget exhausted — return your final JSON now)",
          });
          continue;
        }
        const { content, cached } = await execTool(tc.function.name, a, env, agentLog, caches);
        msgs.push({ role: "tool", tool_call_id: tc.id, content });
        if (!cached) fetches++;
      }

      compactOldToolResults(msgs);

      const wrapUp = fetches >= MAX || timeUp();
      const p = { model: MODEL, max_tokens: MT, messages: msgs };
      if (wrapUp) {
        msgs.push({ role: "user", content: "You have used all your tool calls. You MUST now return your final JSON response using the information you have gathered. Do NOT call any more tools. Output ONLY the JSON object." });
        p.response_format = { type: "json_object" };
      } else {
        p.tools = TOOLS;
      }
      agentLog.push({ step: "llm_call", round: round + 2, note: wrapUp ? (timeUp() ? "final (deadline)" : "final (tool budget spent)") : "continuing" });
      d = await deepseek(p, env);
      addUsage(d);
      continue;
    }

    const raw = m.content || "";
    const result = parseJson(raw);
    const isEmpty = Object.keys(result).length === 0;

    // Empty/garbled final answer (observed: whitespace-only output after a
    // budget-forced wrap-up) — one retry demanding the JSON.
    if (isEmpty && !emptyRetried) {
      emptyRetried = true;
      agentLog.push({ step: "empty_retry", raw_content: raw.slice(0, 200) });
      msgs.push(m);
      msgs.push({ role: "user", content: "Your last message was empty or not valid JSON. Output the complete JSON object now, using the information you have already gathered. Output ONLY the JSON object." });
      d = await deepseek({ model: MODEL, max_tokens: MT, messages: msgs, response_format: { type: "json_object" } }, env);
      addUsage(d);
      continue;
    }

    // One cheap retry if the result has schema problems (missing required
    // fields, wrong types, enum violations) — the difference between
    // "usually works" and dependable on a 10K-row table.
    if (isJsonSchema(input.schema) && !schemaRetried) {
      const issues = findSchemaIssues(input.schema, result);
      if (issues.length && !isEmpty) {
        schemaRetried = true;
        agentLog.push({ step: "schema_retry", issues: issues.slice(0, 20) });
        msgs.push(m);
        msgs.push({ role: "user", content: `Your JSON has these problems:\n${issues.map(i => "- " + i).join("\n")}\n\nReturn the COMPLETE corrected JSON object with every required field present and every value matching its declared type (numbers as numbers, not strings). If data for a field is truly unavailable, use your best inference or "not found" — but the field must be present and correctly typed. Output ONLY the JSON object.` });
        d = await deepseek({ model: MODEL, max_tokens: MT, messages: msgs, response_format: { type: "json_object" } }, env);
        addUsage(d);
        continue;
      }
    }

    const issuesFinal = isJsonSchema(input.schema) ? findSchemaIssues(input.schema, result) : [];
    agentLog.push({
      step: "done", rounds_total: round + 1, fetches_used: fetches,
      ...(isEmpty && { raw_content: raw.slice(0, 500) }),
      ...(issuesFinal.length && { schema_issues: issuesFinal.slice(0, 20) }),
    });
    return finish(result);
  }

  const finalRaw = d.choices?.[0]?.message?.content || "";
  const finalResult = parseJson(finalRaw);
  const isEmpty = Object.keys(finalResult).length === 0;
  agentLog.push({ step: "max_rounds_hit", fetches_used: fetches, ...(isEmpty && { raw_content: finalRaw.slice(0, 500) }) });
  return finish(finalResult);

  } catch (e) {
    agentLog.push({ step: "error", error: String(e).slice(0, 200) });
    return finish({}, { error: String(e).slice(0, 500) });
  }
}

// --- Worker entry point ---
export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, x-worker-key",
        },
      });
    }

    if (request.method !== "POST") return jsonResp({ error: "POST only" }, 405);
    if (env.WORKER_AUTH && request.headers.get("x-worker-key") !== env.WORKER_AUTH) {
      return jsonResp({ error: "unauthorized" }, 401);
    }

    let input;
    try { input = await request.json(); } catch { return jsonResp({ error: "invalid JSON body" }, 400); }
    if (!input.prompt) return jsonResp({ error: "prompt is required" }, 400);

    try {
      const out = await research(input, env);
      return jsonResp(out);
    } catch (e) {
      return jsonResp({ error: String(e).slice(0, 500), agent_log: [] }, 200);
    }
  },
};
