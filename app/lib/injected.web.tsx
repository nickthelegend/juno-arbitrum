import { useCallback, useEffect, useState } from "react";
import { numberToHex, stringToHex } from "viem";

import { CHAIN } from "./chain";
import type { PrivyBridge, TxRequest } from "./privy.types";

/**
 * The same bridge as Privy's, backed by the browser's own EIP-1193 wallet
 * (MetaMask, Rabby, …): `EXPO_PUBLIC_WALLET=injected`. For networks Privy is
 * not set up for — the local Nitro dev node (scripts/localnet) — where the
 * page is served from a dev origin. Accounts come from `eth_requestAccounts`,
 * transactions and signatures from the wallet itself; nothing is simulated.
 */

type Eip1193 = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
};

function provider(): Eip1193 | null {
  return (globalThis as { ethereum?: Eip1193 }).ethereum ?? null;
}

export function useInjectedBridge(): PrivyBridge {
  const [address, setAddress] = useState<string | null>(null);
  const [status, setStatus] = useState<PrivyBridge["status"]>("loading");
  const [error, setError] = useState<string | null>(null);

  // Already-authorised accounts (no prompt), and account switches.
  useEffect(() => {
    const eth = provider();
    if (!eth) {
      setStatus("signed-out");
      setError("No browser wallet found. Install MetaMask or another EIP-1193 wallet.");
      return;
    }
    const onAccounts = (accounts: unknown) => {
      const first = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0].toLowerCase() : null;
      setAddress(first);
      setStatus(first ? "ready" : "signed-out");
    };
    eth.request({ method: "eth_accounts" }).then(onAccounts, () => setStatus("signed-out"));
    eth.on?.("accountsChanged", onAccounts);
    return () => eth.removeListener?.("accountsChanged", onAccounts);
  }, []);

  const switchChain = useCallback(async (chainId: number) => {
    const eth = provider();
    if (!eth) throw new Error("No browser wallet found.");
    const current = Number(await eth.request({ method: "eth_chainId" }));
    if (current === chainId) return;
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(chainId) }] });
    } catch {
      // Unknown to the wallet: add it (the app's own chain), then it switches.
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: numberToHex(CHAIN.id), chainName: CHAIN.name, nativeCurrency: CHAIN.nativeCurrency, rpcUrls: CHAIN.rpcUrls.default.http }],
      });
    }
  }, []);

  const openModal = useCallback(() => {
    const eth = provider();
    if (!eth) {
      setError("No browser wallet found. Install MetaMask or another EIP-1193 wallet.");
      return;
    }
    setStatus("creating");
    eth
      .request({ method: "eth_requestAccounts" })
      .then(async (accounts) => {
        const first = Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0].toLowerCase() : null;
        if (!first) throw new Error("The wallet shared no account.");
        await switchChain(CHAIN.id);
        setAddress(first);
        setStatus("ready");
        setError(null);
      })
      .catch((caught: unknown) => {
        setStatus("signed-out");
        setError(caught instanceof Error ? caught.message : "The wallet did not connect.");
      });
  }, [switchChain]);

  const sendTransaction = useCallback(
    async (tx: TxRequest) => {
      const eth = provider();
      if (!eth || !address) throw new Error("Sign in to continue.");
      await switchChain(tx.chainId);
      return (await eth.request({
        method: "eth_sendTransaction",
        params: [{ from: address, to: tx.to, data: tx.data, value: numberToHex(tx.value), ...(tx.gas ? { gas: numberToHex(tx.gas) } : {}) }],
      })) as `0x${string}`;
    },
    [address, switchChain],
  );

  const signMessage = useCallback(
    async (text: string) => {
      const eth = provider();
      if (!eth || !address) throw new Error("Sign in to continue.");
      return (await eth.request({ method: "personal_sign", params: [stringToHex(text), address] })) as `0x${string}`;
    },
    [address],
  );

  const unsupported = async () => {
    throw new Error("Email sign-in is not available here. Connect a browser wallet.");
  };

  return {
    enabled: true,
    emailLogin: false,
    ready: status !== "loading",
    status,
    address,
    walletStatus: status === "ready" ? "connected" : status,
    error,
    retry: async () => openModal(),
    sendCode: unsupported,
    loginWithCode: unsupported,
    openModal,
    sendTransaction,
    signMessage,
    switchChain,
    logout: async () => {
      // A browser wallet stays authorised until the person revokes it in the wallet.
      setAddress(null);
      setStatus("signed-out");
    },
  };
}
