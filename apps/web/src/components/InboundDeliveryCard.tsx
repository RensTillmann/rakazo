import { useLingui } from "@lingui/react/macro";
import { LinkifiedText } from "@rakazo/chat-ui/web";
import type { InboundDeliverySource } from "@rakazo/contracts";
import { inboundDeliverySummary } from "@rakazo/core";
import { ChevronRight } from "lucide-react";

/** A wake an integration delivered: labelled automatic and folded, never shown as the owner's words. */
export function InboundDeliveryCard({
  source,
  text,
}: {
  source: InboundDeliverySource;
  text: string;
}) {
  const { t } = useLingui();
  const { routines, event } = inboundDeliverySummary(text);
  const sourceName =
    source === "github" ? "GitHub" : source === "messaging" ? t`Message channel` : t`Webhook`;
  const title = routines.join(", ") || sourceName;
  const detail = event ?? (routines.length > 0 ? sourceName : undefined);
  return (
    <details
      data-testid="message-inbound-card"
      className="group max-w-full rounded-2xl border border-border bg-card px-4 py-2.5"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[13.5px] text-muted-foreground [&::-webkit-details-marker]:hidden">
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[12px] font-medium text-foreground/80">
          {t`Automatic`}
        </span>
        <span className="min-w-0 truncate text-foreground/85">{title}</span>
        {/* Phones keep the room for the routine name; the event is in the opened card. */}
        {detail ? <span className="hidden min-w-0 truncate sm:inline">{detail}</span> : null}
        <ChevronRight
          aria-hidden
          className="ms-auto size-4 shrink-0 transition-transform group-open:rotate-90"
        />
      </summary>
      <div
        className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap wrap-anywhere text-[13px] leading-[1.45] text-foreground/80"
        dir="auto"
      >
        <LinkifiedText>{text}</LinkifiedText>
      </div>
    </details>
  );
}
