import { readBodyWithinLimit } from "./body-limits.js";
import { parseBoundedJson } from "./json-limits.js";
/** createBoundedCache reads existing formats with byte bounds before JSON parsing. */
export function createBoundedCache(prefix, hashKey, maxBodyBytes, maxEnvelopeBytes, validate = () => true) {
    const decoder = new TextDecoder(), encoder = new TextEncoder();
    const safe = value => value && typeof value.body === "string"
        && value.body.length <= maxBodyBytes && encoder.encode(value.body).byteLength <= maxBodyBytes
        && Array.isArray(value.headers) && validate(value);
    const parse = async body => {
        const { bytes } = await readBodyWithinLimit(body, maxEnvelopeBytes, true);
        return bytes === null ? null : parseBoundedJson(decoder.decode(bytes));
    };
    /** kvGet reads a physical KV key and rejects oversized or malformed legacy envelopes. */
    async function kvGet(env, key) {
        try {
            const stream = await env.KV.get(key, "stream");
            if (stream === null) return null;
            const value = await parse(stream);
            return safe(value) ? value : null;
        } catch (error) { console.warn("Bounded KV cache read failed:", error.message); return null; }
    }
    /** cacheGet reads only KV using the unchanged physical cache key. */
    async function cacheGet(env, key) {
        return kvGet(env, prefix + hashKey(key));
    }
    return { cacheGet, kvGet };
}
