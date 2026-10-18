// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../lib/rpc";
import { ArtifactFileCard } from "./ArtifactFileCard";

vi.mock("../lib/rpc", () => ({ rpc: { artifacts: { get: vi.fn() } } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: unknown }) => children,
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values),
  }),
}));

const target = { botId: "bot-1" };
let container: HTMLDivElement;
let root: Root;
let intersect: (() => void) | undefined;

class FakeIntersectionObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe() {
    intersect = () =>
      this.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
  }
  disconnect() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  intersect = undefined;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:recording");
  vi.spyOn(URL, "revokeObjectURL").mockReturnValue(undefined);
  vi.mocked(rpc.artifacts.get).mockResolvedValue({
    contentBase64: "AA==",
    mimeType: "video/webm",
  } as never);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function render(mimeType: string, name: string) {
  act(() =>
    root.render(
      <ArtifactFileCard
        target={target}
        artifactId="artifact-1"
        name={name}
        mimeType={mimeType}
        size={3_500_000}
      />,
    ),
  );
}

it("plays a video file block inline once it scrolls into view", async () => {
  render("video/webm", "login-flow.webm");
  expect(rpc.artifacts.get).not.toHaveBeenCalled();
  expect(container.querySelector("video")).toBeNull();
  expect(container.textContent).toContain("login-flow.webm");

  await act(async () => intersect?.());

  expect(rpc.artifacts.get).toHaveBeenCalledWith({ botId: "bot-1", artifactId: "artifact-1" });
  const video = container.querySelector("video");
  expect(video?.getAttribute("src")).toBe("blob:recording");
  expect(video?.hasAttribute("controls")).toBe(true);
  expect(video?.hasAttribute("playsinline")).toBe(true);
  expect(video?.getAttribute("preload")).toBe("metadata");
  expect(container.querySelector('button[aria-label="Download login-flow.webm"]')).not.toBeNull();
});

it("plays a recording stored with a generic type by its file name", async () => {
  render("application/octet-stream", "screen.mp4");
  await act(async () => intersect?.());
  expect(container.querySelector("video")?.getAttribute("src")).toBe("blob:recording");
});

it("keeps the download chip for a file that is not a video", async () => {
  render("text/plain", "notes.txt");
  await act(async () => intersect?.());
  expect(container.querySelector("video")).toBeNull();
  const chip = container.querySelector("button");
  expect(chip?.textContent).toContain("notes.txt");
  expect(chip?.textContent).toContain("text/plain");
  expect(rpc.artifacts.get).not.toHaveBeenCalled();
});
