import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { workerHarness, Response, eventually } from "./harness.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");
const LIMIT = 1024 * 1024;

test("Blog oversized origin response streams intact without cache writes", async () => {
    const body = "x".repeat(LIMIT + 1);
    const mf = await workerHarness("blog", () => new Response(body, { headers: { "Content-Type": "text/html" } }));
    try {
        const response = await mf.dispatchFetch("https://blog.laisky.com/pages/big");
        assert.equal(await response.text(), body);
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal((await (await mf.getKVNamespace("KV")).list()).keys.length, 0);
    } finally { await mf.dispose(); }
});
test("Blog rejects excessive GraphQL JSON nesting before dispatching origin", async () => {
    let calls = 0;
    const mf = await workerHarness("blog", () => { calls++; return Response.json({ data: {} }); });
    try {
        const body = '{"query":"query { x }","variables":' + "[".repeat(40) + "0" + "]".repeat(40) + "}";
        const response = await mf.dispatchFetch("https://gq.laisky.com/query/", { method: "POST", body });
        assert.equal(response.status, 400);
        assert.equal(calls, 0);
    } finally { await mf.dispose(); }
});
test("Blog rejects oversized GraphQL requests before parsing or origin calls", async () => {
    let calls = 0;
    const mf = await workerHarness("blog", () => { calls++; return Response.json({ data: {} }); });
    try {
        const body = JSON.stringify({ query: "query { x }", variables: { value: "x".repeat(65536) } });
        const response = await mf.dispatchFetch("https://gq.laisky.com/query/", { method: "POST", body });
        assert.equal(response.status, 413);
        assert.equal(calls, 0);
    } finally { await mf.dispose(); }
});
test("Blog simultaneous stale hits share one refresh within an isolate", async () => {
    let calls = 0;
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const mf = await workerHarness("blog", async () => { calls++; await blocked; return new Response("new"); });
    try {
        const kv = await mf.getKVNamespace("KV");
        const url = "https://blog.laisky.com/pages/stale";
        const key = "blog-v2.25/" + sha("general:GET:" + url);
        await kv.put(key, JSON.stringify({
            body: "old", headers: [], status: 200, hash: sha("old"), delta: 200,
            staleAt: Date.now() - 1000, expiresAt: Date.now() + 86400000
        }));
        const responses = await Promise.all(Array.from({ length: 8 }, () => mf.dispatchFetch(url)));
        for (const response of responses) assert.equal(await response.text(), "old");
        await eventually(() => calls > 0);
        assert.equal(calls, 1);
        release();
        await eventually(async () => JSON.parse(await kv.get(key)).body === "new");
    } finally { release(); await mf.dispose(); }
});
test("Blog binary assets pass through unchanged without text caching", async () => {
    const payload = new Uint8Array([255, 128, 0, 254]);
    const mf = await workerHarness("blog", () => new Response(payload, { headers: { "Content-Type": "image/png" } }));
    try {
        const response = await mf.dispatchFetch("https://blog.laisky.com/assets/test.png");
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), payload);
    } finally { await mf.dispose(); }
});

test("Blog oversized legacy KV bodies are ignored rather than served or rehashed", async () => {
    const mf = await workerHarness("blog", () => new Response("origin"));
    try {
        const kv = await mf.getKVNamespace("KV"), url = "https://blog.laisky.com/pages/legacy";
        await kv.put("blog-v2.25/" + sha("general:GET:" + url), JSON.stringify({
            body: "x".repeat(LIMIT + 1), headers: [], staleAt: Date.now() + 86400000
        }));
        assert.equal(await (await mf.dispatchFetch(url)).text(), "origin");
    } finally { await mf.dispose(); }
});
test("Blog legacy binary cache entries are bypassed to restore exact origin bytes", async () => {
    const payload = new Uint8Array([255, 128, 0]);
    const mf = await workerHarness("blog", () => new Response(payload, { headers: { "Content-Type": "image/png" } }));
    try {
        const kv = await mf.getKVNamespace("KV"), url = "https://blog.laisky.com/assets/legacy.png";
        await kv.put("blog-v2.25/" + sha("general:GET:" + url), JSON.stringify({
            body: "corrupt", headers: [["Content-Type", "image/png"]], staleAt: Date.now() + 86400000
        }));
        assert.deepEqual(new Uint8Array(await (await mf.dispatchFetch(url)).arrayBuffer()), payload);
    } finally { await mf.dispose(); }
});
test("Blog deeply nested origin JSON passes through unchanged without caching", async () => {
    const body = '{"data":' + "[".repeat(40) + "0" + "]".repeat(40) + "}";
    const mf = await workerHarness("blog", () => new Response(body, { headers: { "Content-Type": "application/json" } }));
    try {
        const response = await mf.dispatchFetch("https://gq.laisky.com/query/?query=query%20%7B%20x%20%7D");
        assert.equal(await response.text(), body);
        assert.equal((await (await mf.getKVNamespace("KV")).list()).keys.length, 0);
    } finally { await mf.dispose(); }
});
test("Blog braces and escapes inside JSON strings do not count as structural depth", async () => {
    const body = JSON.stringify({ query: "query { x }", variables: { text: '{["'.repeat(40) } });
    const mf = await workerHarness("blog", () => Response.json({ data: { ok: true } }));
    try {
        const response = await mf.dispatchFetch("https://gq.laisky.com/query/", { method: "POST", body });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { data: { ok: true } });
    } finally { await mf.dispose(); }
});
test("Blog unchanged fresh bypass does not rewrite its existing R2 envelope", async () => {
    const mf = await workerHarness("blog", () => new Response("same"));
    try {
        const url = "https://blog.laisky.com/pages/unchanged";
        const key = "blog-v2.25/" + sha("general:GET:" + url);
        const bucket = await mf.getR2Bucket("BUCKET");
        const first = await mf.dispatchFetch(url, { headers: { Accept: "text/html" } });
        await first.text();
        await eventually(async () => (await bucket.get(key)) !== null);
        const before = await bucket.get(key);
        await (await mf.dispatchFetch(url, { headers: { Accept: "text/html" } })).text();
        await new Promise(resolve => setTimeout(resolve, 100));
        const after = await bucket.get(key);
        assert.equal(after.etag, before.etag);
    } finally { await mf.dispose(); }
});
test("Blog failed refresh releases its coordination slot for a later retry", async () => {
    let calls = 0;
    const mf = await workerHarness("blog", () => { calls++; return new Response("failed", { status: 503 }); });
    try {
        const kv = await mf.getKVNamespace("KV"), url = "https://blog.laisky.com/pages/retry";
        await kv.put("blog-v2.25/" + sha("general:GET:" + url), JSON.stringify({
            body: "old", headers: [], staleAt: Date.now() - 1000, expiresAt: Date.now() + 86400000
        }));
        await (await mf.dispatchFetch(url)).text();
        await eventually(() => calls === 1);
        await new Promise(resolve => setTimeout(resolve, 100));
        await (await mf.dispatchFetch(url)).text();
        await eventually(() => calls === 2);
    } finally { await mf.dispose(); }
});

test("Blog node-dense origin JSON bypasses canonical sorting and caching", async () => {
    const body = JSON.stringify({ data: Array(20001).fill(0) });
    const mf = await workerHarness("blog", () => new Response(body, { headers: { "Content-Type": "application/json" } }));
    try {
        const response = await mf.dispatchFetch("https://gq.laisky.com/query/?query=query%20%7B%20x%20%7D");
        assert.equal(await response.text(), body);
        assert.equal((await (await mf.getKVNamespace("KV")).list()).keys.length, 0);
    } finally { await mf.dispose(); }
});
test("Blog GraphQL input budget counts UTF-8 bytes rather than JavaScript characters", async () => {
    let calls = 0;
    const mf = await workerHarness("blog", () => { calls++; return Response.json({ data: {} }); });
    try {
        const body = JSON.stringify({ query: "query { x }", variables: { text: "\u00e9".repeat(32768) } });
        const response = await mf.dispatchFetch("https://gq.laisky.com/query/", { method: "POST", body });
        assert.equal(response.status, 413);
        assert.equal(calls, 0);
    } finally { await mf.dispose(); }
});

test("Blog post path without a name preserves the unmodified origin body", async () => {
    const mf = await workerHarness("blog", () => new Response("<html><head></head>post</html>", { headers: { "Content-Type": "text/html" } }));
    try {
        assert.equal(await (await mf.dispatchFetch("https://blog.laisky.com/p/")).text(), "<html><head></head>post</html>");
    } finally { await mf.dispose(); }
});
test("Blog successful Twitter card injection and cache response preserve the existing page contract", async () => {
    let pageCalls = 0, cardCalls = 0;
    const mf = await workerHarness("blog", request => {
        if (new URL(request.url).hostname === "gq.laisky.com") {
            cardCalls++;
            return Response.json({ data: { BlogTwitterCard: '<meta name="twitter:card" content="summary">' } });
        }
        pageCalls++;
        return new Response("<html><head></head>post</html>", { headers: { "Content-Type": "text/html" } });
    });
    try {
        const url = "https://blog.laisky.com/p/example";
        const expected = '<html><head><meta name="twitter:card" content="summary"></head>post</html>';
        assert.equal(await (await mf.dispatchFetch(url)).text(), expected);
        await eventually(async () => (await (await mf.getKVNamespace("KV")).list()).keys.length === 1);
        assert.equal(await (await mf.dispatchFetch(url)).text(), expected);
        assert.equal(pageCalls, 1);
        assert.equal(cardCalls, 1);
    } finally { await mf.dispose(); }
});
test("Blog R2 fallback keeps an existing unexpired envelope readable", async () => {
    let calls = 0;
    const mf = await workerHarness("blog", () => { calls++; return new Response("origin"); });
    try {
        const url = "https://blog.laisky.com/pages/r2";
        await (await mf.getR2Bucket("BUCKET")).put("blog-v2.25/" + sha("general:GET:" + url), JSON.stringify({
            expiration: Date.now() + 86400000,
            data: { body: "existing", headers: [], staleAt: Date.now() + 86400000 }
        }));
        assert.equal(await (await mf.dispatchFetch(url)).text(), "existing");
        assert.equal(calls, 0);
    } finally { await mf.dispose(); }
});
test("Blog oversized legacy R2 entries are ignored and replaced from origin", async () => {
    const mf = await workerHarness("blog", () => new Response("origin"));
    try {
        const url = "https://blog.laisky.com/pages/r2-large";
        await (await mf.getR2Bucket("BUCKET")).put("blog-v2.25/" + sha("general:GET:" + url), JSON.stringify({
            expiration: Date.now() + 86400000,
            data: { body: "x".repeat(LIMIT + 1), headers: [], staleAt: Date.now() + 86400000 }
        }));
        assert.equal(await (await mf.dispatchFetch(url)).text(), "origin");
    } finally { await mf.dispose(); }
});
test("Blog GraphQL wire JSON stays unchanged while reordered fields do not rewrite R2", async () => {
    let body = '{ "data": { "b": 2, "a": 1 } }';
    const mf = await workerHarness("blog", () => new Response(body, { headers: { "Content-Type": "application/json" } }));
    try {
        const url = "https://gq.laisky.com/query/?query=query%20%7B%20x%20%7D";
        const key = "blog-v2.25/" + sha("graphql:GET:/query/:" + JSON.stringify({ query: "query { x }", variables: null }));
        const bucket = await mf.getR2Bucket("BUCKET");
        assert.equal(await (await mf.dispatchFetch(url, { headers: { "Cache-Control": "no-cache" } })).text(), body);
        await eventually(async () => (await bucket.get(key)) !== null);
        const before = await bucket.get(key);
        body = '{ "data": { "a": 1, "b": 2 } }';
        assert.equal(await (await mf.dispatchFetch(url, { headers: { "Cache-Control": "no-cache" } })).text(), body);
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal((await bucket.get(key)).etag, before.etag);
    } finally { await mf.dispose(); }
});
