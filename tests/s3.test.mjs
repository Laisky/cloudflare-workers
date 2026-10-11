import { test } from "node:test";
import assert from "node:assert/strict";
import { workerHarness, Response } from "./harness.mjs";
const LIMIT = 1024 * 1024;

/** verifyAsset checks exact asset delivery and whether a bounded response was cached. */
async function verifyAsset(size, headers, cacheExpected) {
    const payload = new Uint8Array(size).fill(65);
    const mf = await workerHarness("s3", () => new Response(payload, { headers }));
    try {
        const response = await mf.dispatchFetch("https://s1.laisky.com/uploads/twitter/test.png");
        assert.equal(response.status, 200);
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), payload);
        const cache = await mf.getKVNamespace("KV");
        assert.equal((await cache.list()).keys.length > 0, cacheExpected);
    } finally { await mf.dispose(); }
}
test("S3 missing Content-Length cannot bypass the actual cache byte bound", () => verifyAsset(LIMIT + 1, {}, false));
test("S3 absent Content-Length still permits caching a small response", () => verifyAsset(2048, {}, true));
test("S3 exact 1 MiB boundary streams without caching", () => verifyAsset(LIMIT, {}, false));
test("S3 known oversized response streams without caching", () => verifyAsset(LIMIT + 1, { "Content-Length": String(LIMIT + 1) }, false));
test("S3 cache hit preserves binary bytes", async () => {
    let calls = 0;
    const payload = new Uint8Array([0, 255, 128, 17]);
    const mf = await workerHarness("s3", () => { calls++; return new Response(payload); });
    try {
        for (let i = 0; i < 2; i++) {
            const response = await mf.dispatchFetch("https://s1.laisky.com/uploads/twitter/binary.png");
            assert.deepEqual(new Uint8Array(await response.arrayBuffer()), payload);
        }
        assert.equal(calls, 1);
    } finally { await mf.dispose(); }
});

test("S3 HEAD responses cannot poison the GET cache with an empty body", async () => {
    const mf = await workerHarness("s3", () => new Response(null));
    try {
        const response = await mf.dispatchFetch("https://s1.laisky.com/uploads/twitter/head.png", { method: "HEAD" });
        assert.equal(response.status, 200);
        assert.equal((await (await mf.getKVNamespace("KV")).list()).keys.length, 0);
    } finally { await mf.dispose(); }
});

test("S3 begins streaming an oversized response before the origin body finishes", async () => {
    let release;
    const remaining = new Promise(resolve => { release = resolve; });
    const body = new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(LIMIT + 1).fill(65)); },
        async pull(controller) { await remaining; controller.enqueue(new Uint8Array([66])); controller.close(); }
    });
    const mf = await workerHarness("s3", () => new Response(body));
    try {
        const fetching = mf.dispatchFetch("https://s1.laisky.com/uploads/twitter/stream.png");
        const early = await Promise.race([fetching, new Promise(resolve => setTimeout(() => resolve(null), 1000))]);
        release();
        assert.notEqual(early, null, "Worker must return the oversized stream before origin EOF");
        const response = early || await fetching;
        const bytes = new Uint8Array(await response.arrayBuffer());
        assert.equal(bytes.length, LIMIT + 2);
        assert.equal(bytes.at(-1), 66);
        assert.equal((await (await mf.getKVNamespace("KV")).list()).keys.length, 0);
    } finally { release(); await mf.dispose(); }
});
