'use strict';

import * as LZString from 'lz-string';
import { sha256 } from 'js-sha256';


/* cache for site page and GraphQL query

Listening on routes:

    * blog.laisky.com
    * blog.laisky.com/p/*
    * blog.laisky.com/pages/*
    * blog.laisky.com/graphql/query/*
    * gq.laisky.com/*
*/

const
    cachePrefix = "blog-v2.3/",
    graphqlAPI = "https://gq.laisky.com/query/",
    cacheTTLSec = 3600 * 24;  // 1day

addEventListener("fetch", (event) => {
    event.respondWith(
        handleRequest(event.request).catch(
            (err) => {
                console.error(err);
                return new Response(err.stack, {
                    status: 500
                });
            }
        )
    );
});


// dispatcher
async function handleRequest(request) {
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
        resp = await insertTwitterCard(request, pathname);
    } else if (pathname.startsWith("/query/") || pathname.startsWith("/graphql/query/")) {
        console.log("await cacheGqQuery")
        resp = await cacheGqQuery(request);
    } else {
        console.log(`await generalCache for ${pathname}`)
        resp = await generalCache(request, pathname);
    }

    return resp;
}

/**
 * isCacheEnable check whether to enable cache
 *
 * @param {Request} request
 * @param {Boolean} allowPost
 * @returns
 */
function isCacheEnable(request, allowPost = false) {
    console.log("method", request.method);
    if ((new URL(request.url)).searchParams.get("force") != null) {
        return false;
    }

    switch (request.method) {
        case "GET":
            return true;
        case "POST":
            return allowPost;
        default:
            return false;
    }
}

// cache anything
async function generalCache(request, pathname) {
    console.log(`generalCache for ${pathname}`)
    const cachePrefix = "general";

    const cacheKey = sha256(`${request.method}:${request.url}`);
    console.log(`cacheKey: ${cacheKey}`);

    // load from cache
    if (!isCacheEnable(request)) {
        console.log("cache disabled")
        return await fetch(request);
    }

    const cached = await cacheGet(cachePrefix, cacheKey);
    if (cached != null) {
        console.log(`hit cache`);
        return new Response(cached.body, {
            headers: headersFromArray(cached.headers)
        });
    }

    // direct request origin site (bypass CDN)
    console.log(`bypass page cache for cache miss`);
    const resp = await fetch(request);
    if (resp.status !== 200) {
        console.warn(`failed to directly fetch ${resp.status}`);
        return resp;
    }

    console.log(`save to cache`)
    const respBody = await resp.text();
    await cacheSet(cachePrefix, cacheKey, {
        headers: headersToArray(resp.headers),
        body: respBody
    });

    console.log(`return from origin`);
    return new Response(respBody, {
        headers: resp.headers,
    });
}

function cloneRequestWithoutBody(request) {
    let url = new URL(request.url);
    return new Request(url.href, {
        method: request.method,
        headers: request.headers,
        referrer: request.referrer
    });
}

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
async function insertTwitterCard(request, pathname) {
    console.log("insertTwitterCard for " + pathname);
    // load twitter card
    const postName = /\/p\/([^/?#]+)\/?[?#]?/.exec(pathname)[1];
    const queryBody = JSON.stringify({
        operationName: "blog",
        query: 'query blog {BlogTwitterCard(name: "' + postName + '")}',
        variables: {}
    });
    const cardResp = await fetch(graphqlAPI, {
        method: "POST",
        headers: {
            'Content-Type': 'application/json'
        },
        body: queryBody
    });
    if (cardResp.status != 200) {
        throw new Error(queryBody + "\n" + cardResp.status + ": " + await cardResp.text());
    }

    let twitterCard = null;
    try {
        twitterCard = (await cardResp.json())['data']['BlogTwitterCard'];
    } catch (e) {
        console.error(e);
    }
    console.debug("got twitter card: " + twitterCard);

    const newRequest = cloneRequestWithoutBody(request);
    const resp = await fetch(newRequest);
    let html = await resp.text();
    // console.debug("got raw resp: " + html);
    if (twitterCard != null) {
        html = html.replace(/<\/head>/, twitterCard + '</head>');
    }

    return new Response(html, {
        headers: headersToArray(resp.headers),
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
async function cacheGqQuery(request) {
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

    const cacheID = sha256(request.method + url + JSON.stringify(reqData));

    // load from cache
    if (!isCacheEnable(request, true)) {
        console.log("cache disabled")
        return await fetch(request);
    }

    const cached = await cacheGet("gq", cacheID);
    if (cached != null) {
        console.log(`cache hit for ${cacheID} with headers ${cached.headers}`);
        return new Response(cached.body, {
            headers: headersFromArray(cached.headers)
        });
    }

    console.log(`bypass graphql cache for cache miss`);
    const resp = await fetch(request);
    if (resp.status != 200) {
        console.warn(`failed to fetch ${resp.status}`);
        return resp;
    }

    const respBody = await resp.json();
    if (respBody.errors != null) {
        console.log("resp error: " + respBody);
        throw new Error(respBody.errors);
    }

    console.log("save graphql query respons to cache")
    await cacheSet("gq", cacheID, {
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


// set cache with compress
async function cacheSet(prefix, key, val) {
    const cacheKey = cachePrefix + prefix + "/" + key
    console.log(`set cache ${cacheKey}, val: ${JSON.stringify(val)}`);
    const compressed = LZString.compressToUTF16(JSON.stringify(val));
    try {
        return await KV.put(cacheKey, compressed, {
            expirationTtl: cacheTTLSec
        });
    } catch (e) {
        console.warn(`failed to set cache ${cacheKey}: ${e}`);
        return null;
    }
}

// get cache with decompress
async function cacheGet(prefix, key) {
    const cacheKey = cachePrefix + prefix + "/" + key
    console.log('get cache ' + cacheKey);
    const compressed = await KV.get(cacheKey);
    if (compressed == null) {
        return null
    }

    return JSON.parse(LZString.decompressFromUTF16(compressed));
}
