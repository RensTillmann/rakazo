import { describe, expect, it } from "vitest";
import {
  answerableAskMessageIds,
  latestAnswerableAskMessageId,
  resolveAskChoice,
  selectedAskActionLabel,
  summarizeOpenAsk,
} from "./answerable-ask.js";

describe("latestAnswerableAskMessageId", () => {
  it("finds a waiting prompt even when a newer group run is active", () => {
    expect(
      latestAnswerableAskMessageId({
        run: { id: "run-newer", status: "running" },
        activeRuns: [
          { id: "run-newer", status: "running" },
          { id: "run-waiting", status: "waiting_input" },
        ],
        messages: [
          {
            id: "ask-1",
            runId: "run-waiting",
            blocks: [{ kind: "ask", status: "pending" }],
          },
        ],
      }),
    ).toBe("ask-1");
  });

  it("ignores answered prompts and prompts from non-waiting runs", () => {
    expect(
      latestAnswerableAskMessageId({
        run: { id: "run-1", status: "running" },
        messages: [{ id: "ask-1", runId: "run-1", blocks: [{ kind: "ask", status: "pending" }] }],
      }),
    ).toBeNull();
    expect(
      latestAnswerableAskMessageId({
        run: { id: "run-1", status: "waiting_input" },
        messages: [{ id: "ask-1", runId: "run-1", blocks: [{ kind: "ask", status: "answered" }] }],
      }),
    ).toBeNull();
  });
});

describe("answerableAskMessageIds", () => {
  it("returns every pending card of every waiting run, not only the newest", () => {
    const ids = answerableAskMessageIds({
      activeRuns: [
        { id: "run-a", status: "waiting_input" },
        { id: "run-b", status: "waiting_input" },
        { id: "run-c", status: "running" },
      ],
      messages: [
        { id: "ask-a", runId: "run-a", blocks: [{ kind: "ask", status: "pending" }] },
        { id: "ask-b", runId: "run-b", blocks: [{ kind: "ask", status: "pending" }] },
        { id: "ask-b-old", runId: "run-b", blocks: [{ kind: "ask", status: "answered" }] },
        { id: "ask-c", runId: "run-c", blocks: [{ kind: "ask", status: "pending" }] },
        { id: "text", runId: "run-a", blocks: [{ kind: "text" }] },
      ],
    });
    expect([...ids]).toEqual(["ask-a", "ask-b"]);
  });

  it("is empty without a snapshot", () => {
    expect(answerableAskMessageIds(null).size).toBe(0);
  });
});

describe("selectedAskActionLabel", () => {
  it("maps a choice answer id to its user-facing label", () => {
    expect(
      selectedAskActionLabel("choice-2", [
        { id: "choice-1", label: "Berlin" },
        { id: "choice-2", label: "Seoul" },
      ]),
    ).toBe("Seoul");
  });

  it("falls back to the answer when an action is unavailable", () => {
    expect(selectedAskActionLabel("custom", undefined)).toBe("custom");
  });
});

describe("resolveAskChoice", () => {
  const actions = [
    { id: "choice-1", label: "Berlin" },
    { id: "choice-2", label: "Seoul" },
  ];

  it("matches an offered choice by id or label", () => {
    expect(resolveAskChoice("choice-2", actions)).toEqual({ id: "choice-2", label: "Seoul" });
    expect(resolveAskChoice(" seoul ", actions)).toEqual({ id: "choice-2", label: "Seoul" });
  });

  it("leaves unmatched free-text as a custom answer", () => {
    expect(resolveAskChoice("Toronto", actions)).toBeUndefined();
  });
});

describe("summarizeOpenAsk", () => {
  it("summarises a pending question card that composer text would answer", () => {
    const long = `Reply to Andreas Balodimos (#3536)?\n${"x".repeat(200)}`;
    const summary = summarizeOpenAsk({
      id: "m1",
      botId: "josy",
      blocks: [{ kind: "ask", text: long, status: "pending" }],
    });
    expect(summary).toMatchObject({ messageId: "m1", botId: "josy", answersWithText: true });
    expect(summary?.question.startsWith("Reply to Andreas Balodimos (#3536)? x")).toBe(true);
    expect(summary?.question.length).toBe(100);
  });

  it("marks approval cards as not answered by composer text", () => {
    expect(
      summarizeOpenAsk({
        id: "m2",
        blocks: [
          {
            kind: "ask",
            text: "Run the deploy?",
            approvalEffectId: "e1",
            actions: [
              { id: "allow", label: "Allow" },
              { id: "deny", label: "Deny" },
            ],
          },
        ],
      })?.answersWithText,
    ).toBe(false);
  });

  it("returns null without a pending ask", () => {
    expect(summarizeOpenAsk(null)).toBeNull();
    expect(
      summarizeOpenAsk({ id: "m3", blocks: [{ kind: "ask", text: "Q", status: "answered" }] }),
    ).toBeNull();
  });
});
