import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Share } from "react-native";

import { API_URL, juno, type Coin } from "./api";
import { coinLink } from "./markets";
import { useWallet } from "./wallet";

/**
 * A like, held optimistically.
 *
 * The heart fills the instant it is tapped and the write follows. If the write
 * fails the heart goes back — a like that looks recorded and is not is the
 * one outcome worse than a slow heart.
 *
 * `like()` only ever likes; `toggle()` goes both ways. A double tap on a reel
 * must never *unlike* something you already liked, which is exactly what a
 * toggle would do on the second double tap.
 */
export function useLike(coin: Pick<Coin, "address" | "likes" | "viewerLiked">) {
  const wallet = useWallet();
  const [liked, setLiked] = useState(!!coin.viewerLiked);
  const [likes, setLikes] = useState<number | null>(coin.likes ?? null);
  const inFlight = useRef(false);

  // The list re-reads on refresh; the server's answer wins over a stale local one.
  useEffect(() => {
    setLiked(!!coin.viewerLiked);
    setLikes(coin.likes ?? null);
  }, [coin.address, coin.likes, coin.viewerLiked]);

  const write = useCallback(
    async (next: boolean) => {
      if (inFlight.current) return;
      inFlight.current = true;
      const before = { liked, likes };
      setLiked(next);
      setLikes((n) => (n === null ? (next ? 1 : null) : Math.max(0, n + (next ? 1 : -1))));
      try {
        const address = wallet.address ?? (await wallet.connect());
        const result = await juno.setLike({ coin: coin.address, wallet: address, like: next });
        setLikes(result.likes);
        setLiked(result.liked);
      } catch {
        setLiked(before.liked);
        setLikes(before.likes);
      } finally {
        inFlight.current = false;
      }
    },
    [coin.address, liked, likes, wallet],
  );

  return {
    liked,
    likes,
    like: () => (liked ? undefined : void write(true)),
    toggle: () => void write(!liked),
  };
}

/**
 * Following a creator, read once a wallet exists.
 *
 * Starts unknown rather than "not following": offering Follow to someone who
 * already follows invites a tap that does nothing visible. Hidden entirely on
 * your own posts.
 */
/**
 * One follow read per creator, however many cards show them.
 *
 * Each card asked on its own, so a feed with five posts by one creator made
 * five identical requests on every load. Reads are shared for thirty seconds
 * and a toggle replaces the shared answer with the new one.
 */
const followReads = new Map<string, { at: number; value: Promise<boolean> }>();

function readFollow(target: string, viewer: string): Promise<boolean> {
  const key = `${viewer}>${target}`;
  const hit = followReads.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.value;
  const value = juno.followStats(target, viewer).then((stats) => stats.viewerFollows ?? false);
  followReads.set(key, { at: Date.now(), value });
  value.catch(() => followReads.delete(key));
  return value;
}

/** Every mounted follow control, by creator, so one toggle updates all of them. */
const followListeners = new Map<string, Set<(on: boolean) => void>>();

function announceFollow(target: string, on: boolean) {
  followListeners.get(target)?.forEach((listener) => listener(on));
}

export function useFollow(target: string) {
  const wallet = useWallet();
  const [following, setFollowing] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const self = wallet.address === target;

  useEffect(() => {
    const listeners = followListeners.get(target) ?? new Set();
    listeners.add(setFollowing);
    followListeners.set(target, listeners);
    return () => {
      listeners.delete(setFollowing);
    };
  }, [target]);

  useEffect(() => {
    let live = true;
    if (!wallet.address || self) {
      setFollowing(wallet.address ? null : false);
      return;
    }
    readFollow(target, wallet.address)
      .then((follows) => {
        if (live) setFollowing(follows);
      })
      .catch(() => {
        if (live) setFollowing(false);
      });
    return () => {
      live = false;
    };
  }, [target, wallet.address, self]);

  const toggle = useCallback(async () => {
    if (busy || self) return;
    setBusy(true);
    const next = !following;
    announceFollow(target, next);
    try {
      const address = wallet.address ?? (await wallet.connect());
      const result = await juno.setFollow(address, target, next);
      setFollowing(result.isFollowing);
      followReads.set(`${address}>${target}`, { at: Date.now(), value: Promise.resolve(result.isFollowing) });
      announceFollow(target, result.isFollowing);
    } catch {
      announceFollow(target, !next);
    } finally {
      setBusy(false);
    }
  }, [busy, following, self, target, wallet]);

  return { following, self, toggle };
}

/**
 * Where a shared link should open: the Juno app, not its API.
 *
 * Links used to point at the API host, which serves no Juno pages of its own.
 * `EXPO_PUBLIC_APP_URL` names the app; in a browser the page's own origin is
 * already the app. The API host is the last resort and redirects to the app.
 */
function appUrl(): string {
  const configured = process.env.EXPO_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (configured) return configured;
  if (Platform.OS === "web" && typeof window !== "undefined") return window.location.origin;
  return API_URL;
}

/**
 * Share a coin: the system sheet on a phone, the clipboard where there is none.
 *
 * Resolves to what happened so the caller can say "Link copied" — a share
 * button that silently copies looks like it did nothing.
 */
export async function shareCoin(
  coin: Pick<Coin, "address" | "name" | "symbol">,
): Promise<"shared" | "copied" | "cancelled" | "failed"> {
  const url = coinLink(appUrl(), coin);
  const message = `${coin.name} — $${coin.symbol} is live on Juno. Every post is a market.`;
  try {
    if (Platform.OS === "web") {
      const nav = globalThis.navigator as Navigator | undefined;
      if (nav?.share) {
        try {
          await nav.share({ title: coin.name, text: message, url });
          return "shared";
        } catch (error) {
          // Closing the share sheet is a choice, not a failure — copying the
          // link anyway and announcing it would be doing something unasked.
          if (error instanceof Error && error.name === "AbortError") return "cancelled";
          throw error;
        }
      }
      await Clipboard.setStringAsync(url);
      return "copied";
    }
    await Share.share(Platform.OS === "ios" ? { message, url } : { message: `${message}\n${url}` });
    return "shared";
  } catch {
    try {
      await Clipboard.setStringAsync(url);
      return "copied";
    } catch {
      return "failed";
    }
  }
}

/**
 * The viewer to ask the server about, fixed for the life of a list.
 *
 * Lists pass `viewer` so each heart arrives already filled or not. But the
 * wallet's address changes the first time someone likes anything — that is
 * when the device key is created — and a list keyed on the address would
 * then re-read every pool from chain, which is a minute on the public RPC,
 * to learn something the optimistic heart already shows.
 *
 * So the list waits for the wallet to finish restoring (`ready`), reads with
 * whatever address exists then, and ignores later changes.
 */
export function useViewerOnce(): { ready: boolean; viewer: () => string | null } {
  const wallet = useWallet();
  const address = useRef(wallet.address);
  address.current = wallet.address;
  return { ready: wallet.ready, viewer: () => address.current };
}
