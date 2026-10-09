import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { workerHarness, Response, eventually } from "./harness.mjs";
const sha = value => createHash("sha256").update(value).digest("hex");
const cases = [
    { project: "blog", url: "https://blog.laisky.com/pages/kv-only", key: "blog-v2.25/" + sha("general:GET:https://blog.laisky.com/pages/kv-only") },
    { project: "s3", url: "https://s1.laisky.com/uploads/twitter/kv-only.png", key: "s3-v0.1/" + sha("redirect2HierachyDir:/uploads/twitter/kv-only.png") }
];
for (const { project, url, key } of cases) {
    test(`${project} cache miss and hit never access R2 without a BUCKET binding`, async () => {
        let calls = 0;
        const mf = await workerHarness(project, () => { calls++; return new Response("origin", { headers: { "X-Origin": "preserved" } }); });
        try {
            assert.equal(await (await mf.dispatchFetch(url)).text(), "origin");
            const kv = await mf.getKVNamespace("KV");
            await eventually(async () => await kv.get(key) !== null);
            const entries = await kv.list();
            assert.equal(entries.keys[0].name, key);
            const remaining = entries.keys[0].expiration - Date.now() / 1000;
            assert.ok(remaining > 604700 && remaining <= 604800, "retain the existing seven-day physical TTL");
            const hit = await mf.dispatchFetch(url);
            assert.equal(await hit.text(), "origin");
            assert.equal(hit.headers.get("X-Origin"), "preserved");
            assert.equal(calls, 1);
            const state = await (await mf.dispatchFetch("https://test/_binding-state")).json();
            assert.equal(state.r2Accesses, 0);
        } finally { await mf.dispose(); }
    });
    for (const status of [200, 503]) {
        test(`${project} unavailable KV preserves origin ${status} body and headers without R2`, async () => {
            const mf = await workerHarness(project, () => new Response("exact origin", { status, headers: { "X-Origin": "failure-safe" } }), undefined, { kvFailure: true });
            try {
                const response = await mf.dispatchFetch(url);
                assert.equal(response.status, status);
                assert.equal(await response.text(), "exact origin");
                assert.equal(response.headers.get("X-Origin"), "failure-safe");
                await new Promise(resolve => setTimeout(resolve, 100));
                assert.equal((await (await mf.dispatchFetch("https://test/_binding-state")).json()).r2Accesses, 0);
            } finally { await mf.dispose(); }
        });
    }
    test(`${project} expired or evicted KV goes to origin and preserves origin errors`, async () => {
        let status = 200;
        const mf = await workerHarness(project, () => new Response("origin " + status, { status }));
        try {
            const kv = await mf.getKVNamespace("KV");
            await (await mf.dispatchFetch(url)).text();
            await eventually(async () => await kv.get(key) !== null);
            // KV's service removes expired entries; delete models that observable miss without waiting seven days.
            await kv.delete(key);
            status = 503;
            const response = await mf.dispatchFetch(url);
            assert.equal(response.status, 503);
            assert.equal(await response.text(), "origin 503");
            assert.equal(await kv.get(key), null);
        } finally { await mf.dispose(); }
    });
}

for (const [project, url] of [
    ["blog", "https://blog.laisky.com/pages/private"],
    ["blog", "https://blog.laisky.com/p/private"],
    ["blog", "https://gq.laisky.com/query/?query=query%20%7B%20x%20%7D"],
    ["s3", "https://s1.laisky.com/uploads/twitter/private.png"]
]) {
    for (const header of ["Authorization", "Cookie"]) {
        test(`${project} ${new URL(url).pathname} ${header} requests cannot read or overwrite public cache`, async () => {
            const mf = await workerHarness(project, request => {
                if (new URL(request.url).hostname === "gq.laisky.com" && new URL(url).hostname !== "gq.laisky.com") return Response.json({ data: { BlogTwitterCard: "" } });
                const identity = request.headers.get(header) || "public";
                return new Response(JSON.stringify({ data: identity }), { headers: { "Content-Type": "application/json" } });
            });
            try {
                const publicBody = JSON.stringify({ data: "public" });
                assert.equal(await (await mf.dispatchFetch(url)).text(), publicBody);
                const kv = await mf.getKVNamespace("KV");
                await eventually(async () => (await kv.list()).keys.length === 1);
                const before = await (await mf.dispatchFetch("https://test/_binding-state")).json();
                for (const identity of ["first", "second"]) {
                    assert.equal(await (await mf.dispatchFetch(url, { headers: { [header]: identity } })).text(), JSON.stringify({ data: identity }));
                }
                await new Promise(resolve => setTimeout(resolve, 100));
                const after = await (await mf.dispatchFetch("https://test/_binding-state")).json();
                assert.equal(after.kvGets, before.kvGets);
                assert.equal(after.kvPuts, before.kvPuts);
                assert.equal(await (await mf.dispatchFetch(url)).text(), publicBody);
            } finally { await mf.dispose(); }
        });
    }
    for (const headers of [{ "Cache-Control": "private" }, { "Cache-Control": "no-store" }, { "Set-Cookie": "session=private" }]) {
        test(`${project} ${new URL(url).pathname} private origin headers prevent shared cache writes`, async () => {
            const mf = await workerHarness(project, request => {
                if (new URL(request.url).hostname === "gq.laisky.com" && new URL(url).hostname !== "gq.laisky.com") return Response.json({ data: { BlogTwitterCard: "" } });
                return new Response('{ "data": "private" }', { headers: { "Content-Type": "application/json", ...headers } });
            });
            try {
                const response = await mf.dispatchFetch(url);
                assert.equal(await response.text(), '{ "data": "private" }');
                for (const [name, value] of Object.entries(headers)) assert.equal(response.headers.get(name), value);
                await new Promise(resolve => setTimeout(resolve, 100));
                assert.equal((await (await mf.getKVNamespace("KV")).list()).keys.length, 0);
            } finally { await mf.dispose(); }
        });
    }
}

test("Authenticated GraphQL POST retains query semantics and exact response bytes without shared cache", async () => {
    const wire = '{ "data": { "b": 2, "a": 1 } }';
    let received;
    const mf = await workerHarness("blog", async request => {
        received = { body: await request.json(), auth: request.headers.get("Authorization") };
        return new Response(wire, { status: 200, headers: { "Content-Type": "application/json", "X-Origin": "graphql" } });
    });
    try {
        const input = { query: "query { x }", variables: { x: 1 } };
        const response = await mf.dispatchFetch("https://gq.laisky.com/query/", { method: "POST", body: JSON.stringify(input), headers: { Authorization: "test-identity" } });
        assert.equal(await response.text(), wire);
        assert.equal(response.headers.get("X-Origin"), "graphql");
        assert.deepEqual(received, { body: input, auth: "test-identity" });
        const state = await (await mf.dispatchFetch("https://test/_binding-state")).json();
        assert.equal(state.kvGets, 0);
        assert.equal(state.kvPuts, 0);
    } finally { await mf.dispose(); }
});
test("GraphQL mutations and existing denied alert types retain their dispatch semantics", async () => {
    let calls = 0, received;
    const mf = await workerHarness("blog", async request => { calls++; received = await request.json(); return new Response("mutation result", { status: 202 }); });
    try {
        const input = { query: "mutation { x }", variables: { x: 1 } };
        const response = await mf.dispatchFetch("https://gq.laisky.com/query/", { method: "POST", body: JSON.stringify(input) });
        assert.equal(response.status, 202);
        assert.equal(await response.text(), "mutation result");
        assert.deepEqual(received, input);
        const denied = await mf.dispatchFetch("https://gq.laisky.com/query/", { method: "POST", body: JSON.stringify({ query: "query { x }", variables: { type: "pateo" } }) });
        assert.equal(denied.status, 403);
        assert.equal(calls, 1);
        assert.equal((await (await mf.getKVNamespace("KV")).list()).keys.length, 0);
    } finally { await mf.dispose(); }
});
for (const { project, url, key } of cases) {
    test(`${project} old private cache envelopes are not served to public requests`, async () => {
        const mf = await workerHarness(project, () => new Response("public origin"));
        try {
            const kv = await mf.getKVNamespace("KV");
            await kv.put(key, JSON.stringify({ body: project === "s3" ? Buffer.from("private").toString("base64") : "private", headers: [["Set-Cookie", "private=1"]], staleAt: Date.now() + 86400000 }));
            assert.equal(await (await mf.dispatchFetch(url)).text(), "public origin");
        } finally { await mf.dispose(); }
    });
}
