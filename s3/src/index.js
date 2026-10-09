'use strict';

import { md5 } from 'js-md5';
import { sha256 } from 'js-sha256';
import {
    kvSet,
    headersFromArray,
    headersToArray,
    arrayBufferToBase64,
    arrayBufferFromBase64
} from '@laisky/cf-utils';

import { readBodyWithinLimit, responseWithBody } from "../../shared/body-limits.js";
import { createBoundedCache } from "../../shared/bounded-cache.js";

import { isPublicCacheRequest, isPublicCacheResponse } from "../../shared/cache-policy.js";

const CACHE_PREFIX = "s3-v0.1/";
const HARD_TTL = 7 * 24 * 3600; // pinned cf-utils 0.0.5 cacheSet default, unchanged
const MAX_CACHE_BYTES = 1024 * 1024 - 1;
const { cacheGet } = createBoundedCache(CACHE_PREFIX, sha256, Math.ceil(MAX_CACHE_BYTES / 3) * 4, 2 * 1024 * 1024,
    value => isPublicCacheResponse(new Response(null, { headers: headersFromArray(value.headers) })));

export default {
    async fetch(request, env) {
        try {
            return await handleRequest(env, request);
        } catch (e) {
            console.error(`handle request failed: ${e}`);
            return new Response(e.stack, {
                status: 500
            });
        }
    }
};

// dispatcher
async function handleRequest(env, request) {
    console.log("handle request: " + request.url)
    const url = new URL(request.url),
        pathname = (url).pathname;

    let resp = null;
    if (/\/uploads\/twitter\/[^/]+\.[^.\\]+/.exec(pathname)) {
        resp = await redirect2HierachyDir(env, request);
    } else {
        resp = await fetch(request);
    }

    console.log(">> resp: ", resp);
    return resp;
}


// redirect file url to hierachy dir by prefix of md5
async function redirect2HierachyDir(env, request) {
    console.log(`redirect2HierachyDir: ${request.url}`);
    const url = new URL(request.url),
        pathname = (url).pathname,
        path = pathname.split("/"),
        filename = path[path.length - 1],
        fMd5 = md5(filename),
        redirect_url = `https://s3.laisky.com/uploads/twitter/${fMd5.substring(0, 2)}/${fMd5.substring(2, 4)}/${filename}`;

    // check cache
    const cacheKey = `redirect2HierachyDir:${pathname}`;
    const canCache = request.method === "GET" && isPublicCacheRequest(request);
    if (canCache) {
        const cached = await cacheGet(env, cacheKey);
        if (cached) {
            return new Response(arrayBufferFromBase64(cached.body), {
                headers: headersFromArray(cached.headers)
            });
        }
    }

    console.log("redirect to " + redirect_url);
    const resp = await fetch(new Request(redirect_url, {
        method: request.method,
        headers: request.headers,
        referrer: request.referrer
    }));

    // if content size < 1mb
    if (canCache && resp.status === 200 && isPublicCacheResponse(resp)) {
        const length = resp.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_CACHE_BYTES)) return resp;
        const bounded = await readBodyWithinLimit(resp.body, MAX_CACHE_BYTES);
        if (bounded.bytes === null) return responseWithBody(resp, bounded.stream);
        const body = bounded.bytes.buffer;

        await kvSet(env, CACHE_PREFIX + sha256(cacheKey), {
            headers: headersToArray(resp.headers),
            body: arrayBufferToBase64(body)
        }, HARD_TTL);

        return new Response(body, {
            headers: resp.headers
        });
    }

    return resp;
}
