import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker.js";

const MCP = "https://search.parallel.ai/mcp";
const LLM = "https://api.deepseek.com/chat/completions";
const RAPIDAPI = "https://google-search122.p.rapidapi.com/";
const PAGE = "https://example.com/pricing?plan=team&region=us";
const search = query => ({ name: "web_search", arguments: JSON.stringify({ query }) });
const sample = { results: [{ title: "Pricing", url: PAGE, excerpts: ["The team plan costs $20."] }] };
const json = (body, headers = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });

// The model is scripted, so these tests prove dispatch and result consumption,
// not the quality of an LLM's tool choices. No ambient secrets are read.
async function run(t, { env = {}, rounds = [[search("example pricing")]], mcp, rapidapi, signal, observeModel } = {}) {
  const requests = [], modelRequests = [];
  let modelRound = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    const entry = { url, options, body };
    requests.push(entry);
    if (url === LLM) {
      modelRequests.push(body);
      observeModel?.(body);
      const calls = rounds[modelRound++];
      return json({ choices: [{ message: calls ? {
        role: "assistant", content: null,
        tool_calls: calls.map((fn, i) => ({ id: `call-${modelRound}-${i}`, type: "function", function: fn })),
      } : {
        role: "assistant", content: JSON.stringify({ evidence: body.messages.filter(m => m.role === "tool").map(m => m.content).join("\n") }),
      } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    }
    if (url === MCP) {
      const headers = new Headers(options.headers);
      assert.equal(headers.get("User-Agent"), "Ferret/1.0 (+https://github.com/edsmkt/Ferret)");
      assert.equal(headers.get("Accept"), "application/json, text/event-stream");
      assert.equal(headers.get("Authorization"), null);
      assert.equal(headers.get("x-api-key"), null);
      assert.equal(body.jsonrpc, "2.0");
      assert.ok(options.signal instanceof AbortSignal);
      if (body.method !== "initialize") {
        assert.equal(headers.get("MCP-Protocol-Version"), "2025-03-26");
        assert.equal(headers.get("Mcp-Session-Id"), "test-session");
      }
      const override = await mcp?.(entry);
      if (override) return override;
      if (body.method === "initialize") return json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-03-26" } }, { "mcp-session-id": "test-session" });
      if (body.method === "notifications/initialized") {
        assert.equal(body.id, undefined);
        return new Response(null, { status: 202 });
      }
      if (body.method === "tools/list") return json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "web_search" }, { name: "web_fetch" }] } });
      assert.equal(body.method, "tools/call");
      assert.equal(body.params.name, "web_search");
      assert.equal(body.params.arguments.model_name, env.MODEL || "deepseek-v4-flash");
      assert.deepEqual(body.params.arguments.search_queries, [body.params.arguments.objective]);
      assert.match(body.params.arguments.session_id, /^[a-f0-9-]{36}$/);
      return json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(sample) }] } });
    }
    if (url === RAPIDAPI) return rapidapi ? rapidapi(entry) : json({ organic_results: [{ title: "Google pricing", link: PAGE, snippet: "Existing provider" }] });
    assert.equal(url, PAGE);
    return new Response("<html><p>" + "The pricing page confirms the team plan costs $20. ".repeat(5) + "</p></html>");
  });
  const response = await worker.fetch(new Request("https://ferret.test/", {
    method: "POST", body: JSON.stringify({ prompt: "Find pricing", schema: { evidence: "string" } }), signal,
  }), { DEEPSEEK_API_KEY: "test-model-key", ...env });
  return { response, output: await response.json(), requests, modelRequests };
}

test("no search key: Worker search -> MCP -> model -> native page -> structured result", async t => {
  const r = await run(t, { rounds: [[search("example pricing")], [{ name: "fetch_page", arguments: JSON.stringify({ url: PAGE, purpose: "Verify pricing" }) }]] });
  assert.equal(r.response.status, 200);
  assert.match(r.output.result.evidence, /1\. Pricing - https:\/\/example.com\/pricing\?plan=team&region=us/);
  assert.match(r.output.result.evidence, /The team plan costs \$20/);
  assert.deepEqual(r.output.sources, [PAGE]);
  assert.equal(r.requests.filter(x => x.url === MCP).length, 4);
  assert.equal(r.output.agent_log.find(e => e.step === "web_search").via, "parallel");
  assert.equal(r.output.scrape_credits_total, 0);
  assert.match(r.modelRequests[1].messages.find(m => m.role === "tool").content, /Pricing/);
});

for (const env of [{ RAPIDAPI_KEY: "saved-key" }, { SEARCH_PROVIDER: "rapidapi", RAPIDAPI_KEY: "saved-key" }]) {
  test(`preserve RapidAPI choice ${JSON.stringify(env)}`, async t => {
    const r = await run(t, { env, rapidapi: ({ options, body }) => {
      assert.equal(options.headers["x-rapidapi-key"], "saved-key");
      assert.equal(body.input.q, "example pricing");
      return json({ organic_results: [{ title: "Google pricing", url: PAGE, description: "Existing provider" }] });
    } });
    assert.match(r.output.result.evidence, /Existing provider/);
    assert.ok(!r.requests.some(x => x.url === MCP));
  });
}

test("explicit Parallel overrides a saved RapidAPI key", async t => {
  const r = await run(t, { env: { SEARCH_PROVIDER: "parallel", RAPIDAPI_KEY: "saved-key" } });
  assert.match(r.output.result.evidence, /The team plan/);
  assert.ok(!r.requests.some(x => x.url === RAPIDAPI));
});

test("explicit RapidAPI failure does not fall back to Parallel", async t => {
  const r = await run(t, { env: { SEARCH_PROVIDER: "rapidapi" }, rapidapi: () => new Response(null, { status: 401 }) });
  assert.match(r.output.result.evidence, /search failed: 401/);
  assert.ok(!r.requests.some(x => x.url === MCP));
});

test("disabled search is hidden and rejected even if a model calls it", async t => {
  const r = await run(t, { env: { SEARCH_PROVIDER: "none", RAPIDAPI_KEY: "saved" } });
  assert.ok(!r.modelRequests[0].tools.some(x => x.function.name === "web_search"));
  assert.match(r.output.result.evidence, /web search disabled/);
  assert.equal(r.requests.length, 2);
});

test("unknown explicit provider never silently changes provider", async t => {
  const r = await run(t, { env: { SEARCH_PROVIDER: "typo", RAPIDAPI_KEY: "saved" } });
  assert.match(r.output.result.evidence, /unknown SEARCH_PROVIDER/);
  assert.equal(r.requests.length, 2);
});

test("per-request MCP session, stable conversation, model id, and search cache", async t => {
  const r = await run(t, { env: { MODEL: "my-exact-model-v1" }, rounds: [[search("example pricing"), search("EXAMPLE   pricing"), search("example company")]] });
  const calls = r.requests.filter(x => x.url === MCP);
  assert.equal(calls.filter(x => x.body.method === "initialize").length, 1);
  const searches = calls.filter(x => x.body.method === "tools/call");
  assert.equal(searches.length, 2);
  assert.equal(searches[0].body.params.arguments.session_id, searches[1].body.params.arguments.session_id);
  assert.ok(r.output.agent_log.some(e => e.via === "cache"));
  assert.equal(r.output.agent_log.find(e => e.step === "done").fetches_used, 2);
});

test("SSE handles chunk boundaries, CRLF, notifications and closes after matching response", async t => {
  let cancelled = false;
  const r = await run(t, { mcp: ({ body }) => {
    if (body.method !== "tools/call") return;
    const message = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { structuredContent: sample } });
    const data = ': keepalive\r\n\r\ndata: {"jsonrpc":"2.0","method":"notifications/message"}\r\n\r\nevent: message\r\ndata: ' + message + '\r\n\r\n';
    const bytes = new TextEncoder().encode(data);
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
  } });
  assert.match(r.output.result.evidence, /The team plan/);
  assert.equal(cancelled, true);
});

const failures = {
  "HTTP quota": () => new Response("quota exceeded", { status: 429 }),
  "HTTP server error": () => new Response("unavailable", { status: 503 }),
  "RPC error": id => json({ jsonrpc: "2.0", id, error: { code: -32000, message: "unavailable" } }),
  "tool error": id => json({ jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "failed" }] } }),
  "malformed JSON": () => new Response("broken", { headers: { "content-type": "application/json" } }),
  "mismatched id": id => json({ jsonrpc: "2.0", id: id + 100, result: {} }),
  "malformed result": id => json({ jsonrpc: "2.0", id, result: { structuredContent: { results: "bad" } } }),
};
for (const [name, reply] of Object.entries(failures)) {
  test(`${name} reaches the model and log without provider fallback`, async t => {
    const r = await run(t, { mcp: ({ body }) => body.method === "tools/call" ? reply(body.id) : undefined });
    assert.match(r.output.result.evidence, /search failed:/);
    assert.ok(r.output.agent_log.some(e => e.via === "parallel" && e.error));
    assert.ok(!r.requests.some(x => x.url === RAPIDAPI));
  });
}

test("empty results and non-HTTP URLs do not become fetch targets", async t => {
  const r = await run(t, { mcp: ({ body }) => body.method === "tools/call" ? json({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { results: [{ url: "javascript:alert(1)", excerpts: [] }] } } }) : undefined });
  assert.equal(r.output.result.evidence, "(no results)");
});

test("timeout aborts the actual MCP request and returns a tool failure", async t => {
  let aborted = false;
  const r = await run(t, { env: { SEARCH_TIMEOUT_MS: "15" }, mcp: ({ body, options }) => {
    if (body.method !== "tools/call") return;
    return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => { aborted = true; reject(options.signal.reason); }, { once: true }));
  } });
  assert.equal(aborted, true);
  assert.match(r.output.result.evidence, /search timeout/);
});

test("caller cancellation aborts MCP and stops further model calls", async t => {
  const controller = new AbortController();
  let aborted = false;
  const r = await run(t, { signal: controller.signal, mcp: ({ body, options }) => {
    if (body.method !== "tools/call") return;
    return new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => { aborted = true; reject(options.signal.reason); }, { once: true });
      controller.abort(new Error("caller cancelled"));
    });
  } });
  assert.equal(aborted, true);
  assert.match(r.output.error, /caller cancelled/);
  assert.equal(r.modelRequests.length, 1);
});

test("Worker authentication blocks all external requests", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", () => { calls++; throw new Error("unexpected network"); });
  const response = await worker.fetch(new Request("https://ferret.test/", { method: "POST", body: '{}' }), { WORKER_AUTH: "secret" });
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

for (const [name, phase, result] of [
  ["unsupported protocol", "initialize", { protocolVersion: "1900-01-01" }],
  ["missing search tool", "tools/list", { tools: [{ name: "web_fetch" }] }],
]) {
  test(`${name} stops discovery without making a search request`, async t => {
    const r = await run(t, { mcp: ({ body }) => body.method === phase ? json({ jsonrpc: "2.0", id: body.id, result }, { "mcp-session-id": "test-session" }) : undefined });
    assert.match(r.output.result.evidence, /search failed:/);
    assert.ok(!r.requests.some(x => x.url === MCP && x.body.method === "tools/call"));
  });
}

test("search respects result limit and existing tool-call budget", async t => {
  const r = await run(t, { env: { MAX_FETCHES: "1" }, rounds: [[search("one"), search("two")]], mcp: ({ body }) => {
    if (body.method !== "tools/call") return;
    return json({ jsonrpc: "2.0", id: body.id, result: { structuredContent: { results: Array.from({ length: 10 }, (_, i) => ({ url: `https://example.com/${i}`, title: `Page ${i}`, excerpts: ["content"] })) } } });
  } });
  assert.match(r.output.result.evidence, /6\. Page 5/);
  assert.doesNotMatch(r.output.result.evidence, /7\. Page 6/);
  assert.match(r.output.result.evidence, /tool budget exhausted/);
  assert.equal(r.requests.filter(x => x.url === MCP && x.body.method === "tools/call").length, 1);
});
