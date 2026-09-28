import { useSyncExternalStore } from "react";

/**
 * "Something you did changed the feed — go and look again."
 *
 * The alternative is refetching whenever the social tab gains focus, and on
 * this backend that is the wrong trade: the feed walks every pool against a
 * rate-limited RPC and takes the better part of fifteen seconds, so paying for
 * it on every tab switch would make the app feel broken in exchange for data
 * that almost never changed.
 *
 * So the refetch is tied to the one thing that definitely changed it: this
 * device posting. A counter, bumped on write, read as a dependency.
 */
let revision = 0;
const listeners = new Set<() => void>();

/** Call after a write that the feed should reflect. */
export function feedChanged(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Changes when this device writes something the feed shows. */
export function useFeedRevision(): number {
  return useSyncExternalStore(
    subscribe,
    () => revision,
    () => revision,
  );
}
