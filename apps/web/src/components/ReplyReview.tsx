import { useLingui } from "@lingui/react/macro";
import type { ApprovalReview } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { useSpaceRpc } from "../lib/space-rpc";

export function useApprovalReview(effectId: string | undefined) {
  const client = useSpaceRpc();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    client: typeof client;
    effectId: string;
    review: ApprovalReview | null;
    failed: boolean;
    loading: boolean;
  } | null>(null);
  const request = useRef<{ client: typeof client; effectId: string; pending: boolean } | null>(
    null,
  );
  const generation = useRef(0);
  useEffect(() => {
    if (!effectId) return;
    const current = { client, effectId, pending: true };
    const version = ++generation.current;
    request.current = current;
    let active = true;
    void client.approvals.review({ effectId }).then(
      (review) => {
        if (!active || generation.current !== version) return;
        current.pending = false;
        setState({ client, effectId, review, failed: false, loading: false });
      },
      () => {
        if (!active || generation.current !== version) return;
        current.pending = false;
        setState((previous) => ({
          client,
          effectId,
          failed: true,
          loading: false,
          review:
            previous?.client === client && previous.effectId === effectId && previous.review
              ? { ...previous.review, customerContext: { status: "unavailable" } }
              : null,
        }));
      },
    );
    return () => {
      active = false;
    };
  }, [client, effectId, attempt]);
  const currentState =
    effectId && state?.client === client && state.effectId === effectId ? state : null;
  return {
    review: currentState?.review ?? null,
    failed: currentState?.failed ?? false,
    loading: Boolean(effectId) && (!currentState || currentState.loading),
    retry: () => {
      if (!effectId) return;
      const current = request.current;
      if (current?.client === client && current.effectId === effectId && current.pending) return;
      request.current = { client, effectId, pending: true };
      ++generation.current;
      setState((previous) => ({
        client,
        effectId,
        failed: false,
        loading: true,
        review:
          previous?.client === client && previous.effectId === effectId ? previous.review : null,
      }));
      setAttempt((value) => value + 1);
    },
  };
}

export function ReplyReview({
  review,
  retry,
  loading = false,
}: {
  review: ApprovalReview;
  retry: () => void;
  loading?: boolean;
}) {
  const { t } = useLingui();
  const context = review.customerContext;
  return (
    <div className="mt-4 space-y-4 text-[15.5px] leading-[1.5] text-foreground">
      <section aria-label={t`Customer inquiry`}>
        <h3 className="font-semibold">{t`Customer inquiry`}</h3>
        {context.status === "available" ? (
          <>
            <div className="mt-1 text-sm text-muted-foreground">{context.subject}</div>
            {context.source ? null : (
              <p className="mt-2 text-muted-foreground">{t`No public customer message found.`}</p>
            )}
            <div
              data-testid="reply-review-inquiry"
              dir="auto"
              className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words"
            >
              {context.inquiry}
            </div>
            {context.note ? (
              <p className="mt-2 text-sm text-muted-foreground">{context.note}</p>
            ) : null}
            {context.stale === true ? (
              <p
                role="status"
                className="mt-2 font-medium"
              >{t`Newer comments exist since this reply was proposed.`}</p>
            ) : null}
            {context.stale === null ? (
              <p className="mt-2 text-sm text-muted-foreground">{t`Freshness could not be verified.`}</p>
            ) : null}
          </>
        ) : (
          <p
            role="status"
            className="mt-2 text-muted-foreground"
          >{t`Customer context unavailable.`}</p>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-1"
          disabled={loading}
          onClick={retry}
        >
          {loading ? t`Refreshing customer context…` : t`Refresh customer context`}
        </Button>
      </section>
      <section aria-label={t`Proposed reply`}>
        <h3 className="font-semibold">{t`Proposed reply`}</h3>
        <div dir="auto" className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words">
          {review.proposedReply}
        </div>
      </section>
      <details className="text-sm text-muted-foreground">
        <summary className="cursor-pointer">{t`Technical details`}</summary>
        <dl className="mt-2 space-y-1">
          <div>
            <dt className="inline font-medium">{t`Ticket`}: </dt>
            <dd className="inline">#{review.ticket}</dd>
          </div>
          <div>
            <dt className="inline font-medium">{t`Status`}: </dt>
            <dd className="inline">{review.status}</dd>
          </div>
          {review.tags.length ? (
            <div>
              <dt className="inline font-medium">{t`Tags`}: </dt>
              <dd className="inline">{review.tags.join(", ")}</dd>
            </div>
          ) : null}
          {review.cardVersion ? (
            <div>
              <dt className="inline font-medium">{t`Approved for version`}: </dt>
              <dd className="inline">{review.cardVersion}</dd>
            </div>
          ) : null}
          {context.status === "available" && context.source ? (
            <div>
              <dt className="inline font-medium">{t`Newest customer message`}: </dt>
              <dd className="inline">{context.source.version}</dd>
            </div>
          ) : null}
        </dl>
      </details>
    </div>
  );
}
