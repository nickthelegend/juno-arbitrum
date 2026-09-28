import React from "react";

import type { PrivyBridge } from "./privy.types";

/**
 * The web build has no Privy.
 *
 * `@privy-io/expo` is a React Native SDK with native modules, so the web export
 * keeps the device key it has always had. iOS and Android resolve
 * `privy.native.tsx` instead.
 */

export const PRIVY_ENABLED = false;

export function PrivyRoot({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

const unavailable = () => Promise.reject(new Error("Privy is not available on web"));

const OFF: PrivyBridge = {
  enabled: false,
  ready: true,
  status: "signed-out",
  address: null,
  walletStatus: "off",
  error: null,
  retry: () => Promise.resolve(),
  sendCode: unavailable,
  loginWithCode: unavailable,
  signTransaction: unavailable,
  signMessage: unavailable,
  logout: () => Promise.resolve(),
};

export function usePrivyBridge(): PrivyBridge {
  return OFF;
}
