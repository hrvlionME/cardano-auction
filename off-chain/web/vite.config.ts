import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Lucid signs and serialises through cardano-multiplatform-lib, which is
// compiled to WebAssembly; Vite does not load .wasm as an ES module on its own.
//
// The usual recipe pairs this with vite-plugin-top-level-await, which exists to
// rewrite the library's top-level await for build targets that lack it. That
// plugin is incompatible with the @swc/core version resolved here ("missing
// field `type`"), and it is also unnecessary: the build targets esnext, where
// top-level await is native. If the target is ever lowered, this becomes a
// problem again.
import wasm from "vite-plugin-wasm";
// Resolved from this file's own URL rather than through node:url, so the
// config type-checks with the browser's lib set and needs no Node typings.
const here = (p: string) => new URL(p, import.meta.url).pathname;

// The API and the chain proxy both live on the Deno server. In development the
// page is served by Vite on 5173, so these paths are forwarded rather than
// fetched cross-origin -- which keeps the browser code identical in
// development and in production, where one server serves everything.
const API = "http://localhost:8000";

export default defineConfig({
  plugins: [wasm(), react()],
  resolve: {
    alias: {
      // The browser shares the CLI's Plutus schemas and parameter application
      // rather than reimplementing them. Duplicating those would guarantee
      // drift, and drift here fails silently on-chain instead of at build time.
      "@core": here("../src"),
      // See src/stubs/dotenv.ts.
      "@std/dotenv/load": here("./src/stubs/dotenv.ts"),
      // Lucid's dependency tree reaches Node's `buffer` through safe-buffer.
      // Vite's default is to externalise Node built-ins for the browser, which
      // makes `require("buffer")` return undefined -- and the failure surfaces
      // as `Cannot read properties of undefined (reading 'from')` from deep
      // inside a pre-bundled Lucid, naming nothing useful. The trailing slash
      // forces resolution to the `buffer` npm package, a real browser
      // implementation, instead of the externalised built-in. It must be an
      // absolute path: a bare specifier here is re-resolved by the same alias
      // and Vite refuses it.
      "buffer": here("./node_modules/buffer/index.js"),
    },
  },
  // Several of Lucid's transitive dependencies are Node libraries that expect
  // `global`. In a browser that identifier does not exist; `globalThis` is the
  // same object under the name the platform actually defines.
  define: { global: "globalThis" },
  server: {
    port: 5173,
    proxy: {
      "/health": API,
      "/auctions": API,
      "/chain": API,
      // Accounts. Missing these is not a visible 404: Vite answers unknown
      // paths with index.html for client-side routing, so the fetch succeeds
      // with an HTML body and only fails when something tries to read it as
      // JSON. Any new server route needs a line here.
      "/auth": API,
      "/me": API,
    },
  },
  // esnext because the WASM initialisation above is a top-level await, which
  // older build targets cannot express.
  build: { outDir: "dist", emptyOutDir: true, target: "esnext" },
  optimizeDeps: {
    // `buffer` must be pre-bundled too, or the alias above resolves to a
    // module the dev server has not processed and the same crash returns.
    include: ["buffer"],
    esbuildOptions: { target: "esnext", define: { global: "globalThis" } },
  },
});
