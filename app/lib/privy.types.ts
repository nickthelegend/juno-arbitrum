import type { Transaction } from "@solana/web3.js";

/** What the wallet needs from Privy, so the web build can leave it out. */
export type PrivyBridge = {
  enabled: boolean;
  ready: boolean;
  /** Where sign-in has got to: no session, signed in with the wallet on its way, or usable. */
  status: "loading" | "signed-out" | "creating" | "error" | "ready";
  address: string | null;
  /** Privy's own wallet state, shown while the wallet is on its way. */
  walletStatus: string;
  error: string | null;
  /** Try again to create or reconnect the embedded wallet. */
  retry: () => Promise<void>;
  sendCode: (email: string) => Promise<void>;
  loginWithCode: (code: string, email: string) => Promise<void>;
  signTransaction: (transaction: Transaction) => Promise<Transaction>;
  /** Takes the message as base64 and returns the signature as base64. */
  signMessage: (base64: string) => Promise<string>;
  logout: () => Promise<void>;
};
