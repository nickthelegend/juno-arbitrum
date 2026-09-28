/** One transaction for the wallet to send, as the server built it. */
export type TxRequest = {
  to: `0x${string}`;
  data: `0x${string}`;
  /** Wei. */
  value: bigint;
  chainId: number;
  /** Gas limit the server padded (estimate x 1.3); estimates alone run short on graduation. */
  gas?: bigint;
};

/**
 * What the wallet needs from Privy, the same on iOS, Android and web.
 *
 * `privy.native.tsx` implements it with `@privy-io/expo` and
 * `privy.web.tsx` with `@privy-io/react-auth`; nothing outside those two
 * files knows which SDK is underneath.
 */
export type PrivyBridge = {
  enabled: boolean;
  ready: boolean;
  /** Where sign-in has got to: no session, signed in with the wallet on its way, or usable. */
  status: "loading" | "signed-out" | "creating" | "error" | "ready";
  /** The EVM address, lowercase. */
  address: string | null;
  /** Privy's own wallet state, shown while the wallet is on its way. */
  walletStatus: string;
  error: string | null;
  /** Try again to create or reconnect the embedded wallet. */
  retry: () => Promise<void>;
  sendCode: (email: string) => Promise<void>;
  loginWithCode: (code: string, email: string) => Promise<void>;
  /**
   * Privy's own sign-in modal, where it exists (web): email plus browser
   * wallets such as MetaMask. Undefined on iOS and Android.
   */
  openModal?: () => void;
  /** `eth_sendTransaction` on the given chain. Resolves with the hash once broadcast. */
  sendTransaction: (tx: TxRequest) => Promise<`0x${string}`>;
  /** EIP-191 `personal_sign` over UTF-8 text. Returns the 0x signature. */
  signMessage: (text: string) => Promise<`0x${string}`>;
  /** Put the wallet on `chainId`. A no-op when it is already there. */
  switchChain: (chainId: number) => Promise<void>;
  logout: () => Promise<void>;
};
