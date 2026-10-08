# Worker CPU and payload risk audit

Source audit: 2026-10-08, against main at `42a55fda066d3ea690df64d85bc260622b2fd26f`.
The fixes below run entirely in local workerd/Miniflare with mocked outbound services and local KV/R2.
They do not deploy Workers, provision resources, change a plan, or invalidate existing cache keys.

## Worker inventory and live verification

| Worker | Source configuration | CPU configuration in source | State verified |
| --- | --- | --- | --- |
| blog | [blog/wrangler.toml](../blog/wrangler.toml), top level | No `limits.cpu_ms` | Source and dry-run bundle only |
| blog-dev | Same file, `env.dev`, separate existing KV/R2 bindings | No environment override or top-level limit | Source and dry-run bundle only |
| s3 | [s3/wrangler.toml](../s3/wrangler.toml), top level | No `limits.cpu_ms` | Source and dry-run bundle only |
| s3-dev | Same file, `env.dev`, separate existing KV/R2 bindings | No environment override or top-level limit | Source and dry-run bundle only |
| speech-to-text | [speech-to-text/wrangler.toml](../speech-to-text/wrangler.toml), top level only | No `limits.cpu_ms` | Source and dry-run bundle only |

The blog/S3 Makefiles use `wrangler deploy` for production and `wrangler deploy --env dev` for dev, without a CPU override.
A named dev environment is a separate Worker, not evidence of an ephemeral preview or production setting.
Existing Wrangler 4.7.2 and 3.80.1 `whoami` checks reported no login. Deployed versions, usage models, limits, traffic, CPU quantiles and invoices therefore remain unknown.
No credential files were printed or tokens created.

No pre-existing GitHub deployment workflow was tracked, and the GitHub repository hook list was empty.
The added workflow only lints and runs offline tests. Cloudflare-side Git integrations remain unverified; a branch/merge could trigger an independently configured build.

## Fixed risks and behavior

| Risk | Fix | Observable behavior and compatibility |
| --- | --- | --- |
| S3 relied on Content-Length before whole-body buffering/base64 | Bound actual bytes in [s3/src/index.js](../s3/src/index.js) via [shared/body-limits.js](../shared/body-limits.js) | Only GET 200 bodies smaller than 1 MiB cache; missing/incorrect length cannot bypass the guard. Larger bodies retain bytes/status/headers and continue streaming without base64/cache writes. Existing binary cache hits retain exact bytes. |
| HEAD could write an empty body into a GET cache key | Restrict S3 cache writes to GET | HEAD cannot poison a later GET. |
| Blog buffered/hash-processed arbitrary origin text | Bound origin processing to 1 MiB in [blog/src/index.js](../blog/src/index.js) | Larger origin responses pass through intact without cache mutation or card injection. Binary assets bypass text conversion; old cached binary bodies are ignored. Missing Content-Type retains legacy text behavior. |
| Blog GraphQL parsed/canonicalized unchecked input | 64 KiB actual UTF-8 request bound; JSON depth 32 and 20,000-node bounds in [shared/json-limits.js](../shared/json-limits.js) | Oversized POST returns 413; malformed/excessively complex JSON returns 400 before origin. Oversized/complex origin JSON passes through without canonical hashing/cache writes. Normal response JSON bytes and stable canonical hashes are preserved. |
| Oversized legacy KV/R2 payloads bypassed new write limits | Bound streamed cache envelopes before parse and validate body sizes in [shared/bounded-cache.js](../shared/bounded-cache.js) | Existing prefixes/envelopes and R2 fallback remain readable; invalid/oversized entries become misses. Blog envelope ceiling accommodates JSON escaping; S3 ceiling accommodates base64. No cache flush or migration. |
| Concurrent stale hits duplicated origin/hash/store work | Coalesce pending refreshes in [blog/src/refresh.js](../blog/src/refresh.js), maximum 128 unique pending keys | Same-isolate concurrent hits share one refresh; stale responses still return immediately. Failure releases the slot. This is not global coordination or a request rate limit. |
| Speech expanded arbitrary audio into a number array before AI | Bound actual audio to 1 MiB before expansion/inference in [speech-to-text/src/index.js](../speech-to-text/src/index.js) | Upstream failure/oversize returns 502 before AI. Missing binding returns 503 before downloading audio. The original sample URL and successful `{inputs,response}` contract remain. |
| Background refresh discarded oversized/error responses without explicitly canceling their body | Cancel only responses discarded by revalidateGeneral/revalidatePost/revalidateGql | Stale cache stays intact; four controlled-stream workerd tests fail on the old PR and pass with cleanup. Foreground oversized responses still replay all bytes to the client. This verifies body ownership, not production TCP connection leakage. |
| Post origin 204/205 became 500 after empty HTML processing | Return bodyless origin responses unchanged before parsing/injection | Original status, null body and headers survive, without card fetch/cache writes. GraphQL 204/205/304 also retain regression coverage. |

These are processing/cache budgets, not measured CPU caps. A single incoming stream chunk may already exceed a budget; the guard prevents continued whole-body accumulation and expensive transformations.
The audio echo is retained because client dependencies have not been verified.

## Optional speech activation excluded

The required AI binding declaration and repaired sample URL are excluded from this resource-safety patch. Speech Wrangler configuration is identical to the original main version; the original mutable sample URL remains unchanged. Missing binding returns 503 without fetching, and an upstream error returns 502 without inference; successful `{inputs,response}` remains unchanged when an existing binding and valid audio are available.

The original URL returned 404 during this audit. Its identical original WAV remains at [this immutable historical URL](https://raw.githubusercontent.com/Azure-Samples/cognitive-services-speech-sdk/10cb305d84c79d7ba2a196e4a20bc18f1cd73715/samples/cpp/windows/console/samples/enrollment_audio_katie.wav): HEAD was 200, 587,016 bytes, blob SHA `faecab8adf7c3297bf63497879ef31e4a3413207`. Upstream removed it from master in commit `2ecf7e62c3fe68094403dc672ad589d99add6fb0` on 2026-07-27.

A separate opt-in change could select that valid source and declare `[ai] binding = "AI"`. Together these can activate billable inference that previously failed. No activation patch is included, deployed, or merged here; AI entitlement/client/abuse policy needs an explicit rollout decision.

## Validation

Run from repository root with Node 22:

```sh
npm ci --no-audit --no-fund
npm run lint
npm test
```

Tests bundle the actual Worker entrypoints and execute them in workerd, not Node's emulated Worker globals.
All origin/AI fetches are mocked; `cf: false` disables Miniflare Cloudflare requests.
The speech harness adapts the real AI binding's relative fetch URL to a local mock service and checks the legacy Whisper tensor/output contract.

Cancellation ownership tests use a controlled ReadableStream inside the same workerd isolate as the actual imported Worker entrypoint. Node/Worker-to-Worker bridge cancellation callbacks were not a reliable observer, so the tests make no claim about production socket lifetimes.
The GraphQL 204/205 candidate did not reproduce in the local workerd runtime: both original main and the old PR already retained status/null-body/headers with no cache writes. Bodyless responses now skip parsing explicitly; the related post 204/205 failure was reproduced and fixed.

Coverage includes actual-byte boundaries, missing Content-Length, streaming before origin EOF, binary cache hits, HEAD/GET separation, oversized legacy KV/R2, R2 fallback, depth/nodes/UTF-8 input budgets, concurrent refreshes, retry after failure, unchanged-content R2 writes, Twitter card injection, original GraphQL wire JSON, and speech success/failure contracts.
The final suite has 39 tests: the original source has 26 failures and 13 passes; the fixed source passes all 39. Lint and a fresh root `npm ci` also pass.
Wrangler dry-run builds cover blog and S3 production/dev and speech; compatibility dates/routes/cache prefixes remain unchanged.
Dry-run confirms local configuration/build validity, not live authentication or production CPU headroom.

## CPU cost and remaining decisions

The current [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) for Standard lists a $5 monthly account minimum, 10 million included requests and 30 million included CPU milliseconds; overages are $0.30/million requests and $0.02/million CPU milliseconds.
The quoted $0.072/additional CPU-hour is correct arithmetic (3.6 million ms per hour), and the included CPU allowance equals about 8.33 CPU-hours.
It is account usage, not a separate 30-million-ms allowance for each Worker. Enterprise/legacy usage must be checked separately.

[CPU limits](https://developers.cloudflare.com/workers/platform/limits/) are per invocation: HTTP Free is 10 ms; Paid defaults to 30,000 ms and allows up to 300,000 ms. Legacy Bundled HTTP can be 50 ms.
Waiting for fetch/KV/R2/AI network I/O is distinct from Worker execution CPU; parsing, sorting, hashing, base64 and array/JSON transformations consume CPU.
Background work is still resource usage. A per-invocation cap does not impose a monthly spending ceiling or cap AI/KV/R2 charges.

No CPU cap is changed here. Before selecting one, verify each deployed usage model/current limit and collect CPU p50/p95/p99 plus invocation outcomes and request volume for representative cache hits, misses, bypasses, refreshes, worst legitimate JSON/text/binary bodies and speech.
Use CPU measurements, not test wall-clock duration; exercise candidate caps on the existing dev Workers before production.
A cap chosen below legitimate work can introduce resource-limit errors. Request admission/authentication and AI abuse controls also require product/client policy evidence and remain unresolved.

[Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/) accepts numeric `limits.cpu_ms` (TOML `[limits]`, JSON/JSONC `"limits": {"cpu_ms": ...}`). Named environments inherit top-level limits unless overridden; KV/R2 bindings require their own environment definitions.
Once evidence supports a cap, place an intentional production value and explicit dev override if different, dry-run both, then verify the actual deployed settings. Do not treat a repository omission as proof of the live default.

## Deployment and rollback implications

This patch performs no deployment. Before a later rollout, check Cloudflare Git integration, snapshot current Worker versions/settings/bindings, verify legitimate clients fit the documented payload budgets, and check AI entitlement/usage policy.
This patch adds no speech binding and does not repair/activate the sample URL. A future separate activation could incur paid inference; a CPU cap would not limit that cost.
Roll out to the existing dev bindings first and compare cache hit/miss behavior, CPU quantiles, invocation errors, origin load and KV/R2 writes.

Code rollback restores the former buffering/duplicate-work risks. Cache keys and formats are preserved, so no migration/flush is needed; KV/R2 writes and already-incurred AI usage are not undone by a code rollback.
Capture and recheck deployed settings after rollback, following [Cloudflare rollback documentation](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
