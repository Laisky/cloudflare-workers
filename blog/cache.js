'use strict';


/* cache for site page and GraphQL query

Listening on routes:

    * blog.laisky.com
    * blog.laisky.com/p/*
    * blog.laisky.com/graphql/query/v2/*
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
        url.pathname = "/archives/1/"
        console.log("301 jump to blog landing page")
        return Response.redirect(url.href, 301);
    }

    // replace url to add tailing slash
    const matched = request.url.match(/^([^\?#]*\/)([^\?#\.\/]+)([\?#].*)?$/);
    if (matched) {
        let new_url = `${matched[1]}${matched[2]}/${matched[3] || ''}`;
        return Response.redirect(new_url, 301);
    }

    // cache
    if (/^\/archives\/\d+\//.exec(pathname)) {
        console.log("await cachePages")
        resp = await cachePages(request);
    } else if (pathname.startsWith("/posts/")) {
        console.log("await cachePosts")
        resp = await cachePosts(request, pathname);
    } else if (pathname.startsWith("/p/")) {
        console.log("await insertTwitterCard")
        resp = await insertTwitterCard(request, pathname);
    } else if (pathname.startsWith("/query/")) {
        console.log("await cacheGqQuery")
        resp = await cacheGqQuery(request);
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
    if ((new URL(request.url)).searchParams.get("force") != null) {
        return true;
    }

    return isReadFromCache(request);
}

// cache pages
async function cachePages(request) {
    console.log("cachePages for " + request.url)

    let url = new URL(request.url);

    // direct request origin site (bypass CDN)
    const newRequest = new Request(url.href, {
        method: request.method,
        headers: request.headers
    });
    newRequest.headers.set("referrer", request.referrer);

    const pageID = request.url.match(/archives\/(\d+)\//)[1];

    // load from cache
    if (isReadFromCache(request)) {
        const cached = await cacheGet("pages", pageID);
        if (cached != null) {
            return new Response(cached, {
                headers: {
                    "Content-Type": "text/html; charset=UTF-8"
                },
            });
        }
    }

    console.log('request: ' + newRequest.url);
    const resp = await fetch(newRequest);
    const respBody = await resp.text();
    // console.log("body", respBody);
    if (resp.status != 200) {
        throw new Error(resp.status + ": " + respBody);
    }

    if (isSaveToCache(request)) {
        console.log(`save blog page ${pageID} to cache`)
        await cacheSet("pages", pageID, {
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

async function cloneRequestWithBody(request) {
    let url = new URL(request.url);
    return new Request(url.href, {
        method: request.method,
        headers: request.headers,
        referrer: request.referrer,
        body: (await request.blob())
    });
}


// insert twitter card into post page's html head
async function insertTwitterCard(request, pathname) {
    console.log("insertTwitterCard for " + pathname);
    // load twitter card
    const postName = /\/p\/([^\/\?#]+)\/?[\?#]?/.exec(pathname)[1];
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

    const queryID = md5(request.method + JSON.stringify(reqBody) + JSON.stringify(request.headers));

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
    console.log("set cache " + key + JSON.stringify(val));
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



// lz-string 1.4.4
var LZString = function () { function o(o, r) { if (!t[o]) { t[o] = {}; for (var n = 0; n < o.length; n++)t[o][o.charAt(n)] = n } return t[o][r] } var r = String.fromCharCode, n = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=", e = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$", t = {}, i = { compressToBase64: function (o) { if (null == o) return ""; var r = i._compress(o, 6, function (o) { return n.charAt(o) }); switch (r.length % 4) { default: case 0: return r; case 1: return r + "==="; case 2: return r + "=="; case 3: return r + "=" } }, decompressFromBase64: function (r) { return null == r ? "" : "" == r ? null : i._decompress(r.length, 32, function (e) { return o(n, r.charAt(e)) }) }, compressToUTF16: function (o) { return null == o ? "" : i._compress(o, 15, function (o) { return r(o + 32) }) + " " }, decompressFromUTF16: function (o) { return null == o ? "" : "" == o ? null : i._decompress(o.length, 16384, function (r) { return o.charCodeAt(r) - 32 }) }, compressToUint8Array: function (o) { for (var r = i.compress(o), n = new Uint8Array(2 * r.length), e = 0, t = r.length; t > e; e++) { var s = r.charCodeAt(e); n[2 * e] = s >>> 8, n[2 * e + 1] = s % 256 } return n }, decompressFromUint8Array: function (o) { if (null === o || void 0 === o) return i.decompress(o); for (var n = new Array(o.length / 2), e = 0, t = n.length; t > e; e++)n[e] = 256 * o[2 * e] + o[2 * e + 1]; var s = []; return n.forEach(function (o) { s.push(r(o)) }), i.decompress(s.join("")) }, compressToEncodedURIComponent: function (o) { return null == o ? "" : i._compress(o, 6, function (o) { return e.charAt(o) }) }, decompressFromEncodedURIComponent: function (r) { return null == r ? "" : "" == r ? null : (r = r.replace(/ /g, "+"), i._decompress(r.length, 32, function (n) { return o(e, r.charAt(n)) })) }, compress: function (o) { return i._compress(o, 16, function (o) { return r(o) }) }, _compress: function (o, r, n) { if (null == o) return ""; var e, t, i, s = {}, p = {}, u = "", c = "", a = "", l = 2, f = 3, h = 2, d = [], m = 0, v = 0; for (i = 0; i < o.length; i += 1)if (u = o.charAt(i), Object.prototype.hasOwnProperty.call(s, u) || (s[u] = f++, p[u] = !0), c = a + u, Object.prototype.hasOwnProperty.call(s, c)) a = c; else { if (Object.prototype.hasOwnProperty.call(p, a)) { if (a.charCodeAt(0) < 256) { for (e = 0; h > e; e++)m <<= 1, v == r - 1 ? (v = 0, d.push(n(m)), m = 0) : v++; for (t = a.charCodeAt(0), e = 0; 8 > e; e++)m = m << 1 | 1 & t, v == r - 1 ? (v = 0, d.push(n(m)), m = 0) : v++, t >>= 1 } else { for (t = 1, e = 0; h > e; e++)m = m << 1 | t, v == r - 1 ? (v = 0, d.push(n(m)), m = 0) : v++, t = 0; for (t = a.charCodeAt(0), e = 0; 16 > e; e++)m = m << 1 | 1 & t, v == r - 1 ? (v = 0, d.push(n(m)), m = 0) : v++, t >>= 1 } l--, 0 == l && (l = Math.pow(2, h), h++), delete p[a] } else for (t = s[a], e = 0; h > e; e++)m = m << 1 | 1 & t, v == r - 1 ? (v = 0, d.push(n(m)), m = 0) : v++, t >>= 1; l--, 0 == l && (l = Math.pow(2, h), h++), s[c] = f++, a = String(u) } if ("" !== a) { if (Object.prototype.hasOwnProperty.call(p, a)) { if (a.charCodeAt(0) < 256) { for (e = 0; h > e; e++)m <<= 1, v == r - 1 ? (v = 0, d.push(n(m)), m = 0) : v++; for (t = a.charCodeAt(0), e = 0; 8 > e; e++)m = m << 1 | 1 & t, v == r - 1 ? (v = 0, d.push(n(m)), m = 0) : v++, t >>= 1 } else { for (t = 1, e = 0; h > e; e++)m = m << 1 | t, v == r - 1 ? (v = 0, d.push(n(m)), m = 0) : v++, t = 0; for (t = a.charCodeAt(0), e = 0; 16 > e; e++)m = m << 1 | 1 & t, v == r - 1 ? (v = 0, d.push(n(m)), m = 0) : v++, t >>= 1 } l--, 0 == l && (l = Math.pow(2, h), h++), delete p[a] } else for (t = s[a], e = 0; h > e; e++)m = m << 1 | 1 & t, v == r - 1 ? (v = 0, d.push(n(m)), m = 0) : v++, t >>= 1; l--, 0 == l && (l = Math.pow(2, h), h++) } for (t = 2, e = 0; h > e; e++)m = m << 1 | 1 & t, v == r - 1 ? (v = 0, d.push(n(m)), m = 0) : v++, t >>= 1; for (; ;) { if (m <<= 1, v == r - 1) { d.push(n(m)); break } v++ } return d.join("") }, decompress: function (o) { return null == o ? "" : "" == o ? null : i._decompress(o.length, 32768, function (r) { return o.charCodeAt(r) }) }, _decompress: function (o, n, e) { var t, i, s, p, u, c, a, l, f = [], h = 4, d = 4, m = 3, v = "", w = [], A = { val: e(0), position: n, index: 1 }; for (i = 0; 3 > i; i += 1)f[i] = i; for (p = 0, c = Math.pow(2, 2), a = 1; a != c;)u = A.val & A.position, A.position >>= 1, 0 == A.position && (A.position = n, A.val = e(A.index++)), p |= (u > 0 ? 1 : 0) * a, a <<= 1; switch (t = p) { case 0: for (p = 0, c = Math.pow(2, 8), a = 1; a != c;)u = A.val & A.position, A.position >>= 1, 0 == A.position && (A.position = n, A.val = e(A.index++)), p |= (u > 0 ? 1 : 0) * a, a <<= 1; l = r(p); break; case 1: for (p = 0, c = Math.pow(2, 16), a = 1; a != c;)u = A.val & A.position, A.position >>= 1, 0 == A.position && (A.position = n, A.val = e(A.index++)), p |= (u > 0 ? 1 : 0) * a, a <<= 1; l = r(p); break; case 2: return "" }for (f[3] = l, s = l, w.push(l); ;) { if (A.index > o) return ""; for (p = 0, c = Math.pow(2, m), a = 1; a != c;)u = A.val & A.position, A.position >>= 1, 0 == A.position && (A.position = n, A.val = e(A.index++)), p |= (u > 0 ? 1 : 0) * a, a <<= 1; switch (l = p) { case 0: for (p = 0, c = Math.pow(2, 8), a = 1; a != c;)u = A.val & A.position, A.position >>= 1, 0 == A.position && (A.position = n, A.val = e(A.index++)), p |= (u > 0 ? 1 : 0) * a, a <<= 1; f[d++] = r(p), l = d - 1, h--; break; case 1: for (p = 0, c = Math.pow(2, 16), a = 1; a != c;)u = A.val & A.position, A.position >>= 1, 0 == A.position && (A.position = n, A.val = e(A.index++)), p |= (u > 0 ? 1 : 0) * a, a <<= 1; f[d++] = r(p), l = d - 1, h--; break; case 2: return w.join("") }if (0 == h && (h = Math.pow(2, m), m++), f[l]) v = f[l]; else { if (l !== d) return null; v = s + s.charAt(0) } w.push(v), f[d++] = s + v.charAt(0), h--, s = v, 0 == h && (h = Math.pow(2, m), m++) } } }; return i }(); "function" == typeof define && define.amd ? define(function () { return LZString }) : "undefined" != typeof module && null != module && (module.exports = LZString);
// blueimp-md5 2.19.0
!function (n) { "use strict"; function d(n, t) { var r = (65535 & n) + (65535 & t); return (n >> 16) + (t >> 16) + (r >> 16) << 16 | 65535 & r } function f(n, t, r, e, o, u) { return d((u = d(d(t, n), d(e, u))) << o | u >>> 32 - o, r) } function l(n, t, r, e, o, u, c) { return f(t & r | ~t & e, n, t, o, u, c) } function g(n, t, r, e, o, u, c) { return f(t & e | r & ~e, n, t, o, u, c) } function v(n, t, r, e, o, u, c) { return f(t ^ r ^ e, n, t, o, u, c) } function m(n, t, r, e, o, u, c) { return f(r ^ (t | ~e), n, t, o, u, c) } function c(n, t) { var r, e, o, u; n[t >> 5] |= 128 << t % 32, n[14 + (t + 64 >>> 9 << 4)] = t; for (var c = 1732584193, f = -271733879, i = -1732584194, a = 271733878, h = 0; h < n.length; h += 16)c = l(r = c, e = f, o = i, u = a, n[h], 7, -680876936), a = l(a, c, f, i, n[h + 1], 12, -389564586), i = l(i, a, c, f, n[h + 2], 17, 606105819), f = l(f, i, a, c, n[h + 3], 22, -1044525330), c = l(c, f, i, a, n[h + 4], 7, -176418897), a = l(a, c, f, i, n[h + 5], 12, 1200080426), i = l(i, a, c, f, n[h + 6], 17, -1473231341), f = l(f, i, a, c, n[h + 7], 22, -45705983), c = l(c, f, i, a, n[h + 8], 7, 1770035416), a = l(a, c, f, i, n[h + 9], 12, -1958414417), i = l(i, a, c, f, n[h + 10], 17, -42063), f = l(f, i, a, c, n[h + 11], 22, -1990404162), c = l(c, f, i, a, n[h + 12], 7, 1804603682), a = l(a, c, f, i, n[h + 13], 12, -40341101), i = l(i, a, c, f, n[h + 14], 17, -1502002290), c = g(c, f = l(f, i, a, c, n[h + 15], 22, 1236535329), i, a, n[h + 1], 5, -165796510), a = g(a, c, f, i, n[h + 6], 9, -1069501632), i = g(i, a, c, f, n[h + 11], 14, 643717713), f = g(f, i, a, c, n[h], 20, -373897302), c = g(c, f, i, a, n[h + 5], 5, -701558691), a = g(a, c, f, i, n[h + 10], 9, 38016083), i = g(i, a, c, f, n[h + 15], 14, -660478335), f = g(f, i, a, c, n[h + 4], 20, -405537848), c = g(c, f, i, a, n[h + 9], 5, 568446438), a = g(a, c, f, i, n[h + 14], 9, -1019803690), i = g(i, a, c, f, n[h + 3], 14, -187363961), f = g(f, i, a, c, n[h + 8], 20, 1163531501), c = g(c, f, i, a, n[h + 13], 5, -1444681467), a = g(a, c, f, i, n[h + 2], 9, -51403784), i = g(i, a, c, f, n[h + 7], 14, 1735328473), c = v(c, f = g(f, i, a, c, n[h + 12], 20, -1926607734), i, a, n[h + 5], 4, -378558), a = v(a, c, f, i, n[h + 8], 11, -2022574463), i = v(i, a, c, f, n[h + 11], 16, 1839030562), f = v(f, i, a, c, n[h + 14], 23, -35309556), c = v(c, f, i, a, n[h + 1], 4, -1530992060), a = v(a, c, f, i, n[h + 4], 11, 1272893353), i = v(i, a, c, f, n[h + 7], 16, -155497632), f = v(f, i, a, c, n[h + 10], 23, -1094730640), c = v(c, f, i, a, n[h + 13], 4, 681279174), a = v(a, c, f, i, n[h], 11, -358537222), i = v(i, a, c, f, n[h + 3], 16, -722521979), f = v(f, i, a, c, n[h + 6], 23, 76029189), c = v(c, f, i, a, n[h + 9], 4, -640364487), a = v(a, c, f, i, n[h + 12], 11, -421815835), i = v(i, a, c, f, n[h + 15], 16, 530742520), c = m(c, f = v(f, i, a, c, n[h + 2], 23, -995338651), i, a, n[h], 6, -198630844), a = m(a, c, f, i, n[h + 7], 10, 1126891415), i = m(i, a, c, f, n[h + 14], 15, -1416354905), f = m(f, i, a, c, n[h + 5], 21, -57434055), c = m(c, f, i, a, n[h + 12], 6, 1700485571), a = m(a, c, f, i, n[h + 3], 10, -1894986606), i = m(i, a, c, f, n[h + 10], 15, -1051523), f = m(f, i, a, c, n[h + 1], 21, -2054922799), c = m(c, f, i, a, n[h + 8], 6, 1873313359), a = m(a, c, f, i, n[h + 15], 10, -30611744), i = m(i, a, c, f, n[h + 6], 15, -1560198380), f = m(f, i, a, c, n[h + 13], 21, 1309151649), c = m(c, f, i, a, n[h + 4], 6, -145523070), a = m(a, c, f, i, n[h + 11], 10, -1120210379), i = m(i, a, c, f, n[h + 2], 15, 718787259), f = m(f, i, a, c, n[h + 9], 21, -343485551), c = d(c, r), f = d(f, e), i = d(i, o), a = d(a, u); return [c, f, i, a] } function i(n) { for (var t = "", r = 32 * n.length, e = 0; e < r; e += 8)t += String.fromCharCode(n[e >> 5] >>> e % 32 & 255); return t } function a(n) { var t = []; for (t[(n.length >> 2) - 1] = void 0, e = 0; e < t.length; e += 1)t[e] = 0; for (var r = 8 * n.length, e = 0; e < r; e += 8)t[e >> 5] |= (255 & n.charCodeAt(e / 8)) << e % 32; return t } function e(n) { for (var t, r = "0123456789abcdef", e = "", o = 0; o < n.length; o += 1)t = n.charCodeAt(o), e += r.charAt(t >>> 4 & 15) + r.charAt(15 & t); return e } function r(n) { return unescape(encodeURIComponent(n)) } function o(n) { return i(c(a(n = r(n)), 8 * n.length)) } function u(n, t) { return function (n, t) { var r, e = a(n), o = [], u = []; for (o[15] = u[15] = void 0, 16 < e.length && (e = c(e, 8 * n.length)), r = 0; r < 16; r += 1)o[r] = 909522486 ^ e[r], u[r] = 1549556828 ^ e[r]; return t = c(o.concat(a(t)), 512 + 8 * t.length), i(c(u.concat(t), 640)) }(r(n), r(t)) } function t(n, t, r) { return t ? r ? u(t, n) : e(u(t, n)) : r ? o(n) : e(o(n)) } "function" == typeof define && define.amd ? define(function () { return t }) : "object" == typeof module && module.exports ? module.exports = t : n.md5 = t }(this);
//# sourceMappingURL=md5.min.js.map
