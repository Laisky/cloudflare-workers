import { build } from "esbuild";
import { Miniflare, Log, LogLevel, Response } from "miniflare";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

/** workerHarness bundles the real entrypoint and runs it in local workerd with offline services. */
export async function workerHarness(project, origin, ai, options = {}) {
    const alias = project === "speech-to-text" ? {} : {
        "@laisky/cf-utils": require.resolve(project === "s3" ? "cf-utils-s3" : "cf-utils-blog")
    };
    const adapter = `const state = { r2Accesses: 0, kvGets: 0, kvPuts: 0 }; const adaptEnv = env => new Proxy(env, { get(target, key) { if (key === "BUCKET" && ${options.allowR2 !== true}) { state.r2Accesses++; throw new Error("R2 must not be accessed"); } if (key === "KV") return new Proxy(target.KV, { get(kv, method) { const value = kv[method]; if (typeof value !== "function") return value; return (...args) => { if (method === "get") state.kvGets++; if (method === "put") state.kvPuts++; if (${Boolean(options.kvFailure)} && ["get", "put"].includes(method)) throw new Error("KV unavailable"); return value.apply(kv, args); }; } }); return target[key]; } });`;
    const output = await build({
        ...(typeof origin === "string" ? {
            stdin: {
                contents: `import worker from "./${project}/src/index.js"; import origin from "test-origin"; ${adapter} globalThis.fetch = (request, init) => origin.fetch(typeof request === "string" ? new Request(request, init) : request); export default { fetch(request, env, ctx) { if (new URL(request.url).pathname === "/_binding-state") return Response.json(state); if (new URL(request.url).pathname === "/_test-state") return origin.fetch(request); return worker.fetch(request, adaptEnv(env), ctx); } };`,
                resolveDir: process.cwd(), sourcefile: "same-isolate-origin-adapter.js"
            },
            plugins: [{
                name: "controlled-origin",
                setup(build) {
                    build.onResolve({ filter: /^test-origin$/ }, () => ({ path: "test-origin", namespace: "test-origin" }));
                    build.onLoad({ filter: /.*/, namespace: "test-origin" }, () => ({ contents: origin, loader: "js" }));
                }
            }]
        } : project === "speech-to-text" ? {
            stdin: {
                contents: 'import worker from "./speech-to-text/src/index.js"; export default { fetch(request, env, ctx) { const binding = env.AI; return worker.fetch(request, { ...env, AI: binding && { fetch(url, init) { return binding.fetch(new URL(url, "http://ai"), init); } } }, ctx); } };',
                resolveDir: process.cwd(), sourcefile: "speech-ai-test-adapter.js"
            }
        } : { stdin: {
            contents: `import worker from "./${project}/src/index.js"; ${adapter} export default { fetch(request, env, ctx) { if (new URL(request.url).pathname === "/_binding-state") return Response.json(state); return worker.fetch(request, adaptEnv(env), ctx); } };`,
            resolveDir: process.cwd(), sourcefile: "cache-binding-test-adapter.js"
        } }),
        bundle: true, write: false, format: "esm", platform: "browser", alias
    });
    const mf = new Miniflare({
        cf: false, modules: true, script: output.outputFiles[0].text,
        compatibilityDate: project === "speech-to-text" ? "2023-10-30" : "2024-09-27",
        kvNamespaces: ["KV"], r2Buckets: options.allowR2 ? ["BUCKET"] : [],
        outboundService: typeof origin === "string" ? () => new Response("Unexpected external fetch", { status: 500 }) : origin,
        serviceBindings: ai ? { AI: ai } : {},
        log: new Log(LogLevel.NONE)
    });
    await mf.ready;
    return mf;
}
export { Response };

/** eventually waits for asynchronous waitUntil storage effects without accessing remote resources. */
export async function eventually(predicate) {
    const until = Date.now() + 3000;
    while (Date.now() < until) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("Expected background effect did not finish");
}
