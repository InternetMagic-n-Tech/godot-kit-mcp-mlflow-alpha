const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
        // Automatically includes Node.js globals (require, module, process, etc.)
        globals: {
          ...globals.node,
        },
        // Ensures ES latest features and CommonJS source type are supported
        sourceType: "commonjs",
      },
  },
  {
    rules: {
      "prefer-arrow-callback": "error",
      "one-var": ["error", "never"],
      // Allow console logs for debugging
      "no-console": "off",

      // Warn instead of error for unused variables (ignoring those starting with an underscore)
      "no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],

      // Enforce semicolons as warnings rather than errors
      "semi": ["warn", "always"],

      // Allow reassigning properties of parameters
      // "no-param-reassign": "off",
    }
  }
];
