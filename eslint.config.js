// Flat ESLint config for c-thru.
// Stdlib-only applies to RUNTIME code (claude-proxy, model-map-*.js, llm-capabilities-mcp.js).
// ESLint itself is a devDep — never required at runtime.

const nodeGlobals = {
  require: "readonly",
  module: "writable",
  exports: "writable",
  process: "readonly",
  Buffer: "readonly",
  __dirname: "readonly",
  __filename: "readonly",
  console: "readonly",
  global: "writable",
  setTimeout: "readonly",
  setInterval: "readonly",
  clearTimeout: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  clearImmediate: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextEncoder: "readonly",
  TextDecoder: "readonly",
  AbortController: "readonly",
  AbortSignal: "readonly",
  queueMicrotask: "readonly",
  performance: "readonly",
};

module.exports = [
  {
    ignores: [
      "node_modules/**",
      "plugins/**",
      "wiki/**",
      ".git/**",
      "**/*.md",
    ],
  },
  {
    files: ["tools/*.js", "test/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: nodeGlobals,
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-implicit-globals": "error",
    },
  },
];
