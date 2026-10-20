// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MODEL_SETTINGS_CHANGED_EVENT, notifyModelSettingsChanged } from "./model-settings-events";
import type { VisibleResource } from "./use-visible-resource";
import { useVisibleResource } from "./use-visible-resource";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;
let visibility: DocumentVisibilityState;
let resource: VisibleResource<string>;
let renders: Array<{ key: string; data: string | null }>;

type ProbeProps = {
  scope: string;
  load: () => Promise<string>;
  event?: string;
};

function Probe({ scope, load, ...options }: ProbeProps) {
  resource = useVisibleResource(() => load(), { key: scope, ...options });
  renders.push({ key: scope, data: resource.data });
  return <output>{resource.error?.message ?? resource.data ?? "unavailable"}</output>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  renders = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("clears the previous scope before rendering and ignores its late response", async () => {
  const oldRefresh = deferred<string>();
  const nextScope = deferred<string>();
  const loadOld = vi.fn().mockResolvedValueOnce("old scope").mockReturnValue(oldRefresh.promise);
  await act(async () => root.render(<Probe scope="old" load={loadOld} />));
  expect(resource.data).toBe("old scope");

  await act(async () => {
    void resource.refresh();
  });
  act(() => root.render(<Probe scope="new" load={() => nextScope.promise} />));
  expect(
    renders.filter((render) => render.key === "new").every((render) => render.data === null),
  ).toBe(true);
  expect(container.textContent).toBe("unavailable");

  await act(async () => nextScope.resolve("new scope"));
  await act(async () => oldRefresh.resolve("outdated scope"));
  expect(resource.data).toBe("new scope");
  expect(resource.error).toBeNull();
});

it("serializes forced refreshes and never publishes a response invalidated by a newer refresh", async () => {
  const outdated = deferred<string>();
  const latest = deferred<string>();
  const load = vi.fn().mockReturnValueOnce(outdated.promise).mockReturnValueOnce(latest.promise);
  await act(async () => root.render(<Probe scope="chat" load={load} />));
  let refreshed!: Promise<void>;
  await act(async () => {
    refreshed = resource.refresh();
    void resource.refresh();
  });
  expect(load).toHaveBeenCalledOnce();

  await act(async () => outdated.resolve("before save"));
  expect(resource.data).toBeNull();
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => {
    latest.resolve("after save");
    await refreshed;
  });
  expect(resource.data).toBe("after save");
});

it("skips hidden polls, coalesces visible-return events, and observes the minimum refresh gap", async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce("initial")
    .mockResolvedValueOnce("returned")
    .mockResolvedValue("fresh");
  await act(async () => root.render(<Probe scope="chat" load={load} />));
  await act(async () => {
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
  });
  expect(load).toHaveBeenCalledOnce();
  expect(resource.data).toBe("initial");

  await act(async () => {
    visibility = "visible";
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(load).toHaveBeenCalledTimes(2);
  expect(resource.data).toBe("returned");

  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(load).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(load).toHaveBeenCalledTimes(3);
  expect(resource.data).toBe("fresh");
});

it("refreshes immediately for same-window saves and only its own cross-window storage signal", async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce("initial")
    .mockResolvedValueOnce("saved")
    .mockResolvedValueOnce("other window");
  await act(async () =>
    root.render(<Probe scope="models" load={load} event={MODEL_SETTINGS_CHANGED_EVENT} />),
  );
  await act(async () => {
    window.dispatchEvent(new StorageEvent("storage", { key: "unrelated", newValue: "changed" }));
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
  });
  expect(load).toHaveBeenCalledOnce();

  await act(async () => notifyModelSettingsChanged());
  expect(resource.data).toBe("saved");
  await act(async () => {
    window.dispatchEvent(
      new StorageEvent("storage", { key: MODEL_SETTINGS_CHANGED_EVENT, newValue: "opaque signal" }),
    );
  });
  expect(resource.data).toBe("other window");
});

it("keeps the last good value on failure and clears the error after an explicit retry", async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce("known value")
    .mockRejectedValueOnce(new Error("temporarily unavailable"))
    .mockResolvedValueOnce("recovered");
  await act(async () => root.render(<Probe scope="chat" load={load} />));
  await act(async () => resource.refresh());
  expect(resource.data).toBe("known value");
  expect(resource.error?.message).toBe("temporarily unavailable");
  await act(async () => resource.refresh());
  expect(resource.data).toBe("recovered");
  expect(resource.error).toBeNull();
});

it("discards late failures and queued refreshes after unmount and removes automatic listeners", async () => {
  const pending = deferred<string>();
  const load = vi.fn(() => pending.promise);
  await act(async () =>
    root.render(<Probe scope="chat" load={load} event={MODEL_SETTINGS_CHANGED_EVENT} />),
  );
  const refresh = resource.refresh;
  await act(async () => {
    void resource.refresh();
    window.dispatchEvent(new Event("focus"));
  });
  act(() => root.render(null));
  await act(async () => {
    pending.reject(new Error("late failure"));
    await refresh();
    notifyModelSettingsChanged();
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(
      new StorageEvent("storage", { key: MODEL_SETTINGS_CHANGED_EVENT, newValue: "changed" }),
    );
    await vi.advanceTimersByTimeAsync(10 * 60_000);
  });
  expect(load).toHaveBeenCalledOnce();
  expect(container.textContent).toBe("");
});

it("does not subscribe to model change signals unless an event is requested", async () => {
  const load = vi.fn().mockResolvedValue("initial");
  await act(async () => root.render(<Probe scope="chat" load={load} />));
  await act(async () => {
    notifyModelSettingsChanged();
    window.dispatchEvent(
      new StorageEvent("storage", { key: MODEL_SETTINGS_CHANGED_EVENT, newValue: "changed" }),
    );
  });
  expect(load).toHaveBeenCalledOnce();
});

it("still invalidates the same window when browser storage is blocked", async () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage is blocked");
  });
  const load = vi.fn().mockResolvedValueOnce("initial").mockResolvedValueOnce("saved");
  await act(async () =>
    root.render(<Probe scope="models" load={load} event={MODEL_SETTINGS_CHANGED_EVENT} />),
  );
  await act(async () => notifyModelSettingsChanged());
  expect(resource.data).toBe("saved");
});

it("shares a pending read across focus and visibility events without refetching for inline callbacks", async () => {
  const pending = deferred<string>();
  const firstLoad = vi.fn(() => pending.promise);
  const latestLoad = vi.fn().mockResolvedValue("latest loader");
  await act(async () => root.render(<Probe scope="chat" load={firstLoad} />));
  await act(async () => root.render(<Probe scope="chat" load={latestLoad} />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(50);
  });
  expect(firstLoad).toHaveBeenCalledOnce();
  expect(latestLoad).not.toHaveBeenCalled();
  await act(async () => pending.resolve("pending result"));
  expect(resource.data).toBe("pending result");
  await act(async () => resource.refresh());
  expect(resource.data).toBe("latest loader");
});
