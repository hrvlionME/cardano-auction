/**
 * Everything the whole app needs to know about *who is here*: the connected
 * wallet, and the optional account behind it.
 *
 * The two are deliberately separate, and keeping them separate in one context
 * rather than collapsing them is the point:
 *
 *   **the wallet** is capability. It can sign, so it can bid, settle and burn.
 *   Nothing on this server is consulted for any of that.
 *
 *   **the account** is identity. It knows a name, an email and where to post a
 *   parcel. It can sign nothing.
 *
 * So `conn && !me.user` is a perfectly ordinary state -- connected, able to bid,
 * declining to be known -- and the interface must keep working in it. That is
 * not an edge case to tolerate; it is the property worth demonstrating, because
 * on a conventional auction site the account *is* the ability to bid, and here
 * it is not.
 */
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { isTestnet, makeBrowserLucid } from "./chain.ts";
import {
  alreadyEnabled,
  type AvailableWallet,
  availableWallets,
  connect,
  WalletError,
  type WalletApi,
} from "./wallet.ts";
import { me as fetchMe, signIn as doSignIn, signOut as doSignOut } from "./auth.ts";
import type { Me } from "./types.ts";

export type Lucid = Awaited<ReturnType<typeof makeBrowserLucid>>;

export interface Connected {
  api: WalletApi;
  lucid: Lucid;
  address: string;
  balance: bigint;
}

interface Session {
  /** Wallet extensions this browser has. */
  wallets: AvailableWallet[];
  conn: Connected | null;
  me: Me;
  connecting: boolean;
  signingIn: boolean;
  error: string | null;
  /**
   * Connect a wallet. Deliberately does *not* ask for a sign-in signature --
   * see the note on `signIn`.
   */
  connectWallet: (key: string) => Promise<boolean>;
  /** Sign in with an already-connected wallet. Always user-initiated. */
  signIn: () => Promise<boolean>;
  /** Drop the wallet but keep any account session. */
  disconnect: () => void;
  signOut: () => Promise<void>;
  setMe: (m: Me) => void;
  refreshBalance: () => Promise<void>;
  dismissError: () => void;
  /** True the first time an account is created, so the UI can say hello once. */
  isNew: boolean;
  clearIsNew: () => void;
}

const Ctx = createContext<Session | null>(null);

/** Sum the lovelace the connected wallet can actually spend. */
async function readBalance(lucid: Lucid): Promise<bigint> {
  const utxos = await lucid.wallet().getUtxos();
  return utxos.reduce((sum, u) => sum + (u.assets.lovelace ?? 0n), 0n);
}

/** Declining a signature is a choice, not a fault, and must not be shown as one. */
const declined = (msg: string) => /declin|reject|denied|cancel|user|refus/i.test(msg);

/**
 * Which wallet was last connected here.
 *
 * Only the extension's key -- "eternl", "lace" -- never an address, a session or
 * anything secret. It is a hint about which of several installed wallets to
 * reconnect to, and reconnecting still requires that the wallet itself has the
 * page authorised. Wrapped because storage throws outright in a private window
 * with site data blocked, and a page that cannot remember a preference should
 * still work.
 */
const LAST_WALLET = "auction.wallet";
const remember = (key: string | null) => {
  try {
    key === null ? localStorage.removeItem(LAST_WALLET) : localStorage.setItem(LAST_WALLET, key);
  } catch { /* storage unavailable; reconnecting just is not remembered */ }
};
const remembered = (): string | null => {
  try {
    return localStorage.getItem(LAST_WALLET);
  } catch {
    return null;
  }
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const [wallets, setWallets] = useState<AvailableWallet[]>([]);
  const [conn, setConn] = useState<Connected | null>(null);
  const [me, setMe] = useState<Me>({ user: null });
  const [connecting, setConnecting] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);

  // Extensions inject themselves as the page loads, so a single read on mount
  // reports "no wallet installed" for a browser that has one. Poll briefly.
  useEffect(() => {
    let tries = 0;
    const id = setInterval(() => {
      const found = availableWallets();
      if (found.length > 0 || ++tries > 10) {
        setWallets(found);
        clearInterval(id);
      }
    }, 300);
    setWallets(availableWallets());
    return () => clearInterval(id);
  }, []);

  // An existing session survives a reload, so ask before doing anything else.
  useEffect(() => {
    fetchMe().then((m) => setMe(m ?? { user: null })).catch(() => {});
  }, []);

  const signInWith = useCallback(async (lucid: Lucid): Promise<boolean> => {
    setSigningIn(true);
    setError(null);
    try {
      const result = await doSignIn(lucid);
      setMe(result);
      if (result.isNew) setIsNew(true);
      return true;
    } catch (e) {
      // Refusing the signature leaves the wallet connected and bidding fully
      // available, so it stays silent. Anything else is a real fault and must
      // be visible: swallowing it once meant a misconfigured dev proxy looked
      // exactly like a user saying no.
      const msg = e instanceof Error ? e.message : String(e);
      if (!declined(msg)) setError(`Could not sign in: ${msg}`);
      return false;
    } finally {
      setSigningIn(false);
    }
  }, []);

  /**
   * Connect a wallet, and nothing else.
   *
   * It used to sign in straight afterwards, which meant two prompts in a row --
   * and, worse, a *signature* prompt on every connect even when the browser
   * already held a perfectly valid session. Signing something you have already
   * signed teaches people to click through prompts without reading them, which
   * is precisely the habit this design is trying not to build.
   *
   * So connecting is now only connecting. It is all that bidding, settling and
   * burning need: those are transactions the chain validates, and this server
   * is never consulted for one. Signing in is a separate, explicit act that
   * happens at most once a month.
   */
  const connectWallet = useCallback(async (key: string): Promise<boolean> => {
    setConnecting(true);
    setError(null);
    try {
      const api = await connect(key, isTestnet);
      const lucid = await makeBrowserLucid(api);
      const address = await lucid.wallet().address();
      setConn({ api, lucid, address, balance: await readBalance(lucid) });
      remember(key);
      return true;
    } catch (e) {
      setError(
        e instanceof WalletError
          ? e.message
          : `Could not connect: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    } finally {
      setConnecting(false);
    }
  }, []);

  /**
   * Reconnect on load to the wallet this browser used last.
   *
   * Silent by construction: `alreadyEnabled` asks the extension whether it has
   * this origin authorised, and only then is `enable()` called -- which a wallet
   * that already trusts the page answers without showing anything. A wallet that
   * has since revoked access simply is not reconnected, with no dialog and no
   * error, because the user did not ask for one.
   */
  useEffect(() => {
    const key = remembered();
    if (!key) return;
    let cancelled = false;
    (async () => {
      // Extensions inject themselves as the page loads; give them a moment.
      for (let i = 0; i < 12 && !cancelled; i++) {
        if (await alreadyEnabled(key)) {
          if (!cancelled) await connectWallet(key);
          return;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectWallet]);

  const signIn = useCallback(
    () => conn ? signInWith(conn.lucid) : Promise.resolve(false),
    [conn, signInWith],
  );

  /** Drop the wallet, keep the account. Used by "disconnect" rather than "sign out". */
  const disconnect = useCallback(() => {
    remember(null);
    setConn(null);
  }, []);

  const signOut = useCallback(async () => {
    try {
      await doSignOut();
    } catch { /* the cookie expires on its own */ }
    setMe({ user: null });
    remember(null);
    setConn(null);
  }, []);

  // Held in a ref as well as in state so `refreshBalance` can stay a stable
  // callback: it is a dependency of polling effects, and rebuilding it on every
  // balance change would tear those down and rebuild them each time.
  const connRef = useRef<Connected | null>(null);
  connRef.current = conn;

  const refreshBalance = useCallback(async () => {
    const current = connRef.current;
    if (!current) return;
    try {
      const balance = await readBalance(current.lucid);
      setConn((c) => (c && c.address === current.address ? { ...c, balance } : c));
    } catch {
      // A balance that fails to refresh is a stale number on screen, not a
      // reason to interrupt anything. The next poll tries again.
    }
  }, []);

  return (
    <Ctx.Provider
      value={{
        wallets,
        conn,
        me,
        connecting,
        signingIn,
        error,
        connectWallet,
        signIn,
        disconnect,
        signOut,
        setMe,
        refreshBalance,
        dismissError: () => setError(null),
        isNew,
        clearIsNew: () => setIsNew(false),
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useSession(): Session {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession must be used inside <SessionProvider>");
  return ctx;
}
