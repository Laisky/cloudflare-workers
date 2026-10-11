# Dependency maintenance

Use Node.js 22 or later and npm. The root regression harness and each project have committed npm lockfiles. Legacy Yarn lockfiles were removed to prevent different package managers from selecting different Worker toolchains.

Install the five locked dependency trees:

```sh
npm ci
for project in blog s3 speech-to-text cf-utils; do
    npm ci --prefix "$project"
done
npm run lint
npm test
npm run check:builds
```

The build acceptance command uses each project's pinned Wrangler to run `deploy --dry-run`, then executes the generated production/development bundles in local Miniflare. Origins, KV, binary data, and missing-AI behavior are local fixtures. It does not log in, upload Workers, call a model, or read remote bindings.

Wrangler 4.116.0 and Miniflare 4.20260730.0 use the stable Miniflare 4 line. Newer Wrangler releases currently depend on Miniflare 5 alpha; moving that runtime requires a separate compatibility pass. The Worker compatibility dates, routes, bindings, application dependencies, and public cf-utils package version remain unchanged.

Transitive security patches are constrained to Undici 7.30.0, sharp 0.35.5, and flatted 3.4.4 within their existing release lines. These avoid the advisories still present in the stable upstream runtime and stale ESLint lock entries. Keep the overrides until the pinned upstream dependencies include equivalent patched releases. Audit all five lockfiles after dependency changes:

```sh
npm audit
for project in blog s3 speech-to-text cf-utils; do
    npm audit --prefix "$project"
done
```

The GitHub workflow installs the locks and runs lint, behavioral regressions, and compiled-bundle acceptance. Merging runs those checks only. Deployment and npm publication remain separate manual actions.
