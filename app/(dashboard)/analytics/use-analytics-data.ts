"use client";

/**
 * Loads the analytics page's data from the REST API (/api/v1/analytics):
 * the chart query, the top lists and the request log, each refetched when
 * its parameters change. Short ranges refresh every 30 seconds while the
 * tab is visible. A failing or malformed answer becomes an error message,
 * never a crash: the previous data stays only when it is for the same
 * parameters (a failed refresh), otherwise it is cleared.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalyticsQueryResult, RequestLogEntry, RequestLogResult, TopResult } from "@/src/lib/analytics";

export const REFRESH_SECONDS = 30;
export const LOG_PAGE_SIZE = 25;
/** Most rows the request log asks for at once (the API's limit). */
const MAX_LOG_LIMIT = 500;

export type Resource<T> = {
  /** The parameters `data` (or `error`) belongs to. */
  key: string | null;
  data: T | null;
  loading: boolean;
  error: string | null;
};

const EMPTY: Resource<never> = { key: null, data: null, loading: false, error: null };

/**
 * GET `url` as JSON. A non-2xx answer throws with the API's `error` text
 * (or the status when it has none: errors from the ClickHouse client can
 * have an empty message).
 */
export async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const reported =
      body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error ?? "").trim() : "";
    throw new Error(reported || `${url.split("?")[0]} answered with status ${response.status}`);
  }
  return body;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isQueryResult(value: unknown): value is AnalyticsQueryResult {
  return (
    isObject(value) &&
    typeof value.status === "string" &&
    isObject(value.range) &&
    typeof value.range.start === "number" &&
    typeof value.range.step === "number" &&
    typeof value.range.buckets === "number" &&
    Array.isArray(value.series) &&
    Array.isArray(value.totals) &&
    isObject(value.previous) &&
    isObject(value.headline) &&
    isObject(value.headlineSeries) &&
    isObject(value.retention)
  );
}

export function isTopResult(value: unknown): value is TopResult {
  return isObject(value) && typeof value.status === "string" && typeof value.total === "number" && Array.isArray(value.dimensions);
}

export function isRequestLog(value: unknown): value is RequestLogResult {
  return isObject(value) && typeof value.status === "string" && Array.isArray(value.requests);
}

const UNEXPECTED = "The analytics API sent an answer this page does not understand";

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Could not load analytics data";
}

/** Fetches `url` whenever `key` or `tick` changes; keeps the data of the same key while refetching. */
function useResource<T>(
  url: string | null,
  key: string,
  tick: number,
  check: (value: unknown) => value is T,
  onLoaded?: () => void
): Resource<T> {
  const [state, setState] = useState<Resource<T>>(() => ({ ...EMPTY, loading: url !== null }));
  const loadedRef = useRef(onLoaded);
  loadedRef.current = onLoaded;
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    setState((current) => ({ ...current, loading: true }));
    fetchJson(url, controller.signal)
      .then((body) => {
        if (!check(body)) throw new Error(UNEXPECTED);
        if (controller.signal.aborted) return;
        setState({ key, data: body, loading: false, error: null });
        loadedRef.current?.();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState((current) => ({ key, data: current.key === key ? current.data : null, loading: false, error: message(error) }));
      });
    return () => controller.abort();
    // `check` is a module-level guard; `url` changes with `key`.
  }, [url, key, tick]);
  return state;
}

export type RequestLogState = Resource<RequestLogEntry[]> & {
  /** More rows may follow the loaded ones. */
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
};

/** The request log: the first page, refreshed in place (as many rows as are shown), and "show more". */
function useRequestLog(listKey: string, enabled: boolean, tick: number): RequestLogState {
  const [rows, setRows] = useState<Resource<RequestLogEntry[]>>(() => ({ ...EMPTY, loading: enabled }));
  const [shown, setShown] = useState(LOG_PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const keyRef = useRef(listKey);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const sameKey = keyRef.current === listKey;
    keyRef.current = listKey;
    const limit = sameKey ? Math.min(MAX_LOG_LIMIT, Math.max(LOG_PAGE_SIZE, shownRef.current)) : LOG_PAGE_SIZE;
    if (!sameKey) setShown(LOG_PAGE_SIZE);
    setRows((current) => ({ ...current, loading: true }));
    fetchJson(`/api/v1/analytics/requests?${listKey}&limit=${limit}`, controller.signal)
      .then((body) => {
        if (!isRequestLog(body)) throw new Error(UNEXPECTED);
        if (controller.signal.aborted) return;
        setRows({ key: listKey, data: body.requests, loading: false, error: null });
        setHasMore(body.requests.length >= limit && limit < MAX_LOG_LIMIT);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setRows((current) => ({ key: listKey, data: current.key === listKey ? current.data : null, loading: false, error: message(error) }));
      });
    return () => controller.abort();
  }, [listKey, enabled, tick]);

  const loadMore = useCallback(() => {
    const offset = rows.data?.length ?? 0;
    if (loadingMore || offset === 0 || offset >= MAX_LOG_LIMIT) return;
    setLoadingMore(true);
    fetchJson(`/api/v1/analytics/requests?${listKey}&limit=${LOG_PAGE_SIZE}&offset=${offset}`)
      .then((body) => {
        if (!isRequestLog(body)) throw new Error(UNEXPECTED);
        if (keyRef.current !== listKey) return;
        setRows((current) => ({ ...current, data: [...(current.data ?? []), ...body.requests] }));
        setShown(offset + body.requests.length);
        setHasMore(body.requests.length >= LOG_PAGE_SIZE && offset + body.requests.length < MAX_LOG_LIMIT);
      })
      .catch((error: unknown) => setRows((current) => ({ ...current, error: message(error) })))
      .finally(() => setLoadingMore(false));
  }, [listKey, loadingMore, rows.data]);

  return { ...rows, hasMore, loadingMore, loadMore };
}

/** Counts up every REFRESH_SECONDS while `live` and the tab is visible; refreshes at once when it becomes visible again after that long. */
function useLiveTick(live: boolean, lastUpdated: number | null): { tick: number; refresh: () => void; paused: boolean } {
  const [tick, setTick] = useState(0);
  const [hidden, setHidden] = useState(false);
  const lastRef = useRef(lastUpdated);
  lastRef.current = lastUpdated;
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    const update = () => setHidden(document.visibilityState === "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    if (!live || hidden) return;
    const stale = lastRef.current !== null && Date.now() - lastRef.current >= REFRESH_SECONDS * 1000;
    if (stale) refresh();
    const timer = window.setInterval(refresh, REFRESH_SECONDS * 1000);
    return () => window.clearInterval(timer);
  }, [live, hidden, refresh]);

  return { tick, refresh, paused: live && hidden };
}

export type AnalyticsData = {
  query: Resource<AnalyticsQueryResult>;
  top: Resource<TopResult>;
  requests: RequestLogState;
  /** When the chart query last answered (ms). */
  lastUpdated: number | null;
  /** Live refresh is on but the tab is hidden. */
  paused: boolean;
  refresh: () => void;
};

/** Dimensions of the top lists, plus the WAF rules for the filter suggestions. */
export const TOP_DIMENSIONS = "host,path,country,asn,status,ip,user_agent,method,protocol,waf_rule";
export const TOP_LIMIT = 6;

export function useAnalyticsData({
  queryKey,
  listKey,
  logKey = listKey,
  enabled,
  live,
}: {
  /** Query string of /query. */
  queryKey: string;
  /** Query string of /top (and of /requests unless `logKey` is given). */
  listKey: string;
  /** Query string of /requests. */
  logKey?: string;
  /** False when analytics is off: nothing is fetched. */
  enabled: boolean;
  /** Refresh every 30 seconds. */
  live: boolean;
}): AnalyticsData {
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const { tick, refresh, paused } = useLiveTick(live, lastUpdated);
  const onLoaded = useCallback(() => setLastUpdated(Date.now()), []);
  const query = useResource(enabled ? `/api/v1/analytics/query?${queryKey}` : null, queryKey, tick, isQueryResult, onLoaded);
  const topKey = `${listKey}&dimensions=${TOP_DIMENSIONS}&limit=${TOP_LIMIT}`;
  const top = useResource(enabled ? `/api/v1/analytics/top?${topKey}` : null, topKey, tick, isTopResult);
  const requests = useRequestLog(logKey, enabled, tick);
  return { query, top, requests, lastUpdated, paused, refresh };
}
