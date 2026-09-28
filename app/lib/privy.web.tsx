import React, { useCallback, useEffect, useMemo, useRef } from "react";
import {
  PrivyProvider,
  useCreateWallet,
  useLoginWithEmail,
  usePrivy,
  useWallets,
  type ConnectedWallet,
} from "@privy-io/react-auth";
import { toHex } from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";

import { CHAIN } from "./chain";
import type { PrivyBridge, TxRequest } from "./privy.types";

/**
 * Privy in the browser: email with an embedded EVM wallet, or a browser
 * wallet (MetaMask and the rest) through Privy's own modal.
 *
 * Same bridge as `privy.native.tsx`, so the wallet provider, the sign-in
 * sheet and every screen are the same code on web as on a phone.
 *
 * The app id and client id are public; the app secret is never used here.
 */

export const APP_ID = process.env.EXPO_PUBLIC_PRIVY_APP_ID ?? "cmuh8o5on014v0cjmdk6w1l0q";
export const CLIENT_ID =
  process.env.EXPO_PUBLIC_PRIVY_CLIENT_ID ?? "client-WY6dy4WiB1bozhetK8yhaZh1mu4kQNUhF8a8SmV7xoJWN";

export const PRIVY_ENABLED = true;

const SUPPORTED = [CHAIN, ...[arbitrumSepolia, arbitrum].filter((chain) => chain.id !== CHAIN.id)];

export function PrivyRoot({ children }: { children: React.ReactNode }) {
  return (
    <PrivyProvider
      appId={APP_ID}
      clientId={CLIENT_ID}
      config={{
        loginMethods: ["email", "wallet"],
        defaultChain: CHAIN,
        supportedChains: SUPPORTED,
        appearance: {
          theme: "light",
          accentColor: "#12150E",
          walletChainType: "ethereum-only",
          showWalletLoginFirst: false,
        },
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
          // Juno's own sheets show the trade and its receipt; a second
          // confirmation modal on top would say the same thing again.
          showWalletUIs: false,
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}

type Provider = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

/** The embedded wallet if there is one, else the browser wallet the user signed in with. */
function pickWallet(wallets: ConnectedWallet[], linked: string | undefined): ConnectedWallet | null {
  const embedded = wallets.find((wallet) => wallet.walletClientType === "privy");
  if (embedded) return embedded;
  if (!linked) return null;
  return wallets.find((wallet) => wallet.address.toLowerCase() === linked.toLowerCase()) ?? null;
}

export function usePrivyBridge(): PrivyBridge {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { createWallet } = useCreateWallet();

  const signedIn = ready && authenticated && !!user;
  const wallet = signedIn ? pickWallet(wallets, user?.wallet?.address) : null;
  const hasEmbeddedAccount = !!user?.linkedAccounts?.some(
    (account) => account.type === "wallet" && "walletClientType" in account && account.walletClientType === "privy",
  );
  const hasAnyWallet = !!user?.wallet;
  const walletStatus = !walletsReady
    ? "loading"
    : wallet
      ? "connected"
      : hasAnyWallet
        ? "connecting"
        : signedIn
          ? "not-created"
          : "none";

  useEffect(() => {
    if (!ready) return;
    console.info(`[juno:privy] user=${signedIn ? "yes" : "no"} wallet=${walletStatus} wallets=${wallets.length}`);
  }, [ready, signedIn, walletStatus, wallets.length]);

  // `createOnLogin` covers a new sign-in. A user who signed in before the
  // wallet existed comes back with none, so make one — after giving
  // `createOnLogin` its chance: two creates at once is an error.
  const created = useRef(false);
  const errorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!signedIn || !walletsReady || hasAnyWallet || hasEmbeddedAccount || created.current) return;
    const timer = setTimeout(() => {
      created.current = true;
      createWallet().catch((e: unknown) => {
        errorRef.current = e instanceof Error ? e.message : String(e);
        console.error(`[juno:privy] create failed ${String(e)}`);
      });
    }, 2500);
    return () => clearTimeout(timer);
  }, [signedIn, walletsReady, hasAnyWallet, hasEmbeddedAccount, createWallet]);

  useEffect(() => {
    if (!signedIn) {
      created.current = false;
      errorRef.current = null;
    }
  }, [signedIn]);

  const retry = useCallback(async () => {
    if (wallet) return;
    errorRef.current = null;
    if (!hasAnyWallet) await createWallet();
  }, [wallet, hasAnyWallet, createWallet]);

  const email = useLoginWithEmail();
  const emailRef = useRef(email);
  emailRef.current = email;

  const sendCode = useCallback(async (address: string) => {
    await emailRef.current.sendCode({ email: address });
  }, []);

  const loginWithCode = useCallback(async (code: string) => {
    await emailRef.current.loginWithCode({ code });
  }, []);

  const openModal = useCallback(() => login(), [login]);

  const provider = useCallback(async (): Promise<Provider> => {
    if (!wallet) throw new Error("Your wallet is not ready yet");
    return (await wallet.getEthereumProvider()) as unknown as Provider;
  }, [wallet]);

  const switchChain = useCallback(
    async (chainId: number) => {
      if (!wallet) throw new Error("Your wallet is not ready yet");
      // `chainId` is CAIP-2 here: "eip155:421614".
      if (Number(wallet.chainId.split(":").pop()) === chainId) return;
      await wallet.switchChain(chainId);
    },
    [wallet],
  );

  const sendTransaction = useCallback(
    async (tx: TxRequest) => {
      if (!wallet) throw new Error("Your wallet is not ready yet");
      await switchChain(tx.chainId);
      // Asked for after the switch: a provider fetched before it keeps the old chain.
      const eth = await provider();
      const hash = await eth.request({
        method: "eth_sendTransaction",
        params: [{ from: wallet.address, to: tx.to, data: tx.data, value: toHex(tx.value), ...(tx.gas ? { gas: toHex(tx.gas) } : {}) }],
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
      // Hex-encoded UTF-8, the form every browser wallet and Privy's own accept.
      const signature = await eth.request({ method: "personal_sign", params: [toHex(text), wallet.address] });
      if (typeof signature !== "string") throw new Error("The wallet returned no signature");
      return signature as `0x${string}`;
    },
    [wallet, provider],
  );

  const status: PrivyBridge["status"] = !ready
    ? "loading"
    : !signedIn
      ? "signed-out"
      : wallet
        ? "ready"
        : errorRef.current
          ? "error"
          : "creating";

  return useMemo(
    () => ({
      enabled: true,
      ready,
      status,
      address: wallet?.address.toLowerCase() ?? null,
      walletStatus,
      error: status === "error" ? errorRef.current : null,
      retry,
      sendCode,
      loginWithCode,
      openModal,
      sendTransaction,
      signMessage,
      switchChain,
      logout,
    }),
    [ready, status, wallet, walletStatus, retry, sendCode, loginWithCode, openModal, sendTransaction, signMessage, switchChain, logout],
  );
}
