import { signIn } from "../src/auth.ts";

for (const scenario of [
  { name: "valid session", session: { user: { id: 1 }, address: "wallet-a" }, signatures: 0 },
  { name: "proved linked address", session: { user: { id: 1 }, address: "wallet-b", addresses: ["wallet-a"] }, signatures: 0 },
  { name: "expired session", session: { user: null }, signatures: 1 },
  { name: "different wallet", session: { user: { id: 2 }, address: "wallet-b" }, signatures: 1 },
]) {
  Deno.test(`login: ${scenario.name}`, async () => {
    const original = globalThis.fetch;
    let signatures = 0;
    const paths: string[] = [];
    globalThis.fetch = async (input, init) => {
      const path = String(input);
      paths.push(path);
      if (init?.credentials !== "same-origin") throw new Error("Session cookie omitted");
      if (path === "/auth/me") return Response.json(scenario.session);
      if (path === "/auth/nonce") return Response.json({ nonce: "nonce", payloadHex: "payload" });
      if (path === "/auth/login") return Response.json({ user: { id: 1 }, address: "wallet-a", isNew: true });
      throw new Error(`Unexpected request: ${path}`);
    };
    try {
      const result = await signIn({ wallet: () => ({
        address: () => Promise.resolve("wallet-a"),
        signMessage: (address, payload) => {
          if (address !== "wallet-a" || payload !== "payload") throw new Error("Wrong signing payload");
          signatures++;
          return Promise.resolve({ signature: "signature", key: "key" });
        },
      }) });
      if (signatures !== scenario.signatures) throw new Error(`Unexpected signatures: ${signatures}`);
      if (!result.user) throw new Error("Login did not produce an account");
      if (!scenario.signatures && (paths.length !== 1 || result.isNew)) throw new Error("Existing session was not reused");
      if (scenario.signatures && paths.join() !== "/auth/me,/auth/nonce,/auth/login") throw new Error("Incorrect authentication sequence");
    } finally { globalThis.fetch = original; }
  });
}

Deno.test("login: unavailable session endpoint does not trigger a signature", async () => {
  const original = globalThis.fetch;
  let signed = false;
  globalThis.fetch = () => Promise.reject(new Error("Offline"));
  try {
    let rejected = false;
    try {
      await signIn({ wallet: () => ({ address: () => Promise.resolve("wallet-a"), signMessage: () => {
        signed = true;
        return Promise.resolve({ signature: "signature", key: "key" });
      } }) });
    } catch { rejected = true; }
    if (!rejected || signed) throw new Error("Authentication must stop before requesting a signature");
  } finally { globalThis.fetch = original; }
});
