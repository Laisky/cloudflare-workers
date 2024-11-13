'use strict';

import {
    cacheSet,
    cacheGet,
    headersFromArray,
    headersToArray,
    setDefaultCachePrefix
} from '@laisky/cf-utils';


/* cache for site page and GraphQL query

Listening on routes:

    * blog.laisky.com
    * blog.laisky.com/p/*
    * blog.laisky.com/pages/*
    * blog.laisky.com/graphql/query/*
    * gq.laisky.com/*
*/

setDefaultCachePrefix("blog-v2.24/");

const GraphqlAPI = "https://gq.laisky.com/query/";

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

    // if disable cache in headers
    if (request.headers.get("Cache-Control") == "no-cache"
        || request.headers.get("Cache-Control") == "max-age=0"
        || request.headers.get("Pragma") == "no-cache") {
        return false;
    }

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
    console.log(`generalCache for ${request.url}`);

    const cacheKey = `general:${request.method}:${request.url}`;
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

    let headers = headersToArray(resp.headers);
    headers.push(["X-Laisky-Cf-Cache-Key", cacheKey]);

    await cacheSet(env, cacheKey, {
        headers: headers,
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

    let headers = headersToArray(pageResp.headers);
    headers.push(["X-Laisky-Cf-Cache-Key", cacheKey]);

    // set cache
    await cacheSet(env, cacheKey, {
        headers: headers,
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

    let headers = headersToArray(resp.headers);
    headers.push(["X-Laisky-Cf-Cache-Key", cacheKey]);

    console.log("save graphql query respons to cache")
    await cacheSet(env, cacheKey, {
        headers: headers,
        body: JSON.stringify(respBody)
    });

    return new Response(JSON.stringify(respBody), {
        headers: resp.headers
    });
}
