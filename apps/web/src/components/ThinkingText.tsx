import { Trans } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { THINKING_BLOCK_MAX_CHARS } from "@rakazo/contracts";
import { useLayoutEffect, useRef, useState } from "react";

/**
 * The bot's thinking for one model call (shown only with Show thoughts on): small, grey and
 * italic, folded to about three lines with a toggle to read the rest.
 */
export function ThinkingText({ text, truncated }: { text: string; truncated?: boolean }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = body.current;
    if (element && !open) setOverflows(element.scrollHeight > element.clientHeight + 1);
  }, [open, text]);
  return (
    <div data-thinking="" className="text-[13px] italic leading-[1.45] text-muted-foreground">
      <div ref={body} className={open ? undefined : "max-h-[4.35em] overflow-hidden"}>
        <ChatMarkdown>{text}</ChatMarkdown>
      </div>
      {open && truncated ? (
        <div className="mt-1 text-[12px]">
          <Trans>Cut at {THINKING_BLOCK_MAX_CHARS} characters.</Trans>
        </div>
      ) : null}
      {overflows || open ? (
        <button
          type="button"
          data-testid="thinking-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="mt-0.5 text-[12px] not-italic text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {open ? <Trans>Show less</Trans> : <Trans>Show more</Trans>}
        </button>
      ) : null}
    </div>
  );
}
