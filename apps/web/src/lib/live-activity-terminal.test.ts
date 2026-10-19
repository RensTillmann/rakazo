import type { ProductEvent } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  activityStatusLine,
  publishActivityEvent,
  renderActivityLines,
  subscribeActivityEvents,
} from "./live-activity-terminal";

let seq = 0;
function event(type: string, payload: Record<string, unknown>, second = seq): ProductEvent {
  seq += 1;
  return {
    id: `event-${seq}`,
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    seq,
    type: type as ProductEvent["type"],
    runId: "run-1",
    createdAt: new Date(Date.UTC(2026, 9, 19, 8, 0, second)).toISOString(),
    payload,
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes.
const plain = (lines: string[]) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

describe("renderActivityLines", () => {
  const preview = Array.from({ length: 25 }, (_, index) => `mail ${index + 1}`).join("\n");
  const events = [
    event("run.started", {}, 0),
    event("thread.progress", { delta: "Checking your ", streaming: true }, 1),
    event("thread.progress", { delta: "inbox.", streaming: true }, 2),
    event(
      "thread.message.created",
      { messageId: "m1", blocks: [{ kind: "thinking", text: "Need the newest mail." }] },
      3,
    ),
    event(
      "agent.tool.called",
      { name: "GMAIL_FETCH_EMAILS", executionId: "call-1", argsPreview: '{"max_results":50}' },
      4,
    ),
    event(
      "agent.tool.completed",
      {
        name: "GMAIL_FETCH_EMAILS",
        executionId: "call-1",
        outcome: "succeeded",
        durationMs: 2300,
        resultChars: 89_404,
        shownChars: 12_000,
        clipped: true,
        resultPreview: preview,
        modelCalls: 2,
      },
      7,
    ),
    event(
      "thread.message.created",
      {
        messageId: "m2",
        blocks: [{ kind: "bot_message_sent", toBotId: "bot-2", toBotName: "Planner", text: "Done" }],
      },
      8,
    ),
    event(
      "thread.message.created",
      {
        messageId: "m3",
        blocks: [
          {
            kind: "bot_message_received",
            fromBotId: "bot-2",
            fromBotName: "Planner",
            text: "Thanks",
            hop: 2,
          },
        ],
      },
      9,
    ),
    event("thread.ask", { text: "Send the reply?" }, 10),
    event("run.completed", {}, 70),
  ];

  it("renders a Pi-style run with tool blocks, the cut-off warning and the finish line", () => {
    const raw = renderActivityLines(events, {
      botName: "Mail bot",
      trigger: "routine",
      promptSnippet: "Check the inbox",
      createdAt: "2026-10-19T08:00:00.000Z",
    });
    const lines = plain(raw);
    expect(lines[0]).toBe("▌ Mail bot · routine · Check the inbox");
    expect(lines).toContain("Checking your inbox.");
    expect(lines).toContain("Need the newest mail.");
    expect(lines).toContain('● GMAIL_FETCH_EMAILS({"max_results":50})');
    expect(lines).toContain("  ⎿ succeeded · 2.3s · 89,404 chars");
    expect(lines).toContain("    mail 20");
    expect(lines).not.toContain("    mail 21");
    expect(lines).toContain("    … 5 more lines");
    expect(lines).toContain("  ⚠ cut off: showed 12,000 of 89,404 chars");
    expect(lines).toContain("→ message to Planner: Done");
    expect(lines).toContain("← message from Planner (hop 2): Thanks");
    expect(lines).toContain("? waiting for you: Send the reply?");
    expect(lines.at(-1)).toBe("✓ run finished · 1 steps · 1m 10s");
    // The cut-off line is yellow and the thinking dim italic.
    expect(raw.find((line) => line.includes("cut off"))).toContain("\x1b[33m");
    expect(raw.find((line) => line.includes("Need the newest mail."))).toContain("\x1b[2;3m");
    expect(lines.indexOf("Checking your inbox.")).toBeLessThan(
      lines.indexOf('● GMAIL_FETCH_EMAILS({"max_results":50})'),
    );
  });

  it("shows a running tool until its completion arrives and reports the status bar", () => {
    const running = [
      event("agent.tool.called", { name: "web_search", executionId: "call-9" }, 0),
    ];
    expect(plain(renderActivityLines(running, null))).toEqual(["● web_search()", "  ⎿ running…"]);
    expect(activityStatusLine(events)).toBe("1 steps · 2 model calls · 1m 10s");
  });

  it("forwards live thread events to open windows until unsubscribed", () => {
    const received: ProductEvent[] = [];
    const unsubscribe = subscribeActivityEvents((item) => received.push(item));
    const first = event("thread.progress", { delta: "hi" });
    publishActivityEvent(first);
    unsubscribe();
    publishActivityEvent(event("thread.progress", { delta: "later" }));
    expect(received).toEqual([first]);
  });
});
