import { Ai } from './vendor/@cloudflare/ai.js';
import { readBodyWithinLimit } from "../../shared/body-limits.js";

const MAX_AUDIO_BYTES = 1024 * 1024;
const AUDIO_URL = 'https://raw.githubusercontent.com/Azure-Samples/cognitive-services-speech-sdk/10cb305d84c79d7ba2a196e4a20bc18f1cd73715/samples/cpp/windows/console/samples/enrollment_audio_katie.wav';

export default {
    /** fetch bounds sample audio before expansion/inference and preserves the existing JSON contract. */
    async fetch(request, env) {
        if (!env.AI) return new Response("AI binding is unavailable", { status: 503 });
        const audioResponse = await fetch(AUDIO_URL);
        if (!audioResponse.ok) return new Response("Audio upstream failed", { status: 502 });
        const bounded = await readBodyWithinLimit(audioResponse.body, MAX_AUDIO_BYTES, true);
        if (bounded.bytes === null) return new Response("Audio upstream is too large", { status: 502 });
        const inputs = { audio: Array.from(bounded.bytes) };
        const response = await new Ai(env.AI).run('@cf/openai/whisper', inputs);
        return Response.json({ inputs, response });
    }
};
