/**
 * Stand-in for `@std/dotenv/load` in the browser bundle.
 *
 * `src/config.ts` is shared with the Deno CLI, where importing that module
 * loads `.env` as a side effect. There is no `.env` in a browser -- and there
 * had better not be, since it holds seed phrases -- so Vite aliases the import
 * here, to nothing. Configuration reaches the browser through Vite's `VITE_`
 * variables instead, which is a separate and deliberately narrower channel.
 */
export {};
