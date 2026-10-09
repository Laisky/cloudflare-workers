/** Shared cache keys must never store or serve user-specific responses. */
export function isPublicCacheRequest(request) {
    return !request.headers.has("Authorization") && !request.headers.has("Cookie");
}
export function isPublicCacheResponse(response) {
    return !response.headers.has("Set-Cookie")
        && !/\b(?:private|no-store)\b/i.test(response.headers.get("Cache-Control") || "");
}
