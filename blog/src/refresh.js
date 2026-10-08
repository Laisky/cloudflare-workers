const pendingRefreshes = new Map();
const MAX_PENDING_REFRESHES = 128;
/** scheduleRefresh shares an in-flight refresh by key within this isolate and bounds unique refreshes. */
export function scheduleRefresh(ctx, key, refresh) {
    let pending = pendingRefreshes.get(key);
    if (!pending) {
        if (pendingRefreshes.size >= MAX_PENDING_REFRESHES) return;
        pending = Promise.resolve().then(refresh).finally(() => pendingRefreshes.delete(key));
        pendingRefreshes.set(key, pending);
    }
    ctx.waitUntil(pending);
}
