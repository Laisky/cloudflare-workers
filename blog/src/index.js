'use strict';

import {
    cacheSet,
    cacheGet,
    headersFromArray,
    headersToArray,
    setDefaultCachePrefix,
    sendErrorAlert
} from '@laisky/cf-utils';


/* cache for site page and GraphQL query

Listening on routes:

    * blog.laisky.com
    * blog.laisky.com/p/*
    * blog.laisky.com/pages/*
    * blog.laisky.com/graphql/query/*
    * gq.laisky.com/*
*/

// Using a more descriptive prefix might be helpful if versions change often
setDefaultCachePrefix("blog-v2.25/"); // Increment version or use a date

const GraphqlAPI = "https://gq.laisky.com/query/";

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
        response = await generalCache(request, env, ctx, pathname);
    }

    return response;
}

/**
 * isCacheEnable check whether to enable cache
 *
 * @param {Request} request - request object
 * @param {Boolean} cachePost - whether to enable cache for POST method
 * @returns {Boolean}
 */
function isCacheEnable(request, cachePost = false) {
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
 * generalCache cache for everything else
 */
async function generalCache(request, env, ctx, pathname) {
    console.log(`generalCache for ${request.url}`);

    const cacheKey = `general:${request.method}:${request.url}`;
    let response;

    let bypassCacheReason = "disabled";
    try {
        // Attempt to get from cache first
        if (isCacheEnable(request, false)) {
            bypassCacheReason = "cache-miss";
            const cached = await cacheGet(env, cacheKey);
            if (cached != null) {
                console.log(`Cache hit for ${cacheKey}`);
                return new Response(cached.body, {
                    headers: headersFromArray(cached.headers)
                });
            }
        }

        console.log(`bypass cache for ${cacheKey}: ${bypassCacheReason}`);
        response = await fetch(request);

        if (!response.ok) {
            console.warn(`Origin request failed with status ${response.status}`);
            return response;
        }

        // Clone the response before reading
        const clonedResponse = response.clone();
        const respBody = await clonedResponse.text();

        // Only cache successful responses
        if (response.status === 200) {
            let headers = headersToArray(response.headers);
            headers.push(["X-Laisky-Cf-Cache-Key", cacheKey]);

            // Attempt to cache but don't block the response
            ctx.waitUntil(cacheSet(env, cacheKey, {
                headers: headers,
                body: respBody
            }).catch(err => {
                console.error(`Cache write failed for ${cacheKey}:`, err);
            }));
        }

        return new Response(respBody, {
            status: response.status,
            headers: response.headers,
        });
    } catch (error) {
        console.error(`Error in generalCache for ${cacheKey}:`, error);

        // If we have a response from origin, return it even if caching failed
        if (response) {
            return response;
        }

        // Last resort - fetch again without caching
        return fetch(request);
    }
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
async function insertTwitterCard(request, env, ctx, pathname) {
    const cacheKey = `post:${request.method}:${pathname}`; // Pathname should be specific enough
    console.log(`InsertTwitterCard: Key=${cacheKey}`);

    if (isCacheEnable(request, true)) { // Allow POST caching if needed? Usually GET for posts.
        const cached = await cacheGet(env, cacheKey);
        if (cached && typeof cached === "object" && cached.body !== null) {
            console.log(`InsertTwitterCard: HIT ${cacheKey}`);
            return new Response(cached.body, {
                status: cached.status || 200,
                headers: headersFromArray(cached.headers)
            });
        }
        console.log(`InsertTwitterCard: MISS ${cacheKey}`);
    } else {
        console.log(`InsertTwitterCard: BYPASS ${cacheKey}`);
    }

    // --- Fetch Original Page ---
    const pageResp = await fetch(request);

    if (!pageResp.ok) {
        console.warn(`InsertTwitterCard: Failed to fetch page ${request.url}, status: ${pageResp.status}`);
        return pageResp; // Return origin error response
    }

    // Clone response to allow reading body and returning original headers/status
    const pageRespClone = pageResp.clone();
    let html = await pageRespClone.text(); // Read body from clone

    // --- Fetch Twitter Card Data ---
    const postNameMatch = /\/p\/([^/?#]+)/.exec(pathname); // Simpler regex, check match
    if (!postNameMatch || !postNameMatch[1]) {
        console.error(`InsertTwitterCard: Could not extract post name from pathname: ${pathname}`);
        // Return original page content without modification if name extraction fails
        return pageResp;
    }
    const postName = postNameMatch[1];

    console.log(`InsertTwitterCard: Fetching Twitter card for post: ${postName}`);
    const queryBody = JSON.stringify({
        operationName: "blog",
        query: `query blog { BlogTwitterCard(name: "${postName}") }`, // Use template literal
        variables: {}
    });

    let twitterCard = '';
    try {
        const cardResp = await fetch(GraphqlAPI, {
            method: "POST",
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: queryBody
        });

        if (cardResp.ok) {
            const cardJson = await cardResp.json();
            // Safely access nested data
            twitterCard = cardJson?.data?.BlogTwitterCard || '';
            if (twitterCard) {
                console.log(`InsertTwitterCard: Successfully fetched Twitter card for ${postName}.`);
            } else {
                console.log(`InsertTwitterCard: Twitter card data empty or not found for ${postName}.`);
            }
        } else {
            // Log error but don't fail the whole request, just skip injection
            console.warn(`InsertTwitterCard: Failed to fetch Twitter card (${cardResp.status}) for ${postName}. Response: ${await cardResp.text()}`);
        }
    } catch (e) {
        console.error(`InsertTwitterCard: Error fetching or parsing Twitter card for ${postName}:`, e);
        // Continue without the card on error
    }

    // --- Inject Card and Cache ---
    if (twitterCard) {
        // More robust replacement (case-insensitive)
        html = html.replace(/<\/head>/i, twitterCard + '</head>');
        console.log(`InsertTwitterCard: Injected Twitter card for ${postName}.`);
    }

    const headers = headersToArray(pageResp.headers); // Use original headers
    headers.push(["X-Laisky-Cf-Cache", "SAVED"]);
    headers.push(["X-Laisky-Cf-Cache-Key", cacheKey]);

    // Cache the (potentially modified) HTML
    ctx.waitUntil(cacheSet(env, cacheKey, {
        body: html,
        headers: headers,
        status: pageResp.status // Cache original status
    }));

    console.log(`InsertTwitterCard: Storing ${cacheKey} in cache.`);
    // Return the new response with modified HTML but original status/headers
    // Use headersFromArray to reconstruct headers for the final response
    return new Response(html, {
        status: pageResp.status,
        headers: headersFromArray(headers) // Send the headers we just prepared for cache
    });
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

// load and cache graphql read-only query
async function cacheGqQuery(request, env, ctx, pathname) {
    console.log(`CacheGqQuery: URL=${request.url} Method=${request.method}`);

    const url = new URL(request.url);
    let reqData;
    let originRequest = request; // Keep track of the request to send to origin

    // 1. Prepare Request Data and Origin Request
    if (request.method === "GET") {
        reqData = {
            query: url.searchParams.get("query"),
            variables: url.searchParams.get("variables") // Might need JSON.parse if variables are complex objects
        };
        // GET requests are inherently safe, body is null
    } else if (request.method === "POST") {
        try {
            // Clone request first to preserve original for potential retries/logging
            const reqClone = request.clone();
            reqData = await reqClone.json(); // Read body from clone

            // FIX: Create the request to be sent to the origin *with* the body
            originRequest = new Request(request.url, {
                method: "POST",
                headers: request.headers,
                body: JSON.stringify(reqData) // Use the read data
            });

        } catch (e) {
            console.error("CacheGqQuery: Failed to parse request JSON body:", e);
            return new Response("Invalid JSON body", { status: 400 });
        }

        // Check if request should be denied
        const denyReason = denyGQ(reqData);
        if (denyReason) {
            console.warn(`CacheGqQuery: Denied - ${denyReason}`);
            // Return a 403 Forbidden instead of 500
            return new Response(denyReason, { status: 403 });
        }
    } else {
        console.log(`CacheGqQuery: Bypass method ${request.method}.`);
        return fetch(request); // Pass through unsupported methods
    }

    // 2. Basic Query/Mutation Check (Heuristic)
    // Trim whitespace before checking for 'query' or '{'
    const queryStr = reqData?.query?.trim() || '';
    if (!queryStr || !(queryStr.startsWith('query') || queryStr.startsWith('{'))) {
        console.log("CacheGqQuery: Bypass non-query request (heuristic).");
        // Forward the potentially modified originRequest (for POST)
        return fetch(originRequest);
    }
    console.log("CacheGqQuery: Processing as query.");

    // 3. Cache Check
    const cacheKey = `graphql:${request.method}:${pathname}:${JSON.stringify(reqData)}`; // Key includes method, path, and full query data
    console.log(`CacheGqQuery: Key=${cacheKey}`);

    if (isCacheEnable(request, true)) { // Enable POST caching for queries
        const cached = await cacheGet(env, cacheKey);
        if (cached && typeof cached === "object" && cached.body !== null) {
            console.log(`CacheGqQuery: HIT ${cacheKey}`);
            // Assume cached data includes status
            return new Response(cached.body, {
                status: cached.status || 200,
                headers: headersFromArray(cached.headers)
            });
        }
        console.log(`CacheGqQuery: MISS ${cacheKey}`);
    } else {
        console.log(`CacheGqQuery: BYPASS ${cacheKey}`);
    }

    // 4. Fetch from Origin GraphQL Server
    // FIX: Use the originRequest which has the correct body for POST
    console.log(`CacheGqQuery: Fetching origin ${originRequest.url}`);
    const originResponse = await fetch(originRequest);

    // 5. Process Origin Response
    if (!originResponse.ok) {
        console.warn(`CacheGqQuery: Origin fetch failed (${originResponse.status}) for ${originRequest.url}.`);
        return originResponse; // Return origin error response
    }

    // Clone to read body for checks/caching and return original response stream
    const originResponseClone = originResponse.clone();

    let respBodyJson;
    try {
        respBodyJson = await originResponseClone.json(); // Read body from clone
    } catch (e) {
        console.error("CacheGqQuery: Failed to parse origin JSON response:", e);
        // Return the original response even if JSON parsing failed client-side
        return originResponse;
    }

    // Check for GraphQL errors *within* the response payload
    if (respBodyJson.errors) {
        console.warn(`CacheGqQuery: Origin response contains GraphQL errors: ${JSON.stringify(respBodyJson.errors)}`);
        // FIX: Return the response containing the errors, don't throw or cache
        return new Response(JSON.stringify(respBodyJson), {
            status: originResponse.status, // Keep original status (usually 200 even with errors)
            headers: originResponse.headers
        });
    }

    // 6. Cache Successful Response
    console.log(`CacheGqQuery: Storing ${cacheKey} in cache.`);
    const respBodyString = JSON.stringify(respBodyJson); // Stringify the parsed JSON
    const headers = headersToArray(originResponse.headers);
    headers.push(["X-Laisky-Cf-Cache", "SAVED"]);
    headers.push(["X-Laisky-Cf-Cache-Key", cacheKey]);

    // Cache asynchronously
    ctx.waitUntil(cacheSet(env, cacheKey, {
        body: respBodyString,
        headers: headers,
        status: originResponse.status // Cache the status
    }));

    // Return the original response (stream preserved)
    return originResponse;
}
