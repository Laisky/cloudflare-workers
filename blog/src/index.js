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
    cachePrefix = "blog-v2/",
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
    if (/^\/pages\/\d+\//.exec(pathname)) {
        console.log("await cachePages")
        resp = await cachePages(request, pathname);
    } else if (pathname.startsWith("/posts/")) {
        console.log("await cachePosts")
        resp = await cachePosts(request, pathname);
    } else if (pathname.startsWith("/p/")) {
        console.log("await insertTwitterCard")
        resp = await insertTwitterCard(request, pathname);
    } else if (pathname.startsWith("/query/") || pathname.startsWith("/graphql/query/")) {
        console.log("await cacheGqQuery")
        resp = await cacheGqQuery(request);
    } else {
        console.log(`not match any route, fetch directly`);
        resp = await fetch(request);
    }

    return resp;
}

// whether to force update cache
//
// `?force` will force to request raw site and refresh cache
function isReadFromCache(request) {
    console.log("method", request.method);
    if ((new URL(request.url)).searchParams.get("force") != null ||
        request.method == "OPTIONS" ||
        request.method == "DELETE") {
        return false;
    }

    // return false;
    return true;
}


// whether to force update cache
function isSaveToCache(request) {
    switch (request.method) {
        case "GET":
        case "HEAD":
        case "OPTIONS":
            return true;
        default:
            return false;
    }
}

// cache pages
async function cachePages(request, pathname) {
    console.log(`cachePages for ${pathname}`)

    const cacheKey = `${sha256(pathname)}`;

    // load from cache
    let bypassReason = 'skip_cache';
    if (isReadFromCache(request)) {
        const cached = await cacheGet("pages", cacheKey);
        bypassReason = 'cache_miss';
        if (cached != null) {
            return new Response(cached.body, {
                headers: headersFromArray(cached.headers)
            });
        }
    }

    // direct request origin site (bypass CDN)
    console.log(`bypass page cache for reason: ${bypassReason}`);
    const resp = await fetch(request);
    if (resp.status !== 200) {
        console.warn(`failed to directly fetch ${resp.status}`);
        return resp;
    }

    const respBody = await resp.text();
    if (isSaveToCache(request)) {
        console.log(`save blog page ${cacheKey} to cache`)

        console.log(`Response Body:`, respBody);
        console.log(`Response Headers:`, headersToArray(resp.headers));

        await cacheSet("pages", cacheKey, {
            headers: headersToArray(resp.headers),
            body: respBody
        });
    }

    console.log(`return blog page from origin`);
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
    let bypassReason = 'skip_cache';
    if (isReadFromCache(request)) {
        const cached = await cacheGet("gq", cacheID);
        bypassReason = 'cache_miss';
        if (cached != null) {
            console.log(`cache hit for ${cacheID} with headers ${cached.headers}`);
            return new Response(cached.body, {
                headers: headersFromArray(cached.headers)
            });
        }
    }

    console.log(`bypass graphql cache for reason: ${bypassReason}`);
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
    let hs = [];
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


// 根据 object 封装一个新的 response
// function newJSONResponse(headers, body) {
//     console.log("inject headers", headers);
//     headers['Access-Control-Allow-Origin'] = '*';
//     headers['access-control-allow-methods'] = 'GET, HEAD, POST, OPTIONS';
//     headers['access-control-allow-headers'] = '*';
//     headers['allow'] = 'OPTIONS, GET, POST';
//     return new Response(JSON.stringify(body), {
//         headers: headers
//     });
// }

// load and cache blog posts
async function cachePosts(request, pathname) {
    console.log("cachePosts for " + pathname);
    const postName = /\/posts\/(.+?)\//.exec(pathname)[1];

    // load from cache
    if (isReadFromCache(request)) {
        const cached = await cacheGet("posts", postName);
        if (cached != null) {
            return new Response(JSON.stringify(cached.body), {
                headers: headersFromArray(cached.headers)
            });
        }
    }

    // load from backend
    console.log("request blog post " + postName)
    const resp = await fetch(graphqlAPI, {
        method: "POST",
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            operationName: "blog",
            query: 'query blog {BlogPosts(name: "' + postName + '") {title,type,content,name,menu,tags,created_at,category {name,url}}}',
            variables: {}
        })
    });

    const respBody = await resp.text();
    if (resp.status != 200) {
        console.warn(`failed to fetch ${resp.status}`);
        return resp
    }

    if (isSaveToCache(request)) {
        console.log(`save blog post ${postName} respons to cache`)
        await cacheSet("posts", postName, {
            headers: headersToArray(resp.headers),
            body: respBody
        });
    }

    return new Response(respBody, {
        headers: resp.headers
    });
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
