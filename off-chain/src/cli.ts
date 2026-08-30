/**
 * Turn thrown errors into something a person can read.
 *
 * Every script here ends in top-level `await`, so a thrown error surfaces as
 * an unhandled promise rejection and Deno prints a stack trace through Lucid
 * and Effect internals. The useful sentence -- usually one this project wrote
 * deliberately, explaining what is wrong and what to do -- ends up buried.
 *
 * Stack traces are still available with DEBUG=1, because when the failure is a
 * genuine bug rather than a refused transaction, the trace is the whole point.
 */

/** Ledger errors arrive as JSON buried in a message. Dig out the readable part. */
function ledgerErrors(message: string): string[] {
  const match = message.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const json = JSON.parse(match[0]);
    const found: string[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) {
          if (typeof item === "string" && /Failure|Error|UTxO/.test(item)) found.push(item);
          else walk(item);
        }
      } else if (node && typeof node === "object") {
        for (const v of Object.values(node)) walk(v);
      }
    };
    walk(json);
    return found;
  } catch {
    return [];
  }
}

function render(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const ledger = ledgerErrors(error.message);
  if (ledger.length > 0) {
    return `The node rejected this transaction:\n\n  ${ledger.join("\n  ")}`;
  }
  return error.message;
}

/**
 * Install the handler. Call once, at the top of a script, before any await.
 */
export function friendlyErrors(): void {
  const report = (error: unknown) => {
    console.error(`\n${render(error)}\n`);
    if (Deno.env.get("DEBUG")) console.error(error);
    else console.error("(re-run with DEBUG=1 for the full stack trace)\n");
    Deno.exit(1);
  };

  globalThis.addEventListener("unhandledrejection", (e) => {
    e.preventDefault();
    report(e.reason);
  });
  globalThis.addEventListener("error", (e) => {
    e.preventDefault();
    report(e.error);
  });
}
