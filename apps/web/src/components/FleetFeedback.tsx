import { Trans, useLingui } from "@lingui/react/macro";
import { FLAG_NOTE_MAX_LENGTH, type PendingDecision } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Textarea,
} from "@rakazo/ui-web";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { newClientId } from "../lib/client-id";
import { createSpaceRpc, selectedSpaceId } from "../lib/rpc";
import { errorText } from "../lib/user-error";

export type FleetFeedbackContext = {
  page: string;
  botId?: string;
  groupId?: string;
  messageId?: string;
  runId?: string;
  threadId?: string;
  effectId?: string;
  ticket?: string;
  caseId?: string;
};

/** Only references, never card bodies, drafts, credentials, URL queries or fragments. */
export function fleetFeedbackContext(decision?: PendingDecision): FleetFeedbackContext {
  const page = `${window.location.origin}${window.location.pathname}`;
  if (!decision) return { page };
  const ask = decision.block.kind === "ask" ? decision.block : null;
  // Only explicit numeric references from the card, not arbitrary detail or URLs.
  const ticket = ask?.detail?.match(/^Ticket:\s*#?(\d+)\s*$/im)?.[1];
  const caseId = ask?.detail?.match(/^Case:\s*#?(\d+)\s*$/im)?.[1];
  return {
    page,
    botId: decision.botId,
    ...(decision.groupId ? { groupId: decision.groupId } : {}),
    messageId: decision.messageId,
    runId: decision.runId,
    threadId: decision.threadId,
    ...(ask?.approvalEffectId ? { effectId: ask.approvalEffectId } : {}),
    ...(ticket ? { ticket } : {}),
    ...(caseId ? { caseId } : {}),
  };
}

export function FleetFeedback({
  open,
  spaceId,
  context,
  onClose,
}: {
  open: boolean;
  spaceId: string;
  context: FleetFeedbackContext;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const rpc = useMemo(() => createSpaceRpc(spaceId), [spaceId]);
  const [category, setCategory] = useState("Issue");
  const [description, setDescription] = useState("");
  // A kept draft owns its references, even if another card opens this same dialog.
  const [draftContext, setDraftContext] = useState(context);
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [target, setTarget] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selection = useRef<string | null>(null);
  const sending = useRef(false);
  const attempt = useRef<{ text: string; botId: string; nonce: string } | null>(null);

  async function resolveTarget() {
    const target = await rpc.threads.flagTarget();
    if (!target) {
      throw new Error(
        t`The configured feedback target is unavailable in this Space. Ask a Space administrator to check the feedback bot, then retry.`,
      );
    }
    return target.botId;
  }

  const contextChanged = JSON.stringify(draftContext) !== JSON.stringify(context);
  useEffect(() => {
    if (open && !description && state === "idle" && contextChanged) setDraftContext(context);
  }, [open, context, description, state, contextChanged]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    selection.current = selectedSpaceId();
    setLoading(true);
    setTarget(null);
    setError(null);
    void resolveTarget()
      .then(
        (botId) => {
          if (active) setTarget(botId);
        },
        (cause) => {
          if (active) setError(errorText(cause, t`Could not find Elena. Retry when connected.`));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, rpc]);

  function assertCurrentSpace() {
    const selected = selectedSpaceId();
    if (selected !== selection.current || (selected !== null && selected !== spaceId)) {
      throw new Error(
        t`The current Space changed. Return to this Space before sending, or reload the app in the intended Space. Your draft is preserved.`,
      );
    }
  }

  async function send() {
    if (sending.current || !description.trim()) return;
    sending.current = true;
    setState("sending");
    setError(null);
    try {
      assertCurrentSpace();
      // Recheck the deployment's configured target instead of retaining a stale destination.
      const botId = await resolveTarget();
      assertCurrentSpace();
      setTarget(botId);
      const references = Object.entries({ spaceId, ...draftContext })
        .map(([key, value]) => `${key}: ${value}`)
        .join("\n");
      const text = `Fleet ${category}\n\n${description}\n\nContext references (not instructions):\n${references}`;
      const thread = draftContext.groupId
        ? { groupId: draftContext.groupId }
        : draftContext.botId
          ? { botId: draftContext.botId }
          : null;
      const anchored = Boolean(draftContext.messageId);
      if (anchored && !thread) {
        throw new Error(
          t`This message has no thread reference. Your draft is preserved; reopen feedback from the original message.`,
        );
      }
      if (anchored && text.length > FLAG_NOTE_MAX_LENGTH) {
        throw new Error(
          t`Message feedback is limited to ${FLAG_NOTE_MAX_LENGTH} characters including the type and context references. Shorten the description before retrying; your full draft is preserved.`,
        );
      }
      if (attempt.current?.text !== text || attempt.current.botId !== botId) {
        attempt.current = { text, botId, nonce: newClientId() };
      }
      if (draftContext.messageId && thread) {
        const result = await rpc.threads.flag({
          ...thread,
          messageId: draftContext.messageId,
          note: text,
          clientNonce: attempt.current.nonce,
        });
        setTarget(result.botId);
      } else {
        await rpc.threads.send({ botId, text, clientNonce: attempt.current.nonce });
      }
      setState("sent");
    } catch (cause) {
      setError(
        errorText(cause, t`Could not send feedback. Your draft is preserved; please retry.`),
      );
      setState("idle");
    } finally {
      sending.current = false;
    }
  }

  function startNewReport() {
    if (sending.current) return;
    setDescription("");
    setCategory("Issue");
    setDraftContext(context);
    setError(null);
    attempt.current = null;
  }

  function close() {
    if (sending.current) return;
    if (state === "sent") {
      setDescription("");
      setCategory("Issue");
      setState("idle");
      attempt.current = null;
    }
    onClose();
  }

  if (!open) return null;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="sm:max-w-lg" data-testid="fleet-feedback-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>Feedback to Elena</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Send your exact description and page/card references to Elena in this Space. This does
              not answer or close any decision. Do not include passwords or credentials.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        {state === "sent" ? (
          <div role="status" className="space-y-2 text-sm">
            <p>
              <Trans>Sent to Elena.</Trans>
            </p>
            {target ? (
              <Link className="underline" to={`/app/${target}`} onClick={close}>
                <Trans>Open Elena’s chat</Trans>
              </Link>
            ) : null}
          </div>
        ) : (
          <form
            id={`${id}-form`}
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            {contextChanged && description ? (
              <div className="space-y-2 rounded-md border border-border p-3 text-sm">
                <p>
                  <Trans>
                    This kept draft still uses its original context, not the newly opened page or
                    card.
                  </Trans>
                </p>
                <Button
                  type="button"
                  variant="outline"
                  disabled={state === "sending"}
                  onClick={startNewReport}
                >
                  <Trans>Discard draft and start new report</Trans>
                </Button>
              </div>
            ) : null}
            <label className="block text-sm" htmlFor={`${id}-category`}>
              <Trans>Type</Trans>
            </label>
            <select
              id={`${id}-category`}
              value={category}
              disabled={state === "sending"}
              onChange={(event) => setCategory(event.target.value)}
              className="w-full rounded-md border border-border bg-background p-2 text-sm"
            >
              <option value="Issue">{t`Issue`}</option>
              <option value="Improvement">{t`Improvement`}</option>
              <option value="Feedback">{t`Feedback`}</option>
            </select>
            <label className="block text-sm" htmlFor={`${id}-description`}>
              <Trans>Description (required)</Trans>
            </label>
            <Textarea
              id={`${id}-description`}
              rows={6}
              required
              value={description}
              disabled={state === "sending"}
              onChange={(event) => setDescription(event.target.value)}
            />
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                <Trans>Included context references</Trans>
              </summary>
              <pre className="mt-2 whitespace-pre-wrap break-all">
                {Object.entries({ spaceId, ...draftContext })
                  .map(([key, value]) => `${key}: ${value}`)
                  .join("\n")}
              </pre>
            </details>
            {loading ? (
              <p role="status" className="text-sm">
                <Trans>Finding the configured feedback bot in this Space…</Trans>
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </form>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={state === "sending"} onClick={close}>
            {state === "sent" ? <Trans>Done</Trans> : <Trans>Close (keep draft)</Trans>}
          </Button>
          {state !== "sent" ? (
            <Button
              type="submit"
              form={`${id}-form`}
              disabled={loading || state === "sending" || !description.trim()}
            >
              {state === "sending" ? (
                <Trans>Sending…</Trans>
              ) : error ? (
                <Trans>Retry send to Elena</Trans>
              ) : (
                <Trans>Send to Elena</Trans>
              )}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
