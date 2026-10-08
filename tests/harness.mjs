import { build } from "esbuild";
import { Miniflare, Log, LogLevel, Response } from "miniflare";
import { resolve } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

/** workerHarness bundles the real entrypoint and runs it in local workerd with offline services. */
export async function workerHarness(project, origin, ai) {
    const alias = project === "speech-to-text" ? {} : {
        "@laisky/cf-utils": require.resolve(project === "s3" ? "cf-utils-s3" : "cf-utils-blog")
    };
    const output = await build({
        ...(project === "speech-to-text" ? {
            stdin: {
                contents: 'import worker from "./speech-to-text/src/index.js"; export default { fetch(request, env, ctx) { const binding = env.AI; return worker.fetch(request, { ...env, AI: binding && { fetch(url, init) { return binding.fetch(new URL(url, "http://ai"), init); } } }, ctx); } };',
                resolveDir: process.cwd(), sourcefile: "speech-ai-test-adapter.js"
            }
        } : { entryPoints: [resolve(project, "src/index.js")] }),
        bundle: true, write: false, format: "esm", platform: "browser", alias
    });
    const mf = new Miniflare({
        cf: false, modules: true, script: output.outputFiles[0].text,
        compatibilityDate: project === "speech-to-text" ? "2023-10-30" : "2024-09-27",
        kvNamespaces: ["KV"], r2Buckets: ["BUCKET"],
        outboundService: origin,
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
