import globals from "globals";
import pluginJs from "@eslint/js";

export default [
    { ignores: ["**/node_modules/**", "**/.wrangler/**", "speech-to-text/src/vendor/**"] },
    pluginJs.configs.recommended,
    {
        files: ["blog/src/**/*.js", "s3/src/**/*.js", "shared/**/*.js", "speech-to-text/src/index.js"],
        languageOptions: { globals: globals.browser }
    },
    {
        files: ["tests/**/*.mjs"],
        languageOptions: { globals: { ...globals.node, ...globals.browser } }
    }
];
