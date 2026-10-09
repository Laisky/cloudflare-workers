'use strict';

import {
    kvSet,
    headersFromArray,
    headersToArray,
    setDefaultCachePrefix,
    sendErrorAlert
} from '@laisky/cf-utils';
import { sha256 } from 'js-sha256';
import { readBodyWithinLimit, responseWithBody } from "../../shared/body-limits.js";
import { parseBoundedJson, assertBoundedJson } from "../../shared/json-limits.js";
import { createBoundedCache } from "../../shared/bounded-cache.js";
import { isPublicCacheRequest, isPublicCacheResponse } from "../../shared/cache-policy.js";
import { scheduleRefresh } from "./refresh.js";

const MAX_CACHE_BODY_BYTES = 1024 * 1024;
const MAX_GQL_REQUEST_BYTES = 64 * 1024;
const MAX_CARD_BYTES = 64 * 1024;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** boundedTextResponse buffers processable text and preserves larger origin responses as streams. */
async function boundedTextResponse(response, limit = MAX_CACHE_BODY_BYTES) {
    const bounded = await readBodyWithinLimit(response.body, limit);
    return bounded.bytes === null
        ? { ok: false, response: responseWithBody(response, bounded.stream) }
        : { ok: true, text: decoder.decode(bounded.bytes), bytes: bounded.bytes };
}

/** isTextResponse excludes binary origin assets from text decoding and cache mutation. */
function isTextResponse(response) {
    const type = response.headers.get("Content-Type");
    return !type || /^(text\/|application\/(?:json|[^;]+\+json|xml|javascript)|image\/svg\+xml)/i.test(type);
}


/* cache for site page and GraphQL query

Listening on routes:

    * blog.laisky.com
    * blog.laisky.com/p/*
    * blog.laisky.com/pages/*
    * blog.laisky.com/graphql/query/*
    * gq.laisky.com/*

Caching strategy (write-frequency reduction without lowering hit rate):

  - SWR envelope: every cached value carries {staleAt, expiresAt, hash, delta}.
    The physical store lives for HARD_TTL (long, keeps hit rate high); logical
    freshness is the much shorter SOFT_TTL. Fresh hits serve with zero writes;
    stale hits serve immediately and revalidate in the background.
  - write-on-change-only: before any write we compare sha256(body) against the
    stored hash. Identical content is never re-written (closes the text/html
    write hole where browser navigations bypassed the READ but wrote on every
    request). Unchanged-but-stale entries get a cheap KV-only freshness touch.
  - KV-only writes: real content changes and freshness touches use the same
    KV keys and seven-day physical lifetime; no R2 reads or writes.
  - XFetch single-flight: revalidation is gated by probabilistic early
    expiration so a post-expiry stampede collapses toward a single refresh.

NOTE: keep the cache prefix stable. Bumping it cold-misses the whole cache and
temporarily tanks hit rate, which is exactly what we are trying to avoid.

Previously written R2 objects are left to their existing bucket lifecycle.
This Worker no longer binds or accesses those buckets.
*/

const CACHE_PREFIX = "blog-v2.25/"; // Increment version or use a date
setDefaultCachePrefix(CACHE_PREFIX);
const { cacheGet, kvGet } = createBoundedCache(
    CACHE_PREFIX, sha256, MAX_CACHE_BODY_BYTES, MAX_CACHE_BODY_BYTES * 6 + 128 * 1024,
    value => {
        const response = new Response(null, { headers: headersFromArray(value.headers) });
        return isTextResponse(response) && isPublicCacheResponse(response);
    }
);

const GraphqlAPI = "https://gq.laisky.com/query/";

// --- caching tunables ---
const HARD_TTL = 7 * 24 * 3600;     // physical lifetime of a cache entry (KV expirationTtl)
const SOFT_TTL_HTML = 24 * 3600;    // logical freshness window for HTML pages
const SOFT_TTL_GQL = 600;           // logical freshness window for GraphQL queries
const BETA = 1.5;                   // XFetch aggressiveness (>=1; higher = refresh earlier)
const DEFAULT_DELTA_MS = 200;       // assumed origin-fetch cost for legacy entries lacking `delta`
const EXPIRY_MARGIN_MS = 60 * 1000; // force one refresh this long before physical expiry

/**
 * ck derives the physical cache key exactly as cf-utils cacheGet/cacheSet do,
 * so the low-level kvGet/kvSet helpers address the same slot.
 *
 * @param {string} key - logical cache key
 * @returns {string}
 */
const ck = (key) => `${CACHE_PREFIX}${sha256(key)}`;

export default {
    async fetch(request, env, ctx) { // Add ctx for waitUntil
        try {
            return await handleRequest(request, env, ctx);
        } catch (e) {
            console.error(`Error handling request: ${request.url}`, e.stack);

            // Send error alert asynchronously
            ctx.waitUntil(sendErrorAlert(env,
                "laisky-blog",
                `${e.message}`,
                e.stack));

            // Provide a generic error message to the client
            return new Response(`Internal Server Error: ${e.message}`, {
                status: 500
            });
        }
    }
};


// dispatcher
async function handleRequest(request, env, ctx) {
    console.log("Handling request: " + request.url);
    const url = new URL(request.url);
    const pathname = url.pathname;

    // 1. Redirect root path
    if (pathname === "/" || pathname === "") { // Explicitly check empty string too
        const redirectUrl = new URL(request.url);
        redirectUrl.pathname = "/pages/0/";
        console.log(`Redirecting to ${redirectUrl.href}`);
        return Response.redirect(redirectUrl.href, 302);
    }

    let response;

    // 2. Route based on path
    if (pathname.startsWith("/p/")) {
        console.log("Routing to: insertTwitterCard");
        response = await insertTwitterCard(request, env, ctx, pathname);
    } else if (pathname.startsWith("/query/") || pathname.startsWith("/graphql/query/")) {
        console.log("Routing to: cacheGqQuery");
        response = await cacheGqQuery(request, env, ctx, pathname);
    } else {
        console.log(`Routing to: generalCache for ${pathname}`);
        response = await generalCache(request, env, ctx);
    }

    return response;
}

/**
 * isCacheEnable check whether to enable cache READS for this request.
 *
 * Note: this gates the read path only. The write path is gated separately by
 * writeIfChanged (content-hash compare), so a cache-disabled request still
 * refreshes the stored copy when — and only when — the content actually changed.
 *
 * @param {Request} request - request object
 * @param {Boolean} cachePost - whether to enable cache for POST method
 * @returns {Boolean}
 */
function isCacheEnable(request, cachePost = false) {
    if (!isPublicCacheRequest(request)) return false;
    const url = new URL(request.url);
    const cacheControl = request.headers.get("Cache-Control") || "";
    const requestContentType = request.headers.get("Accept") || "";

    // Disable cache if force query param is set
    if (url.searchParams.get("force") !== null) {
        console.log("Cache disabled: 'force' query parameter present.");
        return false;
    }

    // Disable cache based on headers (more robust check)
    if (
        request.headers.get("Pragma") === "no-cache" ||
        cacheControl.includes("no-cache") ||
        cacheControl.includes("no-store") ||
        cacheControl.includes("max-age=0")
    ) {
        console.log(`Cache disabled: Header Pragma or Cache-Control (${cacheControl})`);
        return false;
    }

    // Disable cache for text/html content types
    if (requestContentType.includes("text/html")) {
        console.log("Cache disabled: HTML content type detected");
        return false;
    }

    // Enable based on method
    switch (request.method) {
        case "GET":
            return true;
        case "POST":
            return cachePost;
        default:
            console.log(`Cache disabled: Method ${request.method} not GET/POST.`);
            return false;
    }
}

/**
 * canonicalJson produces a stable, key-sorted serialization used only for
 * content hashing, so backend field-order nondeterminism does not flip the
 * change-detection hash. The stored body remains the real, unmodified payload.
 *
 * @param {any} v
 * @returns {string}
 */
function canonicalJson(v) {
    if (v === null || typeof v !== "object") {
        return JSON.stringify(v);
    }
    if (Array.isArray(v)) {
        return "[" + v.map(canonicalJson).join(",") + "]";
    }
    const keys = Object.keys(v).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}

/**
 * shouldRevalidate decides — on EVERY hit, against the FUTURE soft deadline —
 * whether this request should trigger a background revalidation.
 *
 * Uses XFetch (Vattani et al.) probabilistic early expiration: as `now`
 * approaches `staleAt`, the chance that any single caller fires rises, so a
 * post-expiry stampede collapses toward ~one refresh. A deterministic backstop
 * forces exactly one refresh shortly before the physical expiry so a hot key
 * never falls off HARD_TTL into a true cold miss.
 *
 * @param {Object} cached - the stored envelope
 * @returns {Boolean}
 */
function shouldRevalidate(cached) {
    const now = Date.now();
    const staleAt = cached.staleAt || 0;       // legacy entry (no staleAt) -> treat as due
    const expiresAt = cached.expiresAt || 0;
    const delta = cached.delta || DEFAULT_DELTA_MS;

    // Deterministic backstop: refresh once before physical expiry.
    if (expiresAt && now >= expiresAt - EXPIRY_MARGIN_MS) {
        return true;
    }

    // XFetch probabilistic early refresh. -ln(rand) in (0, inf); avoid rand==0.
    const rand = Math.random() || Number.MIN_VALUE;
    return (now - delta * BETA * Math.log(rand)) >= staleAt;
}

/**
 * serveFromCache builds the client response from a stored envelope and tags it
 * with the freshness state for observability.
 *
 * @param {Object} cached - stored envelope
 * @param {Boolean} isStale
 * @returns {Response}
 */
function serveFromCache(cached, isStale) {
    const headers = headersFromArray(cached.headers);
    headers.set("X-Laisky-Cf-Cache-Status", isStale ? "STALE" : "FRESH");
    return new Response(cached.body, {
        status: cached.status || 200,
        headers: headers
    });
}

/**
 * freshResponse builds a client response for a live (origin) body and tags its
 * cache status (MISS for a real cache miss, BYPASS for a cache-disabled read).
 *
 * @param {Object} produced - producer result
 * @param {Headers|Array} headersSource - Headers (origin) or array (stored form)
 * @param {string} cacheStatus
 * @returns {Response}
 */
function freshResponse(produced, headersSource, cacheStatus) {
    const headers = headersSource instanceof Headers
        ? new Headers(headersSource)
        : headersFromArray(headersSource);
    headers.set("X-Laisky-Cf-Cache-Status", cacheStatus);
    return new Response(produced.body, {
        status: produced.status,
        headers: headers
    });
}

/**
 * writeIfChanged is the single write gate for every cache path. It writes only
 * when the content actually changed; an unchanged-but-stale entry gets a cheap
 * KV-only freshness touch, and an unchanged-and-fresh entry is left untouched.
 *
 * Returns a promise the caller should pass to ctx.waitUntil (no nested
 * waitUntil, so it also composes inside background revalidation).
 *
 * @param {Object} env
 * @param {string} key - logical cache key
 * @param {Object} produced - {body, status, storeHeaders, deltaMs, hashInput?}
 * @param {Object} opts - {softTtl, prior} where prior is the existing envelope or null
 * @returns {Promise<void>}
 */
async function writeIfChanged(env, key, produced, { softTtl, prior }) {
    if (!isPublicCacheResponse(new Response(null, { headers: headersFromArray(produced.storeHeaders) }))) return;
    if (produced.body.length > MAX_CACHE_BODY_BYTES
        || encoder.encode(produced.body).byteLength > MAX_CACHE_BODY_BYTES) return;
    const now = Date.now();
    const hash = sha256(produced.hashInput != null ? produced.hashInput : produced.body);

    if (prior && prior.hash === hash) {
        if (!prior.staleAt || now < prior.staleAt) {
            // Unchanged and still fresh: write nothing at all.
            console.log(`Cache unchanged+fresh, skip write: [cache key]`);
            return;
        }
        // Unchanged but stale: retain the existing KV-only freshness touch.
        console.log(`Cache unchanged, KV-only staleAt touch: [cache key]`);
        await kvSet(env, ck(key), { ...prior, staleAt: now + softTtl * 1000 }, HARD_TTL);
        return;
    }

    // Absent or changed: write KV with the unchanged long physical TTL.
    console.log(`Cache write (changed/new): [cache key]`);
    const envelope = {
        body: produced.body,
        headers: produced.storeHeaders,
        status: produced.status,
        hash: hash,
        delta: produced.deltaMs || DEFAULT_DELTA_MS,
        staleAt: now + softTtl * 1000,
        expiresAt: now + HARD_TTL * 1000
    };
    await kvSet(env, ck(key), envelope, HARD_TTL);
}

/**
 * generalCache cache for everything else
 */
async function generalCache(request, env, ctx) {
    console.log(`generalCache for ${request.url}`);

    const cacheKey = `general:${request.method}:${request.url}`;
    let didRead = false;
    let cached = null;

    try {
        // 1. Read-through (skipped when cache is disabled for this request).
        if (isCacheEnable(request, false)) {
            didRead = true;
            cached = await cacheGet(env, cacheKey);
            if (cached != null) {
                const isStale = !cached.staleAt || Date.now() >= cached.staleAt;
                console.log(`generalCache ${isStale ? "STALE" : "FRESH"} hit for [cache key]`);
                if (shouldRevalidate(cached)) {
                    scheduleRefresh(ctx, cacheKey, () => revalidateGeneral(env, request, cacheKey, cached)
                        .catch((err) => console.error(`generalCache revalidate failed for [cache key]:`, err)));
                }
                return serveFromCache(cached, isStale);
            }
        }

        // 2. Miss or bypass: fetch origin and (conditionally) refresh the cache.
        const produced = await produceGeneral(request, cacheKey);
        if (!produced.ok) {
            return produced.response;
        }

        if (!isPublicCacheRequest(request)) return freshResponse(produced, produced.originHeaders, "BYPASS");
        const prior = didRead ? cached : await kvGet(env, ck(cacheKey)).catch(() => null);
        ctx.waitUntil(writeIfChanged(env, cacheKey, produced, { softTtl: SOFT_TTL_HTML, prior })
            .catch((err) => console.error(`generalCache write failed for [cache key]:`, err)));

        return freshResponse(produced, produced.originHeaders, didRead ? "MISS" : "BYPASS");
    } catch (error) {
        console.error(`Error in generalCache for [cache key]:`, error);
        // Last resort - fetch again without caching
        return fetch(request);
    }
}

/**
 * produceGeneral fetches the origin and packages the data needed both to serve
 * the client and to (conditionally) write the cache. Used by the foreground
 * miss path and the background revalidation path.
 */
async function produceGeneral(request, cacheKey) {
    const start = Date.now();
    const response = await fetch(request);
    const deltaMs = Date.now() - start;

    if (!response.ok || response.status !== 200) {
        console.warn(`generalCache: origin status ${response.status}, not caching`);
        return { ok: false, response: response };
    }

    if (!isTextResponse(response)) return { ok: false, response };
    const bounded = await boundedTextResponse(response);
    if (!bounded.ok) return bounded;
    const body = bounded.text;
    const storeHeaders = headersToArray(response.headers);
    storeHeaders.push(["X-Laisky-Cf-Cache-Key", cacheKey]);

    return {
        ok: true,
        body: body,
        status: response.status,
        storeHeaders: storeHeaders,
        originHeaders: response.headers,
        deltaMs: deltaMs
    };
}

async function revalidateGeneral(env, request, cacheKey, prior) {
    const produced = await produceGeneral(request, cacheKey);
    if (!produced.ok) {
        await produced.response.body?.cancel("Unused background refresh response");
        return; // keep the existing entry on origin failure
    }
    await writeIfChanged(env, cacheKey, produced, { softTtl: SOFT_TTL_HTML, prior });
}


// insert twitter card into post page's html head
async function insertTwitterCard(request, env, ctx, pathname) {
    const cacheKey = `post:${request.method}:${pathname}`;
    console.log(`InsertTwitterCard: Key=[cache key]`);

    let didRead = false;
    let cached = null;

    // 1. Read-through.
    if (isCacheEnable(request, true)) {
        didRead = true;
        cached = await cacheGet(env, cacheKey);
        if (cached && typeof cached === "object" && cached.body != null) {
            const isStale = !cached.staleAt || Date.now() >= cached.staleAt;
            console.log(`InsertTwitterCard: ${isStale ? "STALE" : "FRESH"} HIT [cache key]`);
            if (shouldRevalidate(cached)) {
                scheduleRefresh(ctx, cacheKey, () => revalidatePost(env, request, pathname, cacheKey, cached)
                    .catch((err) => console.error(`InsertTwitterCard revalidate failed for [cache key]:`, err)));
            }
            return serveFromCache(cached, isStale);
        }
        console.log(`InsertTwitterCard: MISS [cache key]`);
    } else {
        console.log(`InsertTwitterCard: BYPASS [cache key]`);
    }

    // 2. Miss or bypass: build the (card-injected) page.
    const produced = await producePost(request, pathname, cacheKey);
    if (!produced.ok) {
        return produced.response; // origin error or unparsable path: serve unmodified, do not cache
    }

    // Don't clobber an existing good entry when the card fetch failed transiently.
    if (!isPublicCacheRequest(request)) return freshResponse(produced, produced.storeHeaders, "BYPASS");
    const prior = didRead ? cached : await kvGet(env, ck(cacheKey)).catch(() => null);
    if (produced.cardFetchFailed && prior) {
        console.warn(`InsertTwitterCard: card fetch failed, preserving cached entry [cache key]`);
    } else {
        ctx.waitUntil(writeIfChanged(env, cacheKey, produced, { softTtl: SOFT_TTL_HTML, prior })
            .catch((err) => console.error(`InsertTwitterCard write failed for [cache key]:`, err)));
    }

    return freshResponse(produced, produced.storeHeaders, didRead ? "MISS" : "BYPASS");
}

/**
 * producePost fetches the post page and injects the Twitter card. Returns
 * ok:false (with the raw response) when the page request fails or the post name
 * cannot be extracted, so the caller serves the unmodified page without caching.
 */
async function producePost(request, pathname, cacheKey) {
    const start = Date.now();
    const pageResp = await fetch(request);
    const deltaMs = Date.now() - start;

    if (!pageResp.ok) {
        console.warn(`InsertTwitterCard: Failed to fetch page ${request.url}, status: ${pageResp.status}`);
        return { ok: false, response: pageResp };
    }

    if (!isTextResponse(pageResp)) return { ok: false, response: pageResp };
    if (pageResp.status === 204 || pageResp.status === 205 || pageResp.body === null) return { ok: false, response: pageResp };
    const bounded = await boundedTextResponse(pageResp);
    if (!bounded.ok) return bounded;
    let html = bounded.text;

    const postNameMatch = /\/p\/([^/?#]+)/.exec(pathname);
    if (!postNameMatch || !postNameMatch[1]) {
        console.error(`InsertTwitterCard: Could not extract post name from pathname: ${pathname}`);
        return { ok: false, response: responseWithBody(pageResp, bounded.bytes) };
    }
    const postName = postNameMatch[1];

    console.log(`InsertTwitterCard: Fetching Twitter card for post: ${postName}`);
    const queryBody = JSON.stringify({
        operationName: "blog",
        query: `query blog { BlogTwitterCard(name: "${postName}") }`,
        variables: {}
    });

    let twitterCard = '';
    let cardFetchFailed = false;
    try {
        const cardResp = await fetch(GraphqlAPI, {
            method: "POST",
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: queryBody
        });

        if (cardResp.ok) {
            const cardBody = await boundedTextResponse(cardResp, MAX_CARD_BYTES);
            if (!cardBody.ok) {
                await cardBody.response.body.cancel("Card exceeds processing budget");
                throw new RangeError("Twitter card exceeds processing budget");
            }
            const cardJson = parseBoundedJson(cardBody.text);
            twitterCard = cardJson?.data?.BlogTwitterCard || '';
            if (twitterCard) {
                console.log(`InsertTwitterCard: Successfully fetched Twitter card for ${postName}.`);
            } else {
                console.log(`InsertTwitterCard: Twitter card data empty or not found for ${postName}.`);
            }
        } else {
            // Transient failure: flag it so revalidation won't clobber a good entry.
            cardFetchFailed = true;
            console.warn(`InsertTwitterCard: Failed to fetch Twitter card (${cardResp.status}) for ${postName}.`);
        }
    } catch (e) {
        cardFetchFailed = true;
        console.error(`InsertTwitterCard: Error fetching or parsing Twitter card for ${postName}:`, e);
    }

    if (twitterCard) {
        html = html.replace(/<\/head>/i, twitterCard + '</head>');
        console.log(`InsertTwitterCard: Injected Twitter card for ${postName}.`);
    }

    const storeHeaders = headersToArray(pageResp.headers);
    storeHeaders.push(["X-Laisky-Cf-Cache", "SAVED"]);
    storeHeaders.push(["X-Laisky-Cf-Cache-Key", cacheKey]);

    return {
        ok: true,
        body: html,
        status: pageResp.status,
        storeHeaders: storeHeaders,
        deltaMs: deltaMs,
        cardFetchFailed: cardFetchFailed
    };
}

async function revalidatePost(env, request, pathname, cacheKey, prior) {
    const produced = await producePost(request, pathname, cacheKey);
    if (!produced.ok) {
        await produced.response.body?.cancel("Unused background refresh response");
        return;
    }
    if (produced.cardFetchFailed && prior) {
        // A background refresh must never overwrite a good entry with card-less HTML.
        console.warn(`InsertTwitterCard: revalidate card fetch failed, keeping [cache key]`);
        return;
    }
    await writeIfChanged(env, cacheKey, produced, { softTtl: SOFT_TTL_HTML, prior });
}



/**
 * denyGQ block some graphql requests
 *
 * @param {Object} reqBody
 * @returns {String} return a string reason if deny, otherwise return null
 */
function denyGQ(reqBody) {
    // Use optional chaining for safer access
    if (reqBody?.variables?.type === "pateo") {
        return "Denied: Pateo alert type is blocked.";
    }
    return null; // Denied reason is null if allowed
}

/**
 * buildOriginRequest reconstructs the request to send to the origin GraphQL
 * server. For POST it carries the parsed body so it can be (re)issued safely
 * from a background revalidation without touching the original request stream.
 */
function buildOriginRequest(request, reqData) {
    if (request.method === "POST") {
        return new Request(request.url, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify(reqData)
        });
    }
    return request;
}

// load and cache graphql read-only query
async function cacheGqQuery(request, env, ctx, pathname) {
    console.log(`CacheGqQuery: URL=${request.url} Method=${request.method}`);

    const url = new URL(request.url);
    let reqData;

    // 1. Prepare request data.
    if (request.method === "GET") {
        reqData = {
            query: url.searchParams.get("query"),
            variables: url.searchParams.get("variables")
        };
    } else if (request.method === "POST") {
        try {
            const bounded = await readBodyWithinLimit(request.body, MAX_GQL_REQUEST_BYTES, true);
            if (bounded.bytes === null) return new Response("GraphQL request is too large", { status: 413 });
            reqData = parseBoundedJson(decoder.decode(bounded.bytes));
        } catch (e) {
            console.error("CacheGqQuery: Failed to parse request JSON body:", e);
            return new Response("Invalid JSON body", { status: 400 });
        }

        const denyReason = denyGQ(reqData);
        if (denyReason) {
            console.warn(`CacheGqQuery: Denied - ${denyReason}`);
            return new Response(denyReason, { status: 403 });
        }
    } else {
        console.log(`CacheGqQuery: Bypass method ${request.method}.`);
        return fetch(request);
    }

    // 2. Basic query/mutation heuristic.
    const queryStr = reqData?.query?.trim() || '';
    if (!queryStr || !(queryStr.startsWith('query') || queryStr.startsWith('{'))) {
        console.log("CacheGqQuery: Bypass non-query request (heuristic).");
        return fetch(buildOriginRequest(request, reqData));
    }
    try { assertBoundedJson(reqData); }
    catch { return new Response("GraphQL request structure is too complex", { status: 400 }); }
    console.log("CacheGqQuery: Processing as query.");

    const cacheKey = `graphql:${request.method}:${pathname}:${JSON.stringify(reqData)}`;
    console.log("CacheGqQuery: Cache key prepared.");

    let didRead = false;
    let cached = null;

    // 3. Read-through.
    if (isCacheEnable(request, true)) {
        didRead = true;
        cached = await cacheGet(env, cacheKey);
        if (cached && typeof cached === "object" && cached.body != null) {
            const isStale = !cached.staleAt || Date.now() >= cached.staleAt;
            console.log(`CacheGqQuery: ${isStale ? "STALE" : "FRESH"} HIT [cache key]`);
            if (shouldRevalidate(cached)) {
                scheduleRefresh(ctx, cacheKey, () => revalidateGql(env, request, reqData, cacheKey, cached)
                    .catch((err) => console.error(`CacheGqQuery revalidate failed for [cache key]:`, err)));
            }
            return serveFromCache(cached, isStale);
        }
        console.log(`CacheGqQuery: MISS [cache key]`);
    } else {
        console.log(`CacheGqQuery: BYPASS [cache key]`);
    }

    // 4. Miss or bypass: fetch origin and (conditionally) refresh the cache.
    const originRequest = buildOriginRequest(request, reqData);
    const produced = await produceGql(originRequest, cacheKey);
    if (!produced.ok) {
        return produced.response;
    }

    if (!isPublicCacheRequest(request)) return freshResponse(produced, produced.originHeaders, "BYPASS");
    const prior = didRead ? cached : await kvGet(env, ck(cacheKey)).catch(() => null);
    ctx.waitUntil(writeIfChanged(env, cacheKey, produced, { softTtl: SOFT_TTL_GQL, prior })
        .catch((err) => console.error(`CacheGqQuery write failed for [cache key]:`, err)));

    return freshResponse(produced, produced.originHeaders, didRead ? "MISS" : "BYPASS");
}

/**
 * produceGql fetches the origin GraphQL server. Returns ok:false (with a raw
 * response) for transport errors, bodyless responses, unparsable JSON, or GraphQL-level errors, so
 * those payloads are served to the client but never cached.
 */
async function produceGql(originRequest, cacheKey) {
    const start = Date.now();
    const originResponse = await fetch(originRequest);
    const deltaMs = Date.now() - start;

    if (!originResponse.ok) {
        console.warn(`CacheGqQuery: Origin fetch failed (${originResponse.status}) for ${originRequest.url}.`);
        return { ok: false, response: originResponse };
    }

    if (originResponse.status === 204 || originResponse.status === 205 || originResponse.body === null) return { ok: false, response: originResponse };
    const bounded = await boundedTextResponse(originResponse);
    if (!bounded.ok) return bounded;
    let respBodyJson;
    try {
        respBodyJson = parseBoundedJson(bounded.text);
    } catch (e) {
        console.error("CacheGqQuery: Failed to parse origin JSON response:", e);
        return { ok: false, response: responseWithBody(originResponse, bounded.bytes) };
    }

    if (respBodyJson.errors) {
        console.warn(`CacheGqQuery: Origin response contains GraphQL errors: ${JSON.stringify(respBodyJson.errors)}`);
        return {
            ok: false,
            response: responseWithBody(originResponse, bounded.bytes)
        };
    }

    const body = bounded.text;
    const storeHeaders = headersToArray(originResponse.headers);
    storeHeaders.push(["X-Laisky-Cf-Cache", "SAVED"]);
    storeHeaders.push(["X-Laisky-Cf-Cache-Key", cacheKey]);

    return {
        ok: true,
        body: body,
        status: originResponse.status,
        storeHeaders: storeHeaders,
        originHeaders: originResponse.headers,
        deltaMs: deltaMs,
        hashInput: canonicalJson(respBodyJson) // hash on canonical form, store the real body
    };
}

async function revalidateGql(env, request, reqData, cacheKey, prior) {
    const originRequest = buildOriginRequest(request, reqData);
    const produced = await produceGql(originRequest, cacheKey);
    if (!produced.ok) {
        await produced.response.body?.cancel("Unused background refresh response");
        return;
    }
    await writeIfChanged(env, cacheKey, produced, { softTtl: SOFT_TTL_GQL, prior });
}
