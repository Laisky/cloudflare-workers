'use strict';

import * as LZString from 'lz-string';
import { sha256 } from 'js-sha256';


/* cache for site page and GraphQL query

Listening on routes:

    * blog.laisky.com
    * blog.laisky.com/*
    * blog.laisky.com/graphql/query/*
    * gq.laisky.com/*
*/

const
    graphqlAPI = "https://gq.laisky.com/query/",
    cacheTTLSec = 3600 * 24;

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
    if (isReadFromCache(request)) {
        const cached = await cacheGet("pages", cacheKey);
        if (cached != null) {
            return new Response(cached, {
                headers: {
                    "Content-Type": "text/html; charset=UTF-8"
                },
            });
        }
    }

    // direct request origin site (bypass CDN)
    console.log(`bypass page cache for ${pathname}`)
    const resp = await fetch(request);
    if (resp.status !== 200) {
        return resp;
    }

    const respBody = await resp.blob();
    if (isSaveToCache(request)) {
        console.log(`save blog page ${cacheKey} to cache`)
        await cacheSet("pages", cacheKey, {
            headers: cloneHeaders(resp.headers),
            body: respBody
        });
    }

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
        headers: cloneHeaders(resp.headers),
    });
}


// denyGQ block some graphql requests
function denyGQ(reqBody) {
    if (reqBody.variables && reqBody.variables.type == "pateo") {
        return true;
    }

    return false;
}

// load and cache graphql read-only query
async function cacheGqQuery(request) {
    console.log("cacheGqQuery for " + request.url)

    let url = new URL(request.url);

    if (request.method == "OPTIONS" || request.method == "HEAD") {
        let req = cloneRequestWithoutBody(request);
        return fetch(req);
    }

    let reqBody,
        newRequest;
    if (request.method == "GET") {
        reqBody = {
            "query": url.searchParams.get("query"),
            "variables": url.searchParams.get("variables")
        }

        newRequest = new Request(url, {
            method: request.method,
            headers: request.headers,
            referrer: request.referrer
        });
    } else {
        reqBody = await request.json();

        if (denyGQ(reqBody)) {
            // console.log("throw error" + denyGQ(reqBody));
            throw new Error("pateo alert is disabled");
        }

        newRequest = new Request(url, {
            method: request.method,
            headers: request.headers,
            body: JSON.stringify(reqBody),
            referrer: request.referrer
        });
    }

    console.log("gquery: " + reqBody['query']);
    if (!reqBody['query'].match(/^(query)?[ \w]*\{/)) {
        console.log("bypass mutation graphql request")
        return fetch(newRequest);
    }

    const queryID = sha256(request.method + JSON.stringify(reqBody) + JSON.stringify(request.headers));

    // load from cache
    if (isReadFromCache(request)) {
        const cached = await cacheGet("gq", queryID);
        if (cached != null
            && cached.headers != null
            && cached.body != null
            && cached.headers instanceof Array
            && cached.headers.length != 0) {
            console.log(`cache hit for ${queryID} with headers ${cached.headers}`);
            return newJSONResponse(cached.headers, cached.body);
        }
    }

    console.log('request: ' + newRequest.url);
    const resp = await fetch(newRequest);
    if (resp.status != 200) {
        // console.log("body", await resp.text());
        throw new Error("request upstream: " + resp.status + ": " + await resp.text());
    }

    const respBody = await resp.json();
    if (respBody.errors != null) {
        console.log("resp error: " + respBody);
        console.log(respBody.errors);
        throw new Error(respBody.errors);
    }

    if (isSaveToCache(request)) {
        console.log("save graphql query respons to cache")
        await cacheSet("gq", queryID, {
            headers: cloneHeaders(resp.headers),
            body: respBody
        });
    }

    return newJSONResponse(resp.headers, respBody);
}

function cloneHeaders(headers) {
    let hs = [];
    for (let [key, value] of headers.entries()) {
        hs.push([key, value]);
    }

    return hs;
}


// 根据 object 封装一个新的 response
function newJSONResponse(headers, body) {
    console.log("inject headers", headers);
    headers['Access-Control-Allow-Origin'] = '*';
    headers['access-control-allow-methods'] = 'GET, HEAD, POST, OPTIONS';
    headers['access-control-allow-headers'] = '*';
    headers['allow'] = 'OPTIONS, GET, POST';
    return new Response(JSON.stringify(body), {
        headers: headers
    });
}

// load and cache blog posts
async function cachePosts(request, pathname) {
    console.log("cachePosts for " + pathname);
    const postName = /\/posts\/(.+?)\//.exec(pathname)[1];

    // load from cache
    if (isReadFromCache(request)) {
        const cached = await cacheGet("posts", postName);
        if (cached != null) {
            return new Response(JSON.stringify(cached), {
                headers: {
                    "Content-Type": "application/json"
                },
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

    const respJson = await resp.json();
    if (resp.status != 200) {
        throw new Error(resp.status + ": " + respJson);
    }

    if (isReadFromCache(request)) {
        console.log(`save blog post ${postName} respons to cache`)
        await cacheSet("posts", postName, {
            headers: cloneHeaders(resp.headers),
            body: respJson
        });
    }

    return newJSONResponse(resp.headers, respJson);
}

// set cache with compress
async function cacheSet(prefix, key, val) {
    key = prefix + "/" + key
    console.log("set cache " + key);
    const compressed = LZString.compressToUTF16(JSON.stringify(val));
    try {
        return await KVBlog.put(key, compressed, {
            expirationTtl: cacheTTLSec
        });
    } catch (e) {
        console.warn(`failed to set cache ${key}: ${e}`);
        return null;
    }
}

// get cache with decompress
async function cacheGet(prefix, key) {
    key = prefix + "/" + key
    console.log('get cache ' + key);
    const compressed = await KVBlog.get(key);
    if (compressed == null) {
        return null
    }

    return JSON.parse(LZString.decompressFromUTF16(compressed));
}
