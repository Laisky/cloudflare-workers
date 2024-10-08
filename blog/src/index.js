'use strict';

// import * as LZString from 'lz-string';
import { sha256 } from 'js-sha256';


/* cache for site page and GraphQL query

Listening on routes:

    * blog.laisky.com
    * blog.laisky.com/p/*
    * blog.laisky.com/pages/*
    * blog.laisky.com/graphql/query/*
    * gq.laisky.com/*
*/

const CachePrefix = "blog-v2.16/",
    GraphqlAPI = "https://gq.laisky.com/query/",
    DefaultCacheTTLSec = 3600 * 24 * 7;  // 7day

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
    let url = new URL(request.url),
        pathname = (url).pathname;
    let resp = null;

    // jump to landing page
    if (pathname == "" || pathname == "/") {
        let url = new URL(request.url);
        url.pathname = "/pages/0/"
        console.log("302 jump to blog landing page")
        return Response.redirect(url.href, 302);
    }

    // cache
    if (pathname.startsWith("/p/")) {
        console.log("await insertTwitterCard")
        resp = await insertTwitterCard(env, request, pathname);
    } else if (pathname.startsWith("/query/") || pathname.startsWith("/graphql/query/")) {
        console.log("await cacheGqQuery")
        resp = await cacheGqQuery(env, request, pathname);
    } else {
        console.log(`await generalCache for ${pathname}`)
        // resp = await fetch(request);
        resp = await generalCache(env, request, pathname);
    }

    return resp;
}

/**
 * isCacheEnable check whether to enable cache
 *
 * @param {Request} request - request object
 * @param {Boolean} cachePost - whether to enable cache for POST method
 * @returns {Boolean}
 */
function isCacheEnable(request, cachePost = false) {
    console.log("method", request.method);

    // disable cache if force query param is set
    if ((new URL(request.url)).searchParams.get("force") != null) {
        return false;
    }

    // if diaable cache in headers
    // if (request.headers.get("Cache-Control") == "no-cache"
    //     || request.headers.get("Cache-Control") == "max-age=0"
    //     || request.headers.get("Pragma") == "no-cache") {
    //     return false;
    // }

    switch (request.method) {
        case "GET":
            return true;
        case "POST":
            return cachePost;
        default:
            return false;
    }
}

// cache anything
async function generalCache(env, request, pathname) {
    console.log(`generalCache for ${pathname}`)

    const cacheKey = `general:${request.method}:${pathname}`;
    console.log(`cacheKey: ${cacheKey}`);

    // load from cache
    let bypassCacheReason = "disabled";
    if (isCacheEnable(request, false)) {
        const cached = await cacheGet(env, cacheKey);
        bypassCacheReason = "cache-miss";
        if (cached != null) {
            console.log(`hit cache`);
            return new Response(cached.body, {
                headers: headersFromArray(cached.headers)
            });
        }
    }
    console.log(`bypass cache for ${bypassCacheReason}`);

    // direct request origin site (bypass CDN)
    const resp = await fetch(request);
    if (resp.status !== 200) {
        console.warn(`failed to directly fetch ${resp.status}`);
        return resp;
    }

    console.log(`save to cache`)
    const respBody = await resp.text();
    await cacheSet(env, cacheKey, {
        headers: headersToArray(resp.headers),
        body: respBody
    });

    console.log(`return from origin`);
    return new Response(respBody, {
        headers: resp.headers,
    });
}

// function cloneRequestWithoutBody(request) {
//     let url = new URL(request.url);
//     return new Request(url.href, {
//         method: request.method,
//         headers: request.headers,
//         referrer: request.referrer
//     });
// }

// async function cloneRequestWithBody(request) {
//     let url = new URL(request.url);
//     return new Request(url.href, {
//         method: request.method,
//         headers: request.headers,
//         referrer: request.referrer,
//         body: (await request.blob())
//     });
// }


// insert twitter card into post page's html head
async function insertTwitterCard(env, request, pathname) {
    console.log("insertTwitterCard for " + pathname);

    // load from cache
    let bypassCacheReason = "disabled";
    const cacheKey = `post:${request.method}:${pathname}`;
    if (isCacheEnable(request, true)) {
        const cached = await cacheGet(env, cacheKey);
        if (cached != null && typeof cached === "object") {
            console.log(`hit cache for ${cacheKey}`);
            // console.log(`cached headers: ${cached.headers}`);
            // console.log(`cached body: ${cached.body}`);
            return new Response(cached.body, {
                headers: headersFromArray(cached.headers)
            });
        }

        bypassCacheReason = "cache-miss";
    }
    console.log(`bypass cache for ${bypassCacheReason}`);

    const pageResp = await fetch(request);
    if (pageResp.status != 200) {
        console.warn(`failed to fetch request ${request.url}, got ${pageResp.status}`);
        return pageResp;
    }
    let html = await pageResp.text();

    // load twitter card
    const postName = /\/p\/([^/?#]+)\/?[?#]?/.exec(pathname)[1];
    const queryBody = JSON.stringify({
        operationName: "blog",
        query: 'query blog {BlogTwitterCard(name: "' + postName + '")}',
        variables: {}
    });
    const cardResp = await fetch(GraphqlAPI, {
        method: "POST",
        headers: {
            'Content-Type': 'application/json'
        },
        body: queryBody
    });
    if (cardResp.status != 200) {
        console.warn(`failed to fetch twitter card ${cardResp.status}`);
        return await fetch(request);
    }

    try {
        const twitterCard = (await cardResp.json())['data']['BlogTwitterCard'];
        if (twitterCard) {
            console.debug("got twitter card: " + twitterCard);
            html = html.replace(/<\/head>/, twitterCard + '</head>');
        }
    } catch (e) {
        console.error(e);
    }

    // set cache
    await cacheSet(env, cacheKey, {
        headers: headersToArray(pageResp.headers),
        body: html
    });

    return new Response(html, {
        headers: pageResp.headers,
    });
}



/**
 * denyGQ block some graphql requests
 *
 * @param {Object} reqBody
 * @returns {String} return a string reason if deny, otherwise return null
 */
function denyGQ(reqBody) {
    if (reqBody.variables && reqBody.variables.type == "pateo") {
        return "do not cache pateo alert";
    }

    return null;
}

// load and cache graphql read-only query
async function cacheGqQuery(env, request, pathname) {
    console.log("cacheGqQuery for " + request.url)

    let url = new URL(request.url);

    if (request.method != "GET" && request.method != "POST") {
        console.log("bypass non-GET/POST graphql request")
        return await fetch(request);
    }

    let reqData;
    if (request.method == "GET") {
        reqData = {
            "query": url.searchParams.get("query"),
            "variables": url.searchParams.get("variables")
        }
    } else {
        // read and copy request body
        reqData = await request.json();
        request = new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: JSON.stringify(reqData)
        });

        const denyReason = denyGQ(reqData)
        if (denyReason) {
            throw new Error(denyReason);
        }
    }

    console.log("gquery: " + reqData['query']);
    if (!reqData['query'].match(/^(query)?[ \w]*\{/)) {
        console.log("bypass mutation graphql request")
        return await fetch(request);
    }

    const cacheKey = `graphql:${request.method}:${pathname}:${JSON.stringify(reqData)}`;

    // load from cache
    let bypassCacheReason = "disabled";
    if (isCacheEnable(request, true)) {
        const cached = await cacheGet(env, cacheKey);
        bypassCacheReason = "cache-miss";
        if (cached != null) {
            console.log(`cache hit for ${cacheKey} with headers ${cached.headers}`);
            return new Response(cached.body, {
                headers: headersFromArray(cached.headers)
            });
        }
    }
    console.log(`bypass graphql cache for ${bypassCacheReason}`);

    const resp = await fetch(request);
    if (resp.status != 200) {
        console.warn(`failed to fetch ${resp.status}`);
        return resp;
    }

    const respBody = await resp.json();
    if (respBody.errors != null) {
        console.warn(`resp error: ${JSON.stringify(respBody.errors)}`);
        throw new Response(JSON.stringify(respBody), {
            headers: resp.headers,
        });
    }

    console.log("save graphql query respons to cache")
    await cacheSet(env, cacheKey, {
        headers: headersToArray(resp.headers),
        body: JSON.stringify(respBody)
    });

    return new Response(JSON.stringify(respBody), {
        headers: resp.headers
    });
}

/**
 * clone and convert Headers to Array,
 * make it be able to be serialized by JSON.stringify
 *
 * @param {Headers} headers
 * @returns
 */
function headersToArray(headers) {
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
function headersFromArray(hs) {
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
async function cacheSet(env, key, val, ttl = DefaultCacheTTLSec) {
    console.log(`try to set cache key=${key}, val=${val}, ttl=${ttl}`);
    const cacheKey = CachePrefix + sha256(key)
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
async function cacheGet(env, key) {
    const cacheKey = CachePrefix + sha256(key)
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

async function bucketGet(env, key) {
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

async function bucketSet(env, key, val, ttl = DefaultCacheTTLSec) {
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
