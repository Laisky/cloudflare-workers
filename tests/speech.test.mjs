import { test } from "node:test";
import assert from "node:assert/strict";
import { workerHarness, Response } from "./harness.mjs";
const aiResponse = () => Response.json({ result: [{ name: "name", type: "str", shape: [1], value: ["fixture transcript"] }] });
test("Speech oversized audio is rejected before any inference call", async () => {
    let aiCalls = 0;
    const mf = await workerHarness("speech-to-text",
        () => new Response(new Uint8Array(1024 * 1024 + 1)),
        () => { aiCalls++; return aiResponse(); });
    try {
        const response = await mf.dispatchFetch("https://speech.example/");
        assert.equal(response.status, 502);
        assert.equal(aiCalls, 0);
    } finally { await mf.dispose(); }
});
test("Speech keeps the existing inputs.audio and response JSON contract", async () => {
    const mf = await workerHarness("speech-to-text", () => new Response(new Uint8Array([0, 1, 255])), aiResponse);
    try {
        const response = await mf.dispatchFetch("https://speech.example/");
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.deepEqual(result.inputs.audio, [0, 1, 255]);
        assert.equal(result.response.text, "fixture transcript");
    } finally { await mf.dispose(); }
});

test("Speech upstream failures do not reach inference", async () => {
    let calls = 0;
    const mf = await workerHarness("speech-to-text", () => new Response("missing", { status: 404 }), () => { calls++; return aiResponse(); });
    try {
        assert.equal((await mf.dispatchFetch("https://speech.example/")).status, 502);
        assert.equal(calls, 0);
    } finally { await mf.dispose(); }
});
test("Speech missing AI binding fails clearly before downloading audio", async () => {
    let calls = 0;
    const mf = await workerHarness("speech-to-text", () => { calls++; return new Response("audio"); });
    try {
        assert.equal((await mf.dispatchFetch("https://speech.example/")).status, 503);
        assert.equal(calls, 0);
    } finally { await mf.dispose(); }
});

test("Speech default sample survives the recorded upstream master deletion within the audio budget", async () => {
    let calls = 0;
    // Public metadata and HEAD verified 2026-10-08: mutable URL=404; original pinned WAV=200, 587016 bytes.
    const mf = await workerHarness("speech-to-text", request => {
        if (request.url.includes("/master/")) return new Response("missing", { status: 404 });
        return new Response(new Uint8Array(587016).fill(65), { headers: { "Content-Type": "audio/wav" } });
    }, () => { calls++; return aiResponse(); });
    try {
        const response = await mf.dispatchFetch("https://speech.example/");
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.inputs.audio.length, 587016);
        assert.equal(result.response.text, "fixture transcript");
        assert.equal(calls, 1);
    } finally { await mf.dispose(); }
});
