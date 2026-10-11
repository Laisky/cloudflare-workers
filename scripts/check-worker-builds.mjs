import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Miniflare, Log, LogLevel, Response } from "miniflare";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cases = [
    { project: "blog", name: "blog", date: "2024-09-27" },
    { project: "blog", name: "blog-dev", env: "dev", date: "2024-09-27" },
    { project: "s3", name: "s3", date: "2024-09-27" },
    { project: "s3", name: "s3-dev", env: "dev", date: "2024-09-27" },
    { project: "speech-to-text", name: "speech-to-text", date: "2023-10-30" }
];

/** checkBundle executes a locked Wrangler dry-run bundle with entirely local bindings and origin fixtures. */
async function checkBundle(item) {
    const outdir = await mkdtemp(join(tmpdir(), "worker-dependency-build-"));
    let mf;
    try {
        const cli = join(root, item.project, "node_modules/wrangler/bin/wrangler.js");
        const args = [cli, "deploy", "--dry-run", "--outdir", outdir];
        if (item.env) args.push("--env", item.env);
        await exec(process.execPath, args, {
            cwd: join(root, item.project),
            env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" },
            maxBuffer: 8 * 1024 * 1024
        });
        const bundle = await readFile(join(outdir, "index.js"), "utf8");
        let originCalls = 0;
        const binary = new Uint8Array([0, 255, 128, 17]);
        const origin = request => {
            originCalls++;
            if (item.project === "blog") {
                return new Response("public build fixture", { headers: { "Content-Type": "text/html", "Cache-Control": "public, max-age=600" } });
            }
            if (item.project === "s3") {
                const hash = createHash("md5").update("fixture.bin").digest("hex");
                assert.equal(new URL(request.url).pathname, `/uploads/twitter/${hash.slice(0, 2)}/${hash.slice(2, 4)}/fixture.bin`);
                if (request.headers.has("Range")) {
                    return new Response(binary.slice(0, 2), { status: 206, headers: { "Content-Range": "bytes 0-1/4" } });
                }
                return new Response(request.method === "HEAD" ? null : binary, {
                    headers: { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=600", "Content-Length": "4" }
                });
            }
            throw new Error("Speech without an AI binding must not download audio");
        };
        mf = new Miniflare({
            cf: false, modules: true, script: bundle, compatibilityDate: item.date,
            kvNamespaces: item.project === "speech-to-text" ? [] : ["KV"],
            outboundService: origin, log: new Log(LogLevel.NONE)
        });
        await mf.ready;
        if (item.project === "blog") {
            const redirect = await mf.dispatchFetch("https://blog.test/", { redirect: "manual" });
            assert.equal(redirect.status, 302);
            assert.equal(redirect.headers.get("Location"), "https://blog.test/pages/0/");
            const first = await mf.dispatchFetch("https://blog.test/pages/0/");
            assert.equal(first.status, 200);
            assert.equal(first.headers.get("X-Laisky-Cf-Cache-Status"), "MISS");
            assert.equal(await first.text(), "public build fixture");
            const kv = await mf.getKVNamespace("KV");
            const until = Date.now() + 5000;
            while ((await kv.list()).keys.length === 0 && Date.now() < until) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            const warm = await mf.dispatchFetch("https://blog.test/pages/0/");
            assert.equal(warm.headers.get("X-Laisky-Cf-Cache-Status"), "FRESH");
            assert.equal(await warm.text(), "public build fixture");
            assert.equal(originCalls, 1);
        } else if (item.project === "s3") {
            for (let i = 0; i < 2; i++) {
                const response = await mf.dispatchFetch("https://s1.test/uploads/twitter/fixture.bin");
                assert.equal(response.status, 200);
                assert.deepEqual(new Uint8Array(await response.arrayBuffer()), binary);
            }
            assert.equal(originCalls, 1);
            const head = await mf.dispatchFetch("https://s1.test/uploads/twitter/fixture.bin", { method: "HEAD" });
            assert.equal(head.status, 200);
            assert.equal((await head.arrayBuffer()).byteLength, 0);
            const partial = await mf.dispatchFetch("https://s1.test/uploads/twitter/fixture.bin", {
                headers: { Range: "bytes=0-1", Cookie: "local-build-fixture=1" }
            });
            assert.equal(partial.status, 206);
            assert.equal(partial.headers.get("Content-Range"), "bytes 0-1/4");
            assert.deepEqual(new Uint8Array(await partial.arrayBuffer()), binary.slice(0, 2));
        } else {
            const response = await mf.dispatchFetch("https://speech.test/");
            assert.equal(response.status, 503);
            assert.equal(await response.text(), "AI binding is unavailable");
            assert.equal(originCalls, 0);
        }
        console.log(JSON.stringify({ worker: item.name, bundle_bytes: Buffer.byteLength(bundle), offline_acceptance: "passed" }));
    } finally {
        if (mf) await mf.dispose();
        await rm(outdir, { recursive: true, force: true });
    }
}

for (const item of cases) await checkBundle(item);
