import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { parseEventLogs, type Hex, type TransactionReceipt } from "viem";
import { junoFactoryAbi } from "@config/abi";

import { juno, type TxRecord, type TxStep } from "./api";
import { CHAIN_ID, chainFor, describeTxError, publicClient, TxError } from "./chain";
import { PrivyRoot, usePrivyBridge } from "./privy";
import { SignInSheet } from "../components/SignInSheet";

/**
 * The wallet.
 *
 * Juno's transactions are built on the server — calldata, value, the steps in
 * order — and sent from here by the person's own Privy wallet. This module
 * owns that second half: make sure the wallet is on the app's chain, send each
 * step, wait for its receipt before the next, and tell the server what landed.
 *
 * There is one backend on every platform: a Privy embedded EVM wallet (or, in
 * a browser, a wallet such as MetaMask signed in through Privy). `connect()`
 * opens the sign-in sheet and resolves with the address once Privy has one, so
 * every "sign in first" path (buy, like, comment, post) goes through the same
 * door.
 */

export type SendProgress = {
  /** Index of the step this is about. */
  index: number;
  label: string;
  phase: "checking" | "signing" | "confirming" | "confirmed";
  hash?: Hex;
};

export type SendResult = {
  hashes: Hex[];
  receipts: TransactionReceipt[];
  /**
   * The server's record of the last transaction. Null when that call failed:
   * the transaction still landed, and the indexer will find it.
   */
  record: TxRecord | null;
  /** A launch's token and curve, from the server's record or, failing that, the receipt itself. */
  launched: { token: string; curve: string } | null;
  /** When the last receipt came back. */
  confirmedAt: Date;
};

export type WalletState = {
  /** Lowercase 0x address, or null when signed out. */
  address: string | null;
  ready: boolean;
  /** True while a transaction or a signature is in flight. */
  signing: boolean;
  /**
   * Send server-built steps in order, each confirmed before the next.
   *
   * Throws a `TxError` whose message is ready to show; `cancelled` is set when
   * the person declined in their wallet, and the caller should then say nothing.
   */
  send: (
    steps: TxStep[],
    options?: { chainId?: number; onProgress?: (progress: SendProgress) => void },
  ) => Promise<SendResult>;
  /** EIP-191 `personal_sign` over `text`. Returns the 0x signature. */
  signMessage: (text: string) => Promise<string>;
  /** Open the sign-in sheet (every platform) and resolve with the address. */
  connect: () => Promise<string>;
  disconnect: () => Promise<void>;
};

const WalletContext = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  return (
    <PrivyRoot>
      <Wallet>{children}</Wallet>
    </PrivyRoot>
  );
}

/**
 * Replay a transaction as a call to learn why it would revert.
 *
 * Returns null when the call succeeds, or when the failure is not a revert
 * (an RPC hiccup is not a reason to refuse to send). At `blockNumber` it
 * answers why a mined transaction reverted.
 */
async function whyReverts(
  from: string,
  step: { to: Hex; data: Hex; value: bigint },
  blockNumber?: bigint,
): Promise<TxError | null> {
  try {
    await publicClient.call({
      account: from as Hex,
      to: step.to,
      data: step.data,
      value: step.value,
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });
    return null;
  } catch (error) {
    const failure = describeTxError(error);
    // Only a contract saying no is worth stopping for; anything else might
    // be the RPC, and the wallet's own send will say if it really fails.
    if (failure.reason) return new TxError(failure);
    const text = error instanceof Error ? error.message : String(error);
    if (/execution reverted|revert/i.test(text)) return new TxError(failure);
    return null;
  }
}

function launchedFrom(receipt: TransactionReceipt): { token: string; curve: string } | null {
  try {
    const [event] = parseEventLogs({ abi: junoFactoryAbi, logs: receipt.logs, eventName: "Launched" });
    if (!event) return null;
    const args = event.args as { token: string; curve: string };
    return { token: args.token.toLowerCase(), curve: args.curve.toLowerCase() };
  } catch {
    return null;
  }
}

function Wallet({ children }: { children: React.ReactNode }) {
  const privy = usePrivyBridge();
  const [signing, setSigning] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  // The `connect()` call waiting on the sign-in sheet.
  const pending = useRef<{ resolve: (address: string) => void; reject: (error: Error) => void } | null>(null);

  const address = privy.address;
  /*
   * Ready when Privy is, or after a few seconds regardless.
   *
   * Every read that shows the viewer's own state waits on `ready`, and a
   * Privy that never initialises — no network to auth.privy.io, or a web
   * origin not yet allowed in the Privy dashboard — would otherwise leave the
   * whole feed on a skeleton. Past the wait the app carries on signed out;
   * if Privy arrives later, the address appears and the reads follow it.
   */
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (privy.ready) return;
    const timer = setTimeout(() => {
      console.warn("[juno:wallet] Privy did not become ready in 5s; continuing signed out");
      setGaveUp(true);
    }, 5000);
    return () => clearTimeout(timer);
  }, [privy.ready]);
  const ready = privy.ready || gaveUp;

  // Privy has made the wallet: hand the address to whoever asked for it.
  useEffect(() => {
    if (!privy.address) return;
    pending.current?.resolve(privy.address);
    pending.current = null;
    setSigningIn(false);
  }, [privy.address]);

  const connect = useCallback(async () => {
    if (address) return address;
    pending.current?.reject(new Error("Sign-in replaced"));
    return new Promise<string>((resolve, reject) => {
      pending.current = { resolve, reject };
      setSigningIn(true);
    });
  }, [address]);

  const cancelSignIn = useCallback(() => {
    setSigningIn(false);
    pending.current?.reject(new TxError({ message: "Sign in to continue.", cancelled: true, reason: null }));
    pending.current = null;
  }, []);

  const disconnect = useCallback(async () => {
    await privy.logout();
  }, [privy]);

  const send = useCallback<WalletState["send"]>(
    async (steps, options = {}) => {
      const from = privy.address;
      if (!from) throw new TxError({ message: "Sign in to continue.", cancelled: false, reason: null });
      if (steps.length === 0) throw new TxError({ message: "Nothing to send.", cancelled: false, reason: null });
      const chainId = options.chainId ?? CHAIN_ID;
      const progress = options.onProgress ?? (() => undefined);

      setSigning(true);
      const hashes: Hex[] = [];
      const receipts: TransactionReceipt[] = [];
      try {
        try {
          await privy.switchChain(chainId);
        } catch (error) {
          const failure = describeTxError(error);
          if (failure.cancelled) throw new TxError(failure);
          throw new TxError({
            message: `Switch your wallet to ${chainFor(chainId)?.name ?? `chain ${chainId}`} and try again.`,
            cancelled: false,
            reason: null,
          });
        }

        for (const [index, step] of steps.entries()) {
          const tx = {
            to: step.to as Hex,
            data: step.data as Hex,
            value: BigInt(step.value || "0"),
          };

          // Ask the chain first, so a revert is explained before anything is
          // signed rather than after gas is spent on it. Each step runs after
          // the previous one confirmed, so a buy is checked with its approval
          // already in place.
          progress({ index, label: step.label, phase: "checking" });
          const refusal = await whyReverts(from, tx);
          if (refusal) throw refusal;

          progress({ index, label: step.label, phase: "signing" });
          let hash: Hex;
          try {
            hash = await privy.sendTransaction({ ...tx, chainId });
          } catch (error) {
            throw new TxError(describeTxError(error));
          }
          hashes.push(hash);

          progress({ index, label: step.label, phase: "confirming", hash });
          const receipt = await publicClient
            .waitForTransactionReceipt({ hash, timeout: 120_000, pollingInterval: 1_000 })
            .catch((error: unknown) => {
              throw new TxError({
                message: `Sent, but no receipt yet (${hash.slice(0, 10)}…). Check it on Arbiscan before trying again.`,
                cancelled: false,
                reason: describeTxError(error).reason,
              });
            });
          if (receipt.status !== "success") {
            const why = await whyReverts(from, tx, receipt.blockNumber);
            throw why ?? new TxError({ message: `${step.label} reverted on-chain.`, cancelled: false, reason: null });
          }
          receipts.push(receipt);
          progress({ index, label: step.label, phase: "confirmed", hash });
        }

        const last = hashes[hashes.length - 1]!;
        const record = await juno.recordTx({ chainId, txHash: last }).catch((error: unknown) => {
          console.warn(`[juno:wallet] tx/record failed for ${last}: ${String(error)}`);
          return null;
        });
        const launched =
          (record?.launched
            ? { token: record.launched.token.toLowerCase(), curve: record.launched.curve.toLowerCase() }
            : null) ?? launchedFrom(receipts[receipts.length - 1]!);

        return { hashes, receipts, record, launched, confirmedAt: new Date() };
      } finally {
        setSigning(false);
      }
    },
    [privy],
  );

  const signMessage = useCallback(
    async (text: string) => {
      if (!privy.address) throw new Error("Sign in to continue.");
      setSigning(true);
      try {
        return await privy.signMessage(text);
      } catch (error) {
        throw new TxError(describeTxError(error));
      } finally {
        setSigning(false);
      }
    },
    [privy],
  );

  const value = useMemo<WalletState>(
    () => ({ address, ready, signing, send, signMessage, connect, disconnect }),
    [address, ready, signing, send, signMessage, connect, disconnect],
  );

  return (
    <WalletContext.Provider value={value}>
      {children}
      <SignInSheet
        visible={signingIn}
        onClose={cancelSignIn}
        // Privy's own modal takes over; the pending `connect()` resolves when
        // its wallet arrives, exactly as the email path does.
        onHandOff={() => setSigningIn(false)}
        privy={privy}
      />
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletState {
  const context = useContext(WalletContext);
  if (!context) throw new Error("useWallet must be used inside a WalletProvider");
  return context;
}

