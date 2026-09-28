import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { Keypair, Transaction } from "@solana/web3.js";
import { Platform } from "react-native";
import bs58 from "bs58";
import nacl from "tweetnacl";

import { juno } from "./api";
import { PrivyRoot, usePrivyBridge } from "./privy";
import { SignInSheet } from "../components/SignInSheet";

/**
 * The wallet.
 *
 * Juno's transactions are built on the server and signed here. This module owns
 * that second half: it holds a signing key, turns base64 transaction bytes into
 * a signed transaction, and hands the result back to be submitted.
 *
 * ## Two backends, and why both exist
 *
 * **Privy embedded wallet** is the intended one. It gives someone a Solana
 * wallet without installing anything, which is the only option that works in an
 * iOS Simulator — Solana's Mobile Wallet Adapter is Android-only and a Phantom
 * deeplink needs the real app installed, so neither can sign during the demo
 * this app is built for.
 *
 * On iOS and Android a new wallet is always a Privy one:
 * `connect()` opens the email sign-in sheet and resolves with the address once
 * Privy has made the wallet, so every "sign in first" path (buy, like, comment,
 * post) goes through the same door.
 *
 * **A local devnet key** is the fallback: the web build, which has no Privy,
 * and a phone that already holds a key from before Privy was added. It
 * generates a keypair, keeps it in the device keychain, and signs with it.
 *
 * The local mode is **not a simulation**. It produces real Ed25519 signatures,
 * lands real transactions on devnet, and the explorer link resolves. What it is
 * not is a recoverable wallet — the key lives only on this device and is worth
 * nothing beyond devnet. `mode` is exposed so the UI can say exactly that
 * rather than implying a custody story it does not have.
 */

export type WalletMode = "privy" | "local";

export type WalletState = {
  address: string | null;
  mode: WalletMode;
  ready: boolean;
  /** True while a signature is being produced. */
  signing: boolean;
  /**
   * Sign one server-built transaction and return it, still base64.
   *
   * Takes and returns base64 because that is what crosses the wire in both
   * directions; the `Transaction` round-trip is an implementation detail of
   * whichever backend is signing.
   */
  sign: (base64: string) => Promise<string>;
  /**
   * Sign a plain-text message and return the signature, base58.
   *
   * Used to prove ownership of this wallet off-chain — claiming a name — where
   * a transaction would cost a fee to say nothing the chain needs to know.
   */
  signMessage: (text: string) => Promise<string>;
  /** Create or restore a wallet. Called when the user first needs one. */
  connect: () => Promise<string>;
  disconnect: () => Promise<void>;
};

const WalletContext = createContext<WalletState | null>(null);

/** Keychain entry holding the local devnet key. */
const LOCAL_KEY = "juno.devnet.signer.v1";

/**
 * Where the key is kept: the keychain on a phone, `localStorage` on web.
 *
 * `expo-secure-store` ships an empty module for web, so every call threw and
 * the web build could never hold a wallet — likes, follows and trades all
 * failed at the first step without saying why. A devnet key in a browser's
 * storage is exactly as recoverable as one in a simulator's keychain, which
 * is to say not at all; the profile screen already says so.
 */
const store = {
  get: (key: string): Promise<string | null> =>
    Platform.OS === "web"
      ? Promise.resolve(globalThis.localStorage?.getItem(key) ?? null)
      : SecureStore.getItemAsync(key),
  set: (key: string, value: string): Promise<void> =>
    Platform.OS === "web"
      ? Promise.resolve(globalThis.localStorage?.setItem(key, value))
      : SecureStore.setItemAsync(key, value),
  remove: (key: string): Promise<void> =>
    Platform.OS === "web"
      ? Promise.resolve(globalThis.localStorage?.removeItem(key))
      : SecureStore.deleteItemAsync(key),
};

async function loadLocalKeypair(): Promise<Keypair | null> {
  try {
    const stored = await store.get(LOCAL_KEY);
    if (!stored) return null;
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(stored) as number[]));
  } catch {
    // A corrupt entry is worth discarding rather than crashing the app on boot.
    return null;
  }
}

async function createLocalKeypair(): Promise<Keypair> {
  const keypair = Keypair.generate();
  await store.set(LOCAL_KEY, JSON.stringify([...keypair.secretKey]));
  return keypair;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  return (
    <PrivyRoot>
      <Wallet>{children}</Wallet>
    </PrivyRoot>
  );
}

function Wallet({ children }: { children: React.ReactNode }) {
  const privy = usePrivyBridge();
  const [keypair, setKeypair] = useState<Keypair | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [signing, setSigning] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  // The `connect()` call waiting on the sign-in sheet.
  const pending = useRef<{ resolve: (address: string) => void; reject: (error: Error) => void } | null>(null);

  // Restore an existing key on boot so a returning user keeps their balance
  // and their position history.
  useEffect(() => {
    let cancelled = false;
    loadLocalKeypair().then((existing) => {
      if (cancelled) return;
      setKeypair(existing);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const address = privy.address ?? keypair?.publicKey.toBase58() ?? null;
  const ready = loaded && privy.ready;

  // Privy has made the wallet: hand the address to whoever asked for it.
  useEffect(() => {
    if (!privy.address) return;
    pending.current?.resolve(privy.address);
    pending.current = null;
    setSigningIn(false);
  }, [privy.address]);

  const connect = useCallback(async () => {
    if (address) return address;
    if (privy.enabled) {
      pending.current?.reject(new Error("Sign-in replaced"));
      return new Promise<string>((resolve, reject) => {
        pending.current = { resolve, reject };
        setSigningIn(true);
      });
    }
    const existing = await loadLocalKeypair();
    if (existing) {
      setKeypair(existing);
      return existing.publicKey.toBase58();
    }
    const created = await createLocalKeypair();
    setKeypair(created);
    return created.publicKey.toBase58();
  }, [address, privy.enabled]);

  const cancelSignIn = useCallback(() => {
    setSigningIn(false);
    pending.current?.reject(new Error("Sign-in cancelled"));
    pending.current = null;
  }, []);

  const disconnect = useCallback(async () => {
    if (privy.address) await privy.logout();
    await store.remove(LOCAL_KEY);
    setKeypair(null);
  }, [privy]);

  const sign = useCallback(
    async (base64: string) => {
      setSigning(true);
      try {
        const transaction = Transaction.from(Buffer.from(base64, "base64"));
        if (privy.address) {
          const signed = await privy.signTransaction(transaction);
          return signed.serialize().toString("base64");
        }
        const signer = keypair ?? (await loadLocalKeypair());
        if (!signer) throw new Error("No wallet to sign with");
        // `partialSign`, not `sign`: a launch transaction already carries the
        // signatures of the accounts it creates, and `sign` would discard them.
        transaction.partialSign(signer);
        return transaction.serialize().toString("base64");
      } finally {
        setSigning(false);
      }
    },
    [keypair, privy],
  );

  const signMessage = useCallback(
    async (text: string) => {
      if (privy.address) {
        const signature = await privy.signMessage(Buffer.from(text, "utf8").toString("base64"));
        return bs58.encode(Buffer.from(signature, "base64"));
      }
      const signer = keypair ?? (await loadLocalKeypair());
      if (!signer) throw new Error("No wallet to sign with");
      return bs58.encode(nacl.sign.detached(new TextEncoder().encode(text), signer.secretKey));
    },
    [keypair, privy],
  );

  const value = useMemo<WalletState>(
    () => ({
      address,
      mode: privy.address ? "privy" : "local",
      ready,
      signing,
      sign,
      signMessage,
      connect,
      disconnect,
    }),
    [address, privy.address, ready, signing, sign, signMessage, connect, disconnect],
  );

  return (
    <WalletContext.Provider value={value}>
      {children}
      {privy.enabled ? <SignInSheet visible={signingIn} onClose={cancelSignIn} privy={privy} /> : null}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletState {
  const context = useContext(WalletContext);
  if (!context) throw new Error("useWallet must be used inside a WalletProvider");
  return context;
}

/**
 * Build, sign and submit in one call.
 *
 * The three steps belong together because the middle one is worthless alone:
 * a signature that is never submitted is not a trade, and a caller that has to
 * remember to submit is a caller that will eventually forget.
 */
export async function signAndSubmit(
  wallet: WalletState,
  built: { transaction: string; window?: { blockhash: string; lastValidBlockHeight: number } },
  poolAddress?: string,
): Promise<string> {
  const signed = await wallet.sign(built.transaction);
  const { signature } = await juno.submit({
    transaction: signed,
    window: built.window,
    poolAddress,
  });
  return signature;
}
