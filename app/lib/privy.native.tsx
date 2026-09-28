import React, { useCallback, useEffect, useMemo, useRef } from "react";
import {
  PrivyProvider,
  useEmbeddedSolanaWallet,
  useLoginWithEmail,
  usePrivy,
} from "@privy-io/expo";
import type { Transaction } from "@solana/web3.js";

import type { PrivyBridge } from "./privy.types";

/**
 * Privy on iOS and Android: sign in with email, get an embedded Solana wallet.
 *
 * The key is not generated or stored on the phone. Privy holds it and signs
 * on request once the user has signed in, so a wallet survives a reinstall or
 * a new phone, which the old device-only key never could.
 *
 * The app id and client id are public: they ship inside every build and only
 * work from the bundle ids and URL schemes allowed in the Privy dashboard.
 * The app secret is for servers and is not used here.
 */

const APP_ID = process.env.EXPO_PUBLIC_PRIVY_APP_ID ?? "cmuh8o5on014v0cjmdk6w1l0q";
const CLIENT_ID =
  process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID ?? "client-WY6dy4WiB1bozhetK8yhaZh1mu4kQNUhF8a8SmV7xoJWN";

export const PRIVY_ENABLED = true;

export function PrivyRoot({ children }: { children: React.ReactNode }) {
  return (
    <PrivyProvider
      appId={APP_ID}
      clientId={CLIENT_ID}
      config={{ embedded: { solana: { createOnLogin: "users-without-wallets" } } }}
    >
      {children}
    </PrivyProvider>
  );
}

export function usePrivyBridge(): PrivyBridge {
  const { user, isReady, logout } = usePrivy();
  const solana = useEmbeddedSolanaWallet();
  const email = useLoginWithEmail();

  // `wallets` is the current API; `publicKey` plus the state-level provider is
  // the older one, kept as a fallback in case the list has not filled yet.
  const wallet =
    solana.status === "connected"
      ? solana.wallets?.[0] ??
        (solana.publicKey && solana.getProvider
          ? { address: solana.publicKey, getProvider: solana.getProvider }
          : null)
      : null;
  const walletError = solana.status === "error" ? solana.error : null;

  // Release builds only surface console.error, so the wallet's progress is
  // logged at that level: it is the one thing worth reading when sign-in stalls.
  useEffect(() => {
    console.error(`[juno:privy] user=${user ? "yes" : "no"} solana=${solana.status}${walletError ? ` error=${walletError}` : ""}`);
  }, [user, solana.status, walletError]);

  // `createOnLogin` covers a new sign-in. A user who signed in before the
  // wallet existed comes back with none, so make one, but only after giving
  // `createOnLogin` time to run: two creates at once is an error.
  const created = useRef(false);
  useEffect(() => {
    if (!user || solana.status !== "not-created" || created.current) return;
    const timer = setTimeout(() => {
      created.current = true;
      solana.create?.().catch((e: unknown) => console.error(`[juno:privy] create failed ${String(e)}`));
    }, 2500);
    return () => clearTimeout(timer);
  }, [user, solana]);

  const retry = useCallback(async () => {
    if (solana.status === "connected") return;
    if (solana.status === "needs-recovery" || solana.status === "disconnected") {
      await solana.getProvider?.();
      return;
    }
    await solana.create?.();
  }, [solana]);

  const sendCode = useCallback(
    async (address: string) => {
      await email.sendCode({ email: address });
    },
    [email],
  );

  const loginWithCode = useCallback(
    async (code: string, address: string) => {
      await email.loginWithCode({ code, email: address });
    },
    [email],
  );

  const signTransaction = useCallback(
    async (transaction: Transaction) => {
      if (!wallet) throw new Error("Privy wallet is not ready");
      const provider = await wallet.getProvider();
      // Privy adds its signature with `addSignature`, so the signatures a launch
      // transaction already carries are kept.
      const { signedTransaction } = await provider.request({
        method: "signTransaction",
        params: { transaction },
      });
      return signedTransaction;
    },
    [wallet],
  );

  const signMessage = useCallback(
    async (base64: string) => {
      if (!wallet) throw new Error("Privy wallet is not ready");
      const provider = await wallet.getProvider();
      const { signature } = await provider.request({
        method: "signMessage",
        params: { message: base64 },
      });
      return signature;
    },
    [wallet],
  );

  const status: PrivyBridge["status"] = !isReady
    ? "loading"
    : !user
      ? "signed-out"
      : wallet
        ? "ready"
        : walletError
          ? "error"
          : "creating";

  return useMemo(
    () => ({
      enabled: true,
      ready: isReady,
      status,
      address: wallet?.address ?? null,
      walletStatus: solana.status,
      error: walletError,
      retry,
      sendCode,
      loginWithCode,
      signTransaction,
      signMessage,
      logout,
    }),
    [isReady, status, wallet, solana.status, walletError, retry, sendCode, loginWithCode, signTransaction, signMessage, logout],
  );
}
