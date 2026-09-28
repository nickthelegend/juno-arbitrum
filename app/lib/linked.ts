import { useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";

/**
 * A selection that a link can set, and a tap can then change.
 *
 * Seeding `useState` from a route param only works the first time the screen
 * mounts. Every tab in this app is a persistent route: opening
 * `profile?tab=plans` on a profile that is already mounted changes the param
 * and nothing else, so the link silently lands on whatever was selected last —
 * which is exactly the failure a deep link is supposed to remove.
 *
 * So the param is also watched. It is applied when it *changes* to a new valid
 * value, never on every render: re-applying it on each pass would fight the
 * person tapping a different tab, snapping them back to the linked one. The
 * last value we acted on is remembered rather than compared against the
 * selection, because tapping back to the linked tab and then away again has to
 * keep working.
 */
export function useLinkedState<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const params = useLocalSearchParams() as Record<string, string | string[] | undefined>;
  // expo-router hands back an array when a key appears twice in the URL.
  const raw = params[key];
  const asked = Array.isArray(raw) ? raw[0] : raw;
  const linked = allowed.includes(asked as T) ? (asked as T) : null;

  const [value, setValue] = useState<T>(linked ?? fallback);
  const applied = useRef<T | null>(linked);

  useEffect(() => {
    if (linked === null || linked === applied.current) return;
    applied.current = linked;
    setValue(linked);
  }, [linked]);

  return [value, setValue];
}
