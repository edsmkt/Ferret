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
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}

// Cap is generous (40K) because pages are cached per-request and the model
// reads them in 8K windows via the fetch_page offset parameter.
function htmlToText(html, cap = 40000) {
  return unesc(
    html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<(nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s+/g, " ").trim().slice(0, cap);
}

function stripMd(md, cap = 40000) {
  return unesc(md).replace(/\s+/g, " ").trim().slice(0, cap);
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
      return { text, status: r.status };
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
      return text;
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
    return `(page unavailable: ${url} returned HTTP ${status} — it does not exist or requires login. Do NOT retry this URL, try a different one)`;
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
const PAGE_WINDOW = 8000;

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
          offset: { type: "integer", description: "Character offset to continue reading a long page. The first call returns chars 0-8000; if the result says the page continues, call again with the suggested offset." },
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
    const res = (await webSearch(q, env, 6, log)).slice(0, 6000);
    caches.searches.set(key, res);
    return { content: res, cached: false };
  }

  const url = (args.url || "").trim();
  const key = url.replace(/[?#]+$/, "").replace(/\/+$/, "");
  const offset = Math.max(0, Math.floor(+args.offset || 0));
  let full;
  const cached = caches.pages.has(key);
  if (cached) {
    full = caches.pages.get(key);
    if (log) log.push({ step: "fetch_page", url, via: "cache", status: 200, cost: 0, ...(offset && { offset }) });
  } else {
    full = await fetchPage(url, env, log);
    caches.pages.set(key, full);
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

// Walks required fields (including nested objects and arrays of objects)
// and returns dotted paths of anything missing, null, or empty-string.
function findMissingFields(schema, obj, path = "") {
  const missing = [];
  if (!schema || typeof obj !== "object" || obj === null || Array.isArray(obj)) return missing;
  const props = schema.properties || {};
  const req = new Set(schema.required || []);

  for (const k of req) {
    const v = obj[k];
    if (v === undefined || ((v === null || v === "") && !allowsNull(props[k]))) {
      missing.push(path + k);
    }
  }
  for (const [k, def] of Object.entries(props)) {
    const v = obj[k];
    if (def.type === "object" && def.properties && v && typeof v === "object" && !Array.isArray(v)) {
      missing.push(...findMissingFields(def, v, path + k + "."));
    } else if (def.type === "array" && def.items?.type === "object" && def.items.properties && Array.isArray(v)) {
      v.forEach((item, i) => missing.push(...findMissingFields(def.items, item, `${path}${k}[${i}].`)));
    }
  }
  return missing;
}

// --- Build the system prompt ---
function buildSystemPrompt(userPrompt, schema) {
  let sys = `CRITICAL: Output ONLY a valid JSON object with actual concrete values. Never output type descriptions, schema notation, or placeholder text — only real data.\n\n`;
  sys += userPrompt;
  if (schema) {
    sys += `\n\n${renderSchema(schema)}`;
  }
  sys += `\n\nYou have two tools available:\n- fetch_page: fetch any URL and get its text content (handles proxying and JS rendering automatically; long pages can be paged through with the offset parameter — cached re-reads are free)\n- web_search: Google search\n\nUse them as needed to gather the information required. Don't repeat a search you already ran. If the task restricts scope (e.g. "check only this page", "do not search", "only do X"), follow that restriction EXACTLY — do not take extra steps beyond what was asked. When you have enough, return your final JSON response.`;
  return sys;
}

// --- Main research loop ---
async function research(input, env) {
  const MAX = +(env.MAX_FETCHES || 8);
  const MODEL = env.MODEL || "deepseek-chat";
  const MT = +(env.MAX_TOKENS || 4000);
  const agentLog = [];
  const caches = { pages: new Map(), searches: new Map() };

  // Optional deadline: wrap up early so callers with HTTP timeouts (Clay ~30-60s)
  // get a result instead of a timeout. Reserve time for the final LLM call.
  const started = Date.now();
  const deadline = Math.max(0, +input.deadline_ms || 0);
  const reserve = deadline ? Math.min(12000, Math.floor(deadline * 0.4)) : 0;
  const timeUp = () => deadline > 0 && Date.now() - started > deadline - reserve;

  const systemPrompt = buildSystemPrompt(input.prompt, input.schema);

  let msgs = [
    { role: "system", content: systemPrompt },
    { role: "user", content: "Begin your research and return the JSON result." },
  ];

  agentLog.push({ step: "llm_call", round: 1, note: "initial" });
  let d = await deepseek({ model: MODEL, max_tokens: MT, messages: msgs, tools: TOOLS }, env);
  let fetches = 0;
  let schemaRetried = false;

  const creditsTotal = () => agentLog.filter(e => e.cost).reduce((t, e) => t + e.cost, 0);

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
      continue;
    }

    const raw = m.content || "";
    const result = parseJson(raw);
    const isEmpty = Object.keys(result).length === 0;

    // One cheap retry if required fields are missing — the difference between
    // "usually works" and dependable on a 10K-row table.
    if (isJsonSchema(input.schema) && !schemaRetried) {
      const missing = findMissingFields(input.schema, result);
      if (missing.length && !isEmpty) {
        schemaRetried = true;
        agentLog.push({ step: "schema_retry", missing_fields: missing.slice(0, 20) });
        msgs.push(m);
        msgs.push({ role: "user", content: `Your JSON is missing or has empty required fields: ${missing.join(", ")}. Return the COMPLETE corrected JSON object with every required field filled in. If data for a field is truly unavailable, use your best inference or state "not found" — but the field must be present. Output ONLY the JSON object.` });
        d = await deepseek({ model: MODEL, max_tokens: MT, messages: msgs, response_format: { type: "json_object" } }, env);
        continue;
      }
    }

    const missingFinal = isJsonSchema(input.schema) ? findMissingFields(input.schema, result) : [];
    agentLog.push({
      step: "done", rounds_total: round + 1, fetches_used: fetches,
      ...(isEmpty && { raw_content: raw.slice(0, 500) }),
      ...(missingFinal.length && { missing_fields: missingFinal.slice(0, 20) }),
    });
    return {
      result,
      agent_log: agentLog,
      scrape_credits_total: creditsTotal(),
      model: MODEL,
    };
  }

  const finalRaw = d.choices?.[0]?.message?.content || "";
  const finalResult = parseJson(finalRaw);
  const isEmpty = Object.keys(finalResult).length === 0;
  agentLog.push({ step: "max_rounds_hit", fetches_used: fetches, ...(isEmpty && { raw_content: finalRaw.slice(0, 500) }) });
  return {
    result: finalResult,
    agent_log: agentLog,
    scrape_credits_total: creditsTotal(),
    model: MODEL,
  };
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
