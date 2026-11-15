"use client";

/**
 * A small read cache for the API: one entry per key, shared by every component that asks for it, refreshed when the
 * live feed says something changed (`invalidate`). Enough for this app; no data library needed.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";

type Entry = { data?: unknown; error?: Error; loading: boolean; loaded: boolean; fetcher: () => Promise<unknown>; version: number };
const cache = new Map<string, Entry>();
const subs = new Map<string, Set<() => void>>();

function notify(key: string) {
  const e = cache.get(key);
  if (e) e.version++;
  for (const f of subs.get(key) ?? []) f();
}

function load(key: string) {
  const e = cache.get(key);
  if (!e) return;
  e.loading = true;
  notify(key);
  e.fetcher()
    .then((d) => {
      e.data = d;
      e.error = undefined;
    })
    .catch((err: Error) => {
      e.error = err;
    })
    .finally(() => {
      e.loading = false;
      e.loaded = true;
      notify(key);
    });
}

/** Read `key` with `fetcher`; loads once, then stays until invalidated. */
export function useData<T>(key: string | null, fetcher: () => Promise<T>) {
  const subscribe = useCallback(
    (cb: () => void) => {
      if (!key) return () => {};
      const set = subs.get(key) ?? new Set();
      set.add(cb);
      subs.set(key, set);
      return () => set.delete(cb);
    },
    [key],
  );
  useSyncExternalStore(
    subscribe,
    () => (key ? (cache.get(key)?.version ?? -1) : -1),
    () => -1,
  );
  useEffect(() => {
    if (!key) return;
    const e = cache.get(key);
    if (e) {
      e.fetcher = fetcher;
      return;
    }
    cache.set(key, { loading: false, loaded: false, fetcher, version: 0 });
    load(key);
  }, [key, fetcher]);
  const e = key ? cache.get(key) : undefined;
  return {
    data: e?.data as T | undefined,
    error: e?.error,
    /** nothing to show yet (a refresh keeps the old data on screen) */
    loading: !!key && (!e || (!e.loaded && e.data === undefined)),
    refreshing: !!e?.loading,
    reload: () => key && load(key),
  };
}

/** Fetch again every entry whose key starts with `prefix` (the ones on screen now; the rest on their next use). */
export function invalidate(...prefixes: string[]) {
  for (const key of [...cache.keys()]) {
    if (!prefixes.some((p) => key.startsWith(p))) continue;
    if (subs.get(key)?.size) load(key);
    else cache.delete(key);
  }
}

/** Change what an entry holds right away (an optimistic update); the next load replaces it. */
export function setData<T>(key: string, update: (cur: T | undefined) => T) {
  const e = cache.get(key);
  if (!e) return;
  e.data = update(e.data as T | undefined);
  notify(key);
}

/** Forget everything (after signing in, so nothing from another wallet's session shows). */
export function clearData() {
  cache.clear();
}
