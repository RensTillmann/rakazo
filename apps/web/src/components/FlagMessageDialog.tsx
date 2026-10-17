import { Trans, useLingui } from "@lingui/react/macro";
import { FLAG_NOTE_MAX_LENGTH } from "@rakazo/contracts";
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
import { useEffect, useId, useRef, useState } from "react";
import { newClientId } from "../lib/client-id";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

/** How long the "Sent" confirmation stays before the dialog closes itself. */
const SENT_CLOSE_MS = 1_500;

export type FlagTarget = { botId: string; botName: string; label: string };

/**
 * Forwards one message, with an optional note, to the deployment's flag bot
 * (`RAKAZO_FLAG_BOT`). The note is optional so a phone user can send with one tap.
 */
export function FlagMessageDialog({
  flag,
  thread,
  messageId,
  onClose,
}: {
  flag: FlagTarget;
  thread: { botId: string } | { groupId: string };
  messageId: string;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const noteId = useId();
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  // One nonce per dialog, so a retried Send after a lost response cannot post twice.
  const [clientNonce] = useState(newClientId);
  const [note, setNote] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  // A touch keyboard would cover the dialog, so phones start on Send instead of the note.
  const [finePointer] = useState(() => window.matchMedia("(pointer: fine)").matches);

  useEffect(() => {
    if (state !== "sent") return;
    const timer = window.setTimeout(onClose, SENT_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [state, onClose]);

  async function send() {
    setState("sending");
    setError(null);
    try {
      await rpc.threads.flag({ ...thread, messageId, note: note.trim() || undefined, clientNonce });
      setState("sent");
    } catch (cause) {
      setError(errorText(cause, t`Could not send the message`));
      setState("idle");
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && state !== "sending") onClose();
      }}
    >
      <DialogContent
        data-testid="flag-message-dialog"
        initialFocus={finePointer ? noteRef : sendRef}
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>{flag.label}</DialogTitle>
          <DialogDescription>
            <Trans>Sends this message to {flag.botName}, with your note.</Trans>
          </DialogDescription>
        </DialogHeader>
        {state === "sent" ? (
          <p role="status" className="text-sm">
            <Trans>Sent to {flag.botName}.</Trans>
          </p>
        ) : (
          <form
            id={`${noteId}-form`}
            className="space-y-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <label htmlFor={noteId} className="block text-sm text-muted-foreground">
              <Trans>Note (optional)</Trans>
            </label>
            <Textarea
              id={noteId}
              ref={noteRef}
              data-testid="flag-message-note"
              value={note}
              maxLength={FLAG_NOTE_MAX_LENGTH}
              rows={3}
              placeholder={t`What went wrong, or what should be different?`}
              disabled={state === "sending"}
              onChange={(event) => setNote(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </form>
        )}
        <DialogFooter>
          {state === "sent" ? (
            <Button className="h-11 sm:h-9" onClick={onClose}>
              <Trans>Done</Trans>
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                className="h-11 sm:h-9"
                disabled={state === "sending"}
                onClick={onClose}
              >
                <Trans>Cancel</Trans>
              </Button>
              <Button
                ref={sendRef}
                type="submit"
                form={`${noteId}-form`}
                className="h-11 sm:h-9"
                disabled={state === "sending"}
                data-testid="flag-message-send"
              >
                {state === "sending" ? <Trans>Sending…</Trans> : <Trans>Send</Trans>}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
