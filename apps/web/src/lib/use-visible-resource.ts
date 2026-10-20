import { useCallback, useEffect, useRef, useState } from "react";

const POLL_MS = 5 * 60_000;
const MIN_GAP_MS = 60_000;

export type VisibleResource<T> = {
  data: T | null;
  error: Error | null;
  refresh: () => Promise<void>;
};

type ResourceState<T> = {
  key: string;
  data: T | null;
  error: Error | null;
};

/** Visible automatic reads are throttled; explicit refreshes invalidate and follow any pending read. */
export function useVisibleResource<T>(
  load: () => Promise<T>,
  { key, event }: { key: string; event?: string },
): VisibleResource<T> {
  const loadRef = useRef(load);
  loadRef.current = load;
  const keyRef = useRef(key);
  keyRef.current = key;
  const controllerRef = useRef<{ key: string; refresh: () => Promise<void> } | null>(null);
  const [state, setState] = useState<ResourceState<T>>({ key, data: null, error: null });

  useEffect(() => {
    let disposed = false;
    let inFlight: Promise<void> | null = null;
    let queued = false;
    let revision = 0;
    let lastStartedAt = -Infinity;
    let visibilityTimer: number | undefined;
    const isCurrent = () => !disposed && keyRef.current === key;

    function request(force: boolean): Promise<void> {
      if (!isCurrent()) return Promise.resolve();
      if (!force) {
        if (document.visibilityState !== "visible" || Date.now() - lastStartedAt < MIN_GAP_MS) {
          return inFlight ?? Promise.resolve();
        }
        if (inFlight) return inFlight;
      } else {
        revision += 1;
        if (inFlight) {
          queued = true;
          return inFlight;
        }
      }

      inFlight = (async () => {
        // Install the shared promise before calling a loader that may throw synchronously.
        await Promise.resolve();
        try {
          do {
            if (!isCurrent()) return;
            queued = false;
            const requestRevision = revision;
            lastStartedAt = Date.now();
            try {
              const data = await loadRef.current();
              if (isCurrent() && requestRevision === revision) {
                setState({ key, data, error: null });
              }
            } catch (error) {
              if (isCurrent() && requestRevision === revision) {
                setState((previous) => ({
                  key,
                  data: previous.key === key ? previous.data : null,
                  error: error instanceof Error ? error : new Error(String(error)),
                }));
              }
            }
          } while (queued && isCurrent());
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    }

    const controller = { key, refresh: () => request(true) };
    controllerRef.current = controller;
    setState({ key, data: null, error: null });
    void request(false);

    const onVisible = () => {
      window.clearTimeout(visibilityTimer);
      if (document.visibilityState !== "visible") return;
      visibilityTimer = window.setTimeout(() => void request(false), 50);
    };
    const onEvent = () => void request(true);
    const onStorage = (change: StorageEvent) => {
      if (change.key === event) void request(true);
    };
    const poll = window.setInterval(() => void request(false), POLL_MS);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    if (event) {
      window.addEventListener(event, onEvent);
      window.addEventListener("storage", onStorage);
    }
    return () => {
      disposed = true;
      if (controllerRef.current === controller) controllerRef.current = null;
      window.clearInterval(poll);
      window.clearTimeout(visibilityTimer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
      if (event) {
        window.removeEventListener(event, onEvent);
        window.removeEventListener("storage", onStorage);
      }
    };
  }, [key, event]);

  const refresh = useCallback(() => {
    const controller = controllerRef.current;
    return controller?.key === key && keyRef.current === key
      ? controller.refresh()
      : Promise.resolve();
  }, [key]);

  return {
    data: state.key === key ? state.data : null,
    error: state.key === key ? state.error : null,
    refresh,
  };
}
