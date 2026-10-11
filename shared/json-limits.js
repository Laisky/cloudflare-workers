export const MAX_JSON_DEPTH = 32;
export const MAX_JSON_NODES = 20000;
/** parseBoundedJson checks structural depth before parsing and bounds the resulting object graph. */
export function parseBoundedJson(text) {
    let depth = 0, quoted = false, escaped = false;
    for (const char of text) {
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === "[" || char === "{") {
            if (++depth > MAX_JSON_DEPTH) throw new RangeError("JSON nesting exceeds processing budget");
        } else if (char === "]" || char === "}") depth--;
    }
    const value = JSON.parse(text);
    assertBoundedJson(value);
    return value;
}
/** assertBoundedJson bounds depth and node count without recursive traversal or unbounded sorting. */
export function assertBoundedJson(value) {
    const pending = [{ value, depth: 0 }];
    let count = 0;
    while (pending.length) {
        const current = pending.pop();
        if (++count > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH)
            throw new RangeError("JSON structure exceeds processing budget");
        if (current.value && typeof current.value === "object") {
            const keys = Object.keys(current.value);
            if (count + pending.length + keys.length > MAX_JSON_NODES)
                throw new RangeError("JSON node count exceeds processing budget");
            for (const key of keys) pending.push({ value: current.value[key], depth: current.depth + 1 });
        }
    }
}
