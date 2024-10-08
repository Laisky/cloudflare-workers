'use strict';

import { sha256 } from 'js-sha256';

const DefaultCacheTTLSec = 3600 * 24 * 7;  // 7day

/**
 * clone and convert Headers to Array,
 * make it be able to be serialized by JSON.stringify
 *
 * @param {Headers} headers
 * @returns
 */
export const headersToArray = (headers) => {
    let hs = [
        ["X-Laisky-Cf-Cache", "HIT"],
    ];
    for (let [key, value] of headers.entries()) {
        hs.push([key, value]);
    }

    return hs;
}

/**
 * convert Array to Headers
 *
 * @param {Array} hs
 * @returns
 */
export const headersFromArray = (hs) => {
    let headers = new Headers();
    for (let [key, value] of hs) {
        headers.append(key, value);
    }

    return headers;
}


/**
 * cacheSet set cache with key, value, and ttl
 *
 * @param {string} key
 * @param {any} val
 * @param {number} ttl
 * @returns
 */
export const cacheSet = async (env, key, val, ttl = DefaultCacheTTLSec) => {
    console.log(`try to set cache key=${key}, val=${val}, ttl=${ttl}`);
    const cacheKey = sha256(key)
    await Promise.all([
        kvSet(env, cacheKey, val, ttl),
        bucketSet(env, cacheKey, val, ttl)
    ]);
}

/**
 * cacheGet get cache with key
 *
 * @param {string} key
 * @returns {any|null} return null if not found
 */
export const cacheGet = async (env, key) => {
    const cacheKey = sha256(key)
    const results = await Promise.all([
        kvGet(env, cacheKey),
        bucketGet(env, cacheKey)
    ]);

    return results.find((v) => v != null) || null;
}

export const kvGet = async (env, key) => {
    console.log('try to get kv ' + key);
    try {
        const compressed = await env.KV.get(key);
        if (compressed == null) {
            return null
        }

        return JSON.parse(compressed);
        // return JSON.parse(LZString.decompressFromUTF16(compressed));
    } catch (e) {
        console.warn(`failed to get kv ${key}: ${e}`);
        return null;
    }
}

export const kvSet = async (env, key, val, ttl = DefaultCacheTTLSec) => {
    console.log(`try to set kv ${key}`);

    try {
        // const payload = LZString.compressToUTF16(JSON.stringify(val));
        const payload = JSON.stringify(val);

        return await env.KV.put(key, payload, {
            expirationTtl: ttl
        });
    } catch (e) {
        console.warn(`failed to set kv ${key}: ${e}`);
        return null;
    }
}

export const bucketGet = async (env, key) => {
    console.log(`try to get bucket ${key}`);
    try {
        const object = await env.BUCKET.get(key);
        if (object === null) {
            console.debug(`R2 object "${key}" not found`);
            return null;
        }

        const payload = JSON.parse(await object.text());
        if (payload.expiration != 0 && payload.expiration < Date.now()) {
            console.debug(`R2 object "${key}" expired`);
            return null;
        }

        return payload.data;
    } catch (e) {
        console.warn(`failed to get bucket ${key}: ${e}`);
        return null;
    }
}

export const bucketSet = async (env, key, val, ttl = DefaultCacheTTLSec) => {
    console.log(`try to set bucket key=${key}`);
    try {
        const payload = JSON.stringify({
            data: val,
            expiration: Date.now() + ttl * 1000
        });

        await env.BUCKET.put(key, payload);
    } catch (e) {
        console.warn(`failed to set bucket ${key}: ${e}`);
        return null;
    }
}
