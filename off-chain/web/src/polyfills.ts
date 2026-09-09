/**
 * Node globals that Lucid's dependency tree expects to exist.
 *
 * Lucid is published for Node and for the browser, but parts of what it depends
 * on (safe-buffer, readable-stream and friends) reach for `Buffer`, `process`
 * and `global` without importing them. In Node those are ambient; in a browser
 * they are not, and the failures are uninformative -- the first appears as
 * "Cannot read properties of undefined (reading 'from')" from inside a
 * pre-bundled Lucid, naming nothing that suggests a missing polyfill.
 *
 * **Import this before anything that touches Lucid.** ES modules are evaluated
 * depth-first in import order, so `main.tsx` importing this first is what
 * guarantees these exist by the time Lucid's module body runs.
 *
 * Each is installed only if absent, so a browser that provides its own is left
 * alone, and nothing here shadows a real implementation.
 */
import { Buffer } from "buffer";

const g = globalThis as Record<string, unknown>;

if (!g.Buffer) g.Buffer = Buffer;
if (!g.global) g.global = globalThis;

if (!g.process) {
  // The smallest `process` that satisfies the checks made of it: libraries test
  // `process.env.NODE_ENV`, branch on `process.browser`, and occasionally defer
  // work with `nextTick`. queueMicrotask has the semantics nextTick is used for
  // here -- run after the current task, before rendering.
  g.process = {
    env: {},
    browser: true,
    version: "",
    versions: {},
    platform: "browser",
    nextTick: (fn: (...a: unknown[]) => void, ...args: unknown[]) =>
      queueMicrotask(() => fn(...args)),
  };
}
