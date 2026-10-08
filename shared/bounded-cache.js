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
    /** cacheGet prefers KV and falls back to a non-expired R2 envelope using the same physical key. */
    async function cacheGet(env, key) {
        const physicalKey = prefix + hashKey(key);
        const cached = await kvGet(env, physicalKey);
        if (cached) return cached;
        try {
            const object = await env.BUCKET.get(physicalKey);
            if (!object) return null;
            const payload = await parse(object.body);
            if (!payload || (payload.expiration !== 0 && payload.expiration < Date.now())) return null;
            return safe(payload.data) ? payload.data : null;
        } catch (error) { console.warn("Bounded R2 cache read failed:", error.message); return null; }
    }
    return { cacheGet, kvGet };
}
