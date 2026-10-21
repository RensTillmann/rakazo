// @vitest-environment jsdom
import type { ApprovalReview } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

const { english, clients } = vi.hoisted(() => ({
  english: (strings: TemplateStringsArray, ...values: unknown[]) =>
    String.raw({ raw: strings }, ...values),
  clients: { current: { approvals: { review: vi.fn() } } },
}));
vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: english }) }));
vi.mock("../lib/space-rpc", () => ({ useSpaceRpc: () => clients.current }));

import { ReplyReview, useApprovalReview } from "./ReplyReview";

const proposedReply = `First line\n\n${"Full response. ".repeat(400)}<script>alert(1)</script>FINAL Ω`;
const review: ApprovalReview = {
  ticket: "42",
  proposedReply,
  status: "pending",
  tags: [],
  cardVersion: "10",
  customerContext: { status: "unavailable" },
};

describe("reply review", () => {
  it("shows the Fleet's full inquiry, the newest version and stale state", async () => {
    const inquiry = `Zendesk #3529: Form\n\n[#98100 · first inquiry · customer · Customer A · 2026-10-20]\n${"Long text. ".repeat(500)}END Ω`;
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () =>
      root.render(
        <ReplyReview
          review={{
            ...review,
            ticket: "3529",
            cardVersion: "98100",
            customerContext: {
              status: "available",
              stale: true,
              ticket: "3529",
              subject: "Form",
              source: { ref: "zendesk:3529", version: "98123" },
              firstInquiry: "98100",
              thread: [],
              inquiry,
              bounded: false,
            },
          }}
          retry={() => {}}
        />,
      ),
    );
    expect(host.querySelector('[data-testid="reply-review-inquiry"]')?.textContent).toBe(inquiry);
    // Stale is said in plain words; comment ids are bookkeeping, never shown beside it.
    const outside = [
      host.querySelector('[role="status"]')?.textContent ?? "",
      host.querySelector("details")?.textContent ?? "",
    ].join(" ");
    expect(host.querySelector('[role="status"]')?.textContent).toBeTruthy();
    expect(outside).not.toMatch(/98100|98123/);
    await act(async () => root.unmount());
  });

  it("retains the proposal's exact whitespace and final characters without interpreting customer-controlled HTML", async () => {
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<ReplyReview review={review} retry={() => {}} />));
    expect(host.querySelector('[aria-label="Proposed reply"] > div')?.textContent).toBe(
      proposedReply,
    );
    expect(host.querySelector("script")).toBeNull();
    await act(async () => root.unmount());
  });

  it("discards a previous card's late response and retains the complete proposal after a failed retry", async () => {
    let resolveOld!: (value: ApprovalReview) => void;
    const oldRequest = new Promise<ApprovalReview>((resolve) => {
      resolveOld = resolve;
    });
    clients.current = {
      approvals: {
        review: vi
          .fn()
          .mockImplementationOnce(() => oldRequest)
          .mockResolvedValueOnce(review)
          .mockRejectedValueOnce(new Error("offline")),
      },
    };
    let retry!: () => void;
    function Harness({ effectId }: { effectId: string }) {
      const state = useApprovalReview(effectId);
      retry = state.retry;
      return <div>{state.review?.proposedReply}</div>;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<Harness effectId="old" />));
    await act(async () => root.render(<Harness effectId="new" />));
    await act(async () => resolveOld({ ...review, proposedReply: "wrong card" }));
    expect(host.textContent).toBe(proposedReply);
    await act(async () => retry());
    expect(host.textContent).toBe(proposedReply);
    await act(async () => root.unmount());
  });

  it("does not expose another Space client's response and tracks the replacement read", async () => {
    let resolveOld!: (value: ApprovalReview) => void;
    let resolveCurrent!: (value: ApprovalReview) => void;
    const oldRequest = new Promise<ApprovalReview>((resolve) => {
      resolveOld = resolve;
    });
    const currentRequest = new Promise<ApprovalReview>((resolve) => {
      resolveCurrent = resolve;
    });
    clients.current = { approvals: { review: vi.fn(() => oldRequest) } };
    function Harness() {
      const state = useApprovalReview("same-effect");
      return <div aria-busy={state.loading}>{state.review?.proposedReply}</div>;
    }
    const host = document.createElement("div");
    const root = createRoot(host);
    await act(async () => root.render(<Harness />));
    expect(host.firstElementChild?.getAttribute("aria-busy")).toBe("true");
    clients.current = { approvals: { review: vi.fn(() => currentRequest) } };
    await act(async () => root.render(<Harness />));
    await act(async () => resolveOld({ ...review, proposedReply: "Other Space proposal" }));
    expect(host.textContent).toBe("");
    expect(host.firstElementChild?.getAttribute("aria-busy")).toBe("true");
    await act(async () => resolveCurrent(review));
    expect(host.textContent).toBe(proposedReply);
    expect(host.firstElementChild?.getAttribute("aria-busy")).toBe("false");
    await act(async () => root.unmount());
  });
});
