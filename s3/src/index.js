'use strict';

import { md5 } from 'js-md5';
import {
    cacheSet,
    cacheGet,
    headersFromArray,
    headersToArray,
    setDefaultCachePrefix,
    arrayBufferToBase64,
    arrayBufferFromBase64
} from '@laisky/cf-utils';

setDefaultCachePrefix("s3-v0.1/");

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
    if (request.method === "GET") {
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
    if (resp.status === 200 && resp.headers.get("content-length") < 1024 * 1024) {
        const body = await resp.arrayBuffer();

        await cacheSet(env, cacheKey, {
            headers: headersToArray(resp.headers),
            body: arrayBufferToBase64(body)
        });

        return new Response(body, {
            headers: resp.headers
        });
    }

    return resp;
}
