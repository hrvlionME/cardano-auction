/**
 * Minimal ambient declaration of the Deno globals the *shared* modules use.
 *
 * `off-chain/src/` is compiled twice: by Deno for the CLI, where these exist,
 * and by tsc/Vite for the browser, where they do not. Without this, checking
 * the web app reports "Cannot find name 'Deno'" for code that is correct and
 * never runs in a browser.
 *
 * The declaration is deliberately not `| undefined`. The shared code guards its
 * own usage at runtime (`typeof Deno !== "undefined"`, and file access confined
 * to functions the browser never calls); making the type optional would force
 * redundant non-null assertions into code that is correct as written on the
 * platform it actually runs on.
 *
 * Only what is genuinely referenced is listed. If a shared module starts using
 * another Deno API, this file should grow deliberately rather than becoming a
 * blanket `any` -- the narrowness is what stops browser code reaching for the
 * filesystem by accident.
 */
declare const Deno: {
  env: { get(name: string): string | undefined };
  readTextFile(path: string | URL): Promise<string>;
  readDir(path: string | URL): AsyncIterable<{ name: string; isFile: boolean }>;
  mkdir(path: string | URL, options?: { recursive?: boolean }): Promise<void>;
  writeTextFile(path: string | URL, data: string): Promise<void>;
};
