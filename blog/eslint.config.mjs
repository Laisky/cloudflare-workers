import globals from "globals";
import pluginJs from "@eslint/js";

const customGlobals = {
    KVBlog: "readonly",
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
