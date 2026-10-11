import globals from "globals";
import pluginJs from "@eslint/js";

const customGlobals = {
    KV: "readonly",
};

export default [
    {
        languageOptions: {
            globals: {
                ...customGlobals,
                ...globals.browser
            }
        },
        ignores: [
            "./.wrangler/",
            "./node_modules/",
        ]
    },
    pluginJs.configs.recommended,
];
