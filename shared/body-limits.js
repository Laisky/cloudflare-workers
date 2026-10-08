/** readBodyWithinLimit bounds buffering, then cancels or returns a stream replaying the complete prefix. */
export async function readBodyWithinLimit(body, maxBytes, cancelOnOverflow = false) {
    if (!body) return { bytes: new Uint8Array(), stream: null };
    const reader = body.getReader(), chunks = [];
    let total = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                reader.releaseLock();
                const bytes = new Uint8Array(total);
                let offset = 0;
                for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
                return { bytes, stream: null };
            }
            total += value.byteLength;
            chunks.push(value);
            if (total > maxBytes) {
                if (cancelOnOverflow) {
                    await reader.cancel("Body exceeds processing budget");
                    reader.releaseLock();
                    return { bytes: null, stream: null };
                }
                return { bytes: null, stream: new ReadableStream({
                    start(controller) {
                        for (const chunk of chunks) controller.enqueue(chunk);
                        chunks.length = 0;
                    },
                    async pull(controller) {
                        try {
                            const next = await reader.read();
                            if (next.done) { reader.releaseLock(); controller.close(); }
                            else controller.enqueue(next.value);
                        } catch (error) { reader.releaseLock(); controller.error(error); }
                    },
                    async cancel(reason) {
                        try { await reader.cancel(reason); }
                        finally { reader.releaseLock(); }
                    }
                }) };
            }
        }
    } catch (error) { reader.releaseLock(); throw error; }
}
/** responseWithBody retains origin status and headers when replacing a consumed body. */
export function responseWithBody(response, body) {
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}
