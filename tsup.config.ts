import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node20",
    dts: true,
    clean: true,
    splitting: false,
  },
  {
    // CLI is fully self-contained (deps bundled) so the GitHub Action can run
    // the committed dist/cli.js straight from the tag — no npm install step,
    // and the tag's code is exactly what executes.
    entry: ["src/cli.ts"],
    format: ["esm"],
    target: "node20",
    clean: false,
    splitting: false,
    noExternal: [/.*/],
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
  },
]);
