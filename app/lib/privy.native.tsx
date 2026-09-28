import React, { useCallback, useEffect, useMemo, useRef } from "react";
import {
  PrivyProvider,
  useEmbeddedEthereumWallet,
  useEmbeddedWallet,
  useLoginWithEmail,
  usePrivy,
} from "@privy-io/expo";
import { toHex } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";

import { CHAIN } from "./chain";
import type { PrivyBridge, TxRequest } from "./privy.types";

/**
 * Privy on iOS and Android: sign in with email, get an embedded EVM wallet.
 *
 * The key is not generated or stored on the phone. Privy holds it and signs
 * on request once the user has signed in, so a wallet survives a reinstall or
 * a new phone.
 *
 * The app id and client id are public: they ship inside every build and only
 * work from the bundle ids and URL schemes allowed in the Privy dashboard.
 * The app secret is for servers and is never used here.
 */

export const APP_ID = process.env.EXPO_PUBLIC_PRIVY_APP_ID ?? "cmuh8o5on014v0cjmdk6w1l0q";
export const CLIENT_ID =
  process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID ?? "client-WY6dy4WiB1bozhetK8yhaZh1mu4kQNUhF8a8SmV7xoJWN";

export const PRIVY_ENABLED = true;

// The app's chain first: an embedded wallet starts on the first supported chain.
const SUPPORTED = [CHAIN, ...[arbitrumSepolia, arbitrum].filter((chain) => chain.id !== CHAIN.id)] as [
  typeof CHAIN,
  ...(typeof CHAIN)[],
];

export function PrivyRoot({ children }: { children: React.ReactNode }) {
  return (
    <PrivyProvider
      appId={APP_ID}
      clientId={CLIENT_ID}
      supportedChains={SUPPORTED}
      config={{ embedded: { ethereum: { createOnLogin: "users-without-wallets" } } }}
    >
      {children}
    </PrivyProvider>
  );
}

type Provider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

export function usePrivyBridge(): PrivyBridge {
  const { user, isReady, logout } = usePrivy();
  const ethereum = useEmbeddedEthereumWallet();
  /*
   * The wallet's lifecycle state. `useEmbeddedEthereumWallet` gives the list
   * and `create`, but not where a wallet is between "none" and "connected" —
   * and that is the one thing worth showing when sign-in stalls, and the only
   * way to see "needs-recovery" (a returning user on a new device).
   */
  const state = useEmbeddedWallet();
  const wallet = ethereum.wallets?.[0] ?? null;
  const walletError = state.status === "error" ? state.error : null;

  // Release builds only surface console.error, so the wallet's progress is
  // logged at that level: it is the one thing worth reading when sign-in stalls.
  useEffect(() => {
    console.error(
      `[juno:privy] user=${user ? "yes" : "no"} ethereum=${state.status} wallets=${ethereum.wallets?.length ?? 0}${
        walletError ? ` error=${walletError}` : ""
      }`,
    );
  }, [user, state.status, ethereum.wallets?.length, walletError]);

  // `createOnLogin` covers a new sign-in. A user who signed in before the
  // wallet existed comes back with none, so make one, but only after giving
  // `createOnLogin` time to run: two creates at once is an error.
  const created = useRef(false);
  const create = ethereum.create;
  useEffect(() => {
    if (!user || wallet || state.status !== "not-created" || created.current) return;
    const timer = setTimeout(() => {
      created.current = true;
      create().catch((e: unknown) => console.error(`[juno:privy] create failed ${String(e)}`));
    }, 2500);
    return () => clearTimeout(timer);
  }, [user, wallet, state.status, create]);

  // A new session gets its own chance at the fallback create.
  useEffect(() => {
    if (!user) created.current = false;
  }, [user]);

  const retry = useCallback(async () => {
    if (wallet && state.status === "connected") return;
    if (state.status === "needs-recovery" || state.status === "disconnected" || wallet) {
      // Privy-managed recovery: asking for the provider reconnects the wallet.
      await state.getProvider();
      return;
    }
    await create();
  }, [wallet, state, create]);

  // The hook's object changes identity every render; the ref keeps the two
  // callbacks below stable so the bridge does not churn while the sheet types.
  const email = useLoginWithEmail();
  const emailRef = useRef(email);
  emailRef.current = email;

  const sendCode = useCallback(async (address: string) => {
    await emailRef.current.sendCode({ email: address });
  }, []);

  const loginWithCode = useCallback(async (code: string, address: string) => {
    await emailRef.current.loginWithCode({ code, email: address });
  }, []);

  const provider = useCallback(async (): Promise<Provider> => {
    if (!wallet) throw new Error("Your wallet is not ready yet");
    return (await wallet.getProvider()) as unknown as Provider;
  }, [wallet]);

  const switchChain = useCallback(
    async (chainId: number) => {
      const eth = await provider();
      const current = await eth.request({ method: "eth_chainId" }).catch(() => null);
      if (typeof current === "string" && Number(current) === chainId) return;
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHex(chainId) }] });
    },
    [provider],
  );

  const sendTransaction = useCallback(
    async (tx: TxRequest) => {
      if (!wallet) throw new Error("Your wallet is not ready yet");
      await switchChain(tx.chainId);
      const eth = await provider();
      const hash = await eth.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: wallet.address,
            to: tx.to,
            data: tx.data,
            value: toHex(tx.value),
            chainId: toHex(tx.chainId),
            ...(tx.gas ? { gas: toHex(tx.gas) } : {}),
          },
        ],
      });
      if (typeof hash !== "string" || !hash.startsWith("0x")) throw new Error("The wallet returned no transaction hash");
      return hash as `0x${string}`;
    },
    [wallet, provider, switchChain],
  );

  const signMessage = useCallback(
    async (text: string) => {
      if (!wallet) throw new Error("Your wallet is not ready yet");
      const eth = await provider();
      // Hex-encoded UTF-8: Privy signs hex as the bytes it spells, which are
      // exactly the text the server rebuilds and verifies.
      const signature = await eth.request({ method: "personal_sign", params: [toHex(text), wallet.address] });
      if (typeof signature !== "string") throw new Error("The wallet returned no signature");
      return signature as `0x${string}`;
    },
    [wallet, provider],
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
      address: wallet?.address?.toLowerCase() ?? null,
      walletStatus: state.status,
      error: walletError,
      retry,
      sendCode,
      loginWithCode,
      sendTransaction,
      signMessage,
      switchChain,
      logout,
    }),
    [
      isReady,
      status,
      wallet,
      state.status,
      walletError,
      retry,
      sendCode,
      loginWithCode,
      sendTransaction,
      signMessage,
      switchChain,
      logout,
    ],
  );
}
