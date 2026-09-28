import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError } from "./api";

/**
 * One async read, with the three states a screen actually has to draw.
 *
 * Deliberately not react-query. This app makes a handful of calls from a
 * handful of screens, and a cache library would be more configuration than the
 * problem has — while still leaving the same three states to render.
 *
 * `refreshing` is separate from `loading` because they mean different things on
 * screen. A first load has nothing to show and gets a skeleton; a pull to
 * refresh already has content, and replacing it with a skeleton throws away
 * what the user was reading and makes the app feel like it lost its place.
 */
export type AsyncState<T> = {
  data: T | null;
  error: string | null;
  /**
   * The HTTP status behind `error`, when there was one. A 404 is "this does
   * not exist" and wants a way out, not a Try again that can never work.
   */
  errorStatus: number | null;
  loading: boolean;
  refreshing: boolean;
  refresh: () => void;
};

export function useApi<T>(
  load: () => Promise<T>,
  deps: React.DependencyList = [],
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // A screen that unmounts mid-request must not set state afterwards, and a
  // slow first response must not overwrite a newer one.
  const generation = useRef(0);

  const run = useCallback(
    async (isRefresh: boolean) => {
      const mine = ++generation.current;
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      setErrorStatus(null);

      try {
        const result = await load();
        if (generation.current !== mine) return;
        setData(result);
      } catch (caught) {
        if (generation.current !== mine) return;
        setErrorStatus(caught instanceof ApiError && caught.status > 0 ? caught.status : null);
        setError(
          caught instanceof ApiError
            ? caught.message
            : caught instanceof Error
              ? caught.message
              : "Something went wrong",
        );
      } finally {
        if (generation.current === mine) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    deps,
  );

  useEffect(() => {
    run(false);
    return () => {
      // Invalidate anything in flight.
      generation.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, errorStatus, loading, refreshing, refresh: () => run(true) };
}

/*
 * Re-exported so every call site keeps working.
 *
 * The formatters themselves live in `./format`, which imports nothing — see
 * the note there.
 */
export { money, since, tokens } from "./format";
