import { InboundDeliverySource } from "@rakazo/contracts";

/**
 * clientNonce prefix for a message an integration delivered (`<source>:<botId>:`). The nonce is
 * the only place that records it: the message itself is stored with the owner's role, so clients
 * read the prefix to show an automatic wake apart from the owner's own words.
 */
export function inboundDeliveryNoncePrefix(source: InboundDeliverySource, botId: string): string {
  return `${source}:${botId}:`;
}

export function inboundSourceFromClientNonce(
  clientNonce: string | null | undefined,
): InboundDeliverySource | undefined {
  const sourceEnd = clientNonce?.indexOf(":") ?? -1;
  if (!clientNonce || sourceEnd < 1) return undefined;
  const source = InboundDeliverySource.safeParse(clientNonce.slice(0, sourceEnd));
  return source.success ? source.data : undefined;
}

/**
 * What the server wrote above the delivered data: one `Run routine "<name>":` line per routine and
 * the event header. Only that head is read, so text inside the payload cannot rename the wake.
 */
export function inboundDeliverySummary(text: string): { routines: string[]; event?: string } {
  const head = text.split(/<(?:untrusted_delivery_payload|github_event_metadata)>/, 1)[0] ?? "";
  return {
    routines: [...head.matchAll(/^Run routine "(.+)":$/gm)].flatMap((match) =>
      match[1] ? [match[1]] : [],
    ),
    event: /^\[(?:Inbound|GitHub) Event: (.+)\]$/m.exec(head)?.[1],
  };
}
