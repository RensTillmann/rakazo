import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { ThreadMessage } from "@rakazo/contracts";
import {
  ASK_DRAFT_MAX_LENGTH,
  ATTACHMENT_MAX_COUNT,
  attachmentSizeLabel,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  commandVariableName,
} from "@rakazo/contracts";
import {
  inferAttachmentMimeType,
  isApprovalAskBlock,
  isSecretAskBlock,
  selectedAskActionLabel,
} from "@rakazo/core";
import { Button, Input, Textarea } from "@rakazo/ui-web";
import { Paperclip, Plus, X } from "lucide-react";
import type { ReactNode } from "react";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { answeredByDeviceLabel } from "../lib/answered-by-label";
import {
  ATTACHMENT_ACCEPT,
  isFilePaste,
  revokePendingAttachmentPreviews,
  usePendingAttachmentPreviewCleanup,
} from "../lib/pending-attachments";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";
import { ApprovalDetail } from "./ApprovalDetail";
import { HoldToTalkControls, HoldToTalkStrip, useHoldToTalk } from "./composer/HoldToTalk";
import { ReplyReview, useApprovalReview } from "./ReplyReview";
import { TodoChecklist, TodoInstructions } from "./TodosControl";

/** `pendingAction` while a typed answer (with its files) is being sent; never an action id. */
const TYPED_ANSWER_ACTION = "\u0000typed";

/** Without it the reply draft box is sized from its scrollHeight (older Firefox and Safari). */
const FIELD_SIZING_CONTENT =
  typeof CSS !== "undefined" && CSS.supports?.("field-sizing", "content") === true;

/** Hold-to-talk in a question card's answer box. */
export type AskVoice = { transcribe?: boolean; disabled?: boolean };

export type AskBlock = Extract<ThreadMessage["blocks"][number], { kind: "ask" }>;

function formatAnsweredState(
  answer: string | undefined,
  approval: boolean,
  secret: boolean,
  outcome?: "created" | "cancelled",
  actions?: AskBlock["actions"],
  synced?: boolean,
): string {
  if (secret) return t`Saved`;
  if (!answer) return t`Answered`;
  if (!approval && synced)
    return t`Answered: ${selectedAskActionLabel(answer, actions)} (same question)`;
  if (!approval) return t`Answered: ${selectedAskActionLabel(answer, actions)}`;
  if (outcome === "created") return t`Created`;
  if (outcome === "cancelled") return t`Cancelled`;
  if (answer === "allow") return t`Allowed once`;
  if (answer === "always") return t`Always allowed`;
  if (answer === "deny") return t`Denied`;
  return t`Answered: ${answer}`;
}

function approvalActionLabel(
  id: string,
  fallback: string,
  outcome?: "created" | "cancelled",
): string {
  if (outcome === "created") return t`Create space`;
  if (outcome === "cancelled") return t`Cancel`;
  if (id === "allow") return t`Allow once`;
  if (id === "always") return t`Always allow this tool`;
  if (id === "deny") return t`Deny`;
  return fallback;
}

function secretFieldLabel(purpose: AskBlock["purpose"]): string {
  if (purpose === "password") return t`Password`;
  if (purpose === "api_key") return t`API key`;
  return t`Code`;
}

/** What an approval button does, as its tooltip. */
function approvalActionTitle(id: string, outcome?: "created" | "cancelled"): string | undefined {
  if (outcome === "created") return t`Creates the space now`;
  if (outcome === "cancelled") return t`Leaves everything as is`;
  if (id === "allow") return t`Runs this time only; asks again next time`;
  if (id === "always") return t`Runs now and no card next time for this tool`;
  if (id === "deny") return t`Nothing runs`;
  return undefined;
}

/** Longer than this many (wrapped) lines, inquiry, reply and detail text start folded. */
const FOLD_LINES = 12;
/** Characters per line when estimating how a long line wraps on the card. */
const FOLD_LINE_CHARS = 80;

/**
 * Long card text folded behind a fade with Show all / Show less. The whole text stays in the DOM;
 * nothing is cut.
 */
function Fold({ text, children }: { text: string; children: ReactNode }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const lines = text
    .split("\n")
    .reduce((count, line) => count + Math.max(1, Math.ceil(line.length / FOLD_LINE_CHARS)), 0);
  const long = lines > FOLD_LINES;
  const folded = long && !open;
  return (
    <>
      <div
        data-folded={folded ? "true" : undefined}
        className={
          folded
            ? "max-h-[17rem] overflow-hidden [mask-image:linear-gradient(to_bottom,black_65%,transparent)]"
            : undefined
        }
      >
        {children}
      </div>
      {long ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="mt-1 text-[13px] font-medium text-muted-foreground hover:text-foreground hover:underline"
        >
          {open ? t`Show less` : t`Show all`}
        </button>
      ) : null}
    </>
  );
}

/** Fleet: which device answered this card, so a stray tap can be traced. */
export function AnsweredByLine({
  answeredBy,
}: {
  answeredBy: NonNullable<AskBlock["answeredBy"]>;
}) {
  const { t } = useLingui();
  const device = answeredByDeviceLabel(answeredBy.userAgent);
  const time = new Date(answeredBy.at).toLocaleString();
  return (
    <div
      data-testid="ask-answered-by"
      className="mt-1 text-[12px] font-normal text-muted-foreground"
    >
      {t`Answered by ${device} · ${time}`}
    </div>
  );
}

export function AskCard({
  block,
  messageId,
  botName,
  canAnswer,
  onAnswer,
  voice,
  attachmentMaxBytes,
}: {
  block: AskBlock;
  /** The card's message; once answered, the to-dos it handed over show under it. */
  messageId?: string;
  /** The bot that asked; the card says what it does with each choice. */
  botName?: string;
  canAnswer: boolean;
  /**
   * `files` only for a question card's typed answer, and only when `attachmentMaxBytes` is set.
   * `draftFinal`: a draft card's reply as edited on the card; undefined while unchanged.
   */
  onAnswer: (
    text: string,
    username?: string,
    files?: readonly File[],
    draftFinal?: string,
  ) => Promise<void>;
  /** Dictation into a question card's answer box; omitted = no microphone. */
  voice?: AskVoice;
  /** The upload limit; set = a question card's answer can carry files ('+', paste). */
  attachmentMaxBytes?: number;
}) {
  const { t } = useLingui();
  const [editing, setEditing] = useState(false);
  const [answer, setAnswer] = useState(block.instructionUpdate?.after ?? "");
  const [undone, setUndone] = useState(false);
  const [username, setUsername] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Fleet: the bot's reply draft, edited in place; any answer carries the edit along.
  const [draftText, setDraftText] = useState(block.draft ?? "");
  const draftFinal = block.draft !== undefined && draftText !== block.draft ? draftText : undefined;
  const draftEditable = canAnswer && block.status !== "answered" && block.status !== "retired";
  // A cleared reply is never sent; any answer waits until it has text again.
  const draftEmpty = draftFinal !== undefined && !draftFinal.trim();
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  // Browsers without `field-sizing: content` size the draft box through its inline height, after
  // every render: a dock card measures 0 while hidden and sizes once it is shown.
  useLayoutEffect(() => {
    const element = draftRef.current;
    if (FIELD_SIZING_CONTENT || !element?.scrollHeight) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  });
  const submitting = pendingAction !== null;
  const approvalActions = isApprovalAskBlock(block) ? block.actions : undefined;
  const replyReviewTarget =
    approvalActions && !block.instructionUpdate && block.status !== "answered"
      ? block.approvalEffectId
      : undefined;
  const replyReview = useApprovalReview(replyReviewTarget);
  // The old server detail only identifies reply presentation; it is never a body/context source.
  const knownReply = Boolean(
    replyReviewTarget &&
      !block.detailFormat &&
      /^Ticket: .+$/m.test(block.detail ?? "") &&
      /^Message: /m.test(block.detail ?? ""),
  );
  const needsFullReply = (knownReply || Boolean(replyReview.review)) && !replyReview.review;
  const approvalDetail = replyReview.review
    ? block.detail
        ?.split("\n")
        .filter(
          (line) =>
            !/^(?:Ticket|Status|Tags|Expect last comment ID|Expected last comment|Message): /.test(
              line,
            ),
        )
        .join("\n")
    : block.detail;
  const askActions = block.actions;
  const displayActions = block.instructionUpdate
    ? askActions?.flatMap((action) =>
        action.id === "allow" ? [action, { id: "edit", label: t`Edit` }] : [action],
      )
    : askActions;
  const prerequisiteItems = block.prerequisites?.items ?? [];
  const prerequisiteCount = prerequisiteItems.length;
  const secretInput = isSecretAskBlock(block);
  const loginInput = secretInput && block.credential?.auth.type === "login";
  const secretLabel = loginInput ? t`Password` : secretFieldLabel(block.purpose);
  const bot = botName ?? t`the bot`;
  const sourceRef = block.source?.ref;
  const sourceVersion = block.source?.version;
  const secretDestination =
    block.credential?.auth.type === "command"
      ? `$${commandVariableName(block.credential.name)}`
      : block.credential?.origin;
  // Who acts, what a click does, and what it affects: one line under an open card's buttons.
  const whoActs =
    !canAnswer || block.status === "answered" || block.status === "retired"
      ? null
      : secretInput
        ? secretDestination
          ? t`Saved encrypted for ${bot} to use at ${secretDestination}; never shown in chat.`
          : t`Saved encrypted for ${bot} to use; never shown in chat.`
        : block.instructionUpdate
          ? editing
            ? null
            : t`Apply changes ${bot}'s instructions now · Edit first lets you change them · Dismiss keeps them as they are.`
          : approvalActions?.some((action) => action.outcome)
            ? t`Create space creates it now; Cancel leaves everything as is.`
            : approvalActions
              ? t`${bot} runs this only if you allow it. Allow once: this time only · Always allow: no card next time for this tool · Deny: nothing runs.`
              : block.draft !== undefined
                ? sourceRef
                  ? t`${bot} gets your choice and the reply exactly as shown (with your edits); nothing is sent until ${bot} does it, for ${sourceRef}.`
                  : t`${bot} gets your choice and the reply exactly as shown (with your edits); nothing is sent until ${bot} does it.`
                : t`Your choice goes to ${bot}, which continues with it.`;

  async function submitAnswer(value: string) {
    if (submitting) return;
    if (needsFullReply && (value === "allow" || value === "always")) return;
    if (draftEmpty) {
      setError(t`The reply is empty`);
      return;
    }
    if (secretInput ? value.length === 0 : !value.trim()) return;
    const submitUsername = loginInput ? username.trim() : undefined;
    if (loginInput && !submitUsername) return;
    const submitValue = secretInput ? value : value.trim();
    setPendingAction(secretInput ? "submit" : submitValue);
    setError(null);
    if (secretInput) {
      setAnswer("");
      setUsername("");
    }
    try {
      await onAnswer(submitValue, submitUsername, undefined, draftFinal);
    } catch (err) {
      // A secret answer's failure may echo the secret, so never show its message.
      setError(
        secretInput
          ? t`Could not submit this answer`
          : errorText(err, t`Could not submit this answer`),
      );
    } finally {
      setPendingAction(null);
    }
  }

  /** A question card's typed answer. Files alone answer with a fixed line pointing at them. */
  async function submitTyped(text: string, files: readonly File[]): Promise<boolean> {
    if (submitting) return false;
    if (draftEmpty) {
      setError(t`The reply is empty`);
      return false;
    }
    const trimmed = text.trim();
    if (!trimmed && files.length === 0) return false;
    setPendingAction(TYPED_ANSWER_ACTION);
    setError(null);
    try {
      if (files.length > 0) {
        await onAnswer(trimmed || t`See the attached file(s).`, undefined, files, draftFinal);
      } else {
        await onAnswer(trimmed, undefined, undefined, draftFinal);
      }
      return true;
    } catch (err) {
      setError(errorText(err, t`Could not submit this answer`));
      return false;
    } finally {
      setPendingAction(null);
    }
  }

  const typedAnswer = (placeholder: string, onCancel?: () => void) => (
    <TypedAnswer
      placeholder={placeholder}
      busy={submitting}
      sending={pendingAction === TYPED_ANSWER_ACTION}
      onSubmit={submitTyped}
      onCancel={onCancel}
      voice={voice}
      attachmentMaxBytes={attachmentMaxBytes}
    />
  );

  if (block.instructionUpdate?.undoVersionId)
    return (
      <div className="rounded-2xl border border-border bg-card px-5 py-4">
        <div className="flex items-center gap-2 text-sm">
          <Trans>Instructions updated</Trans> ·{" "}
          <Button
            variant="link"
            disabled={undone || submitting}
            onClick={async () => {
              setPendingAction("undo");
              setError(null);
              try {
                await rpc.bots.restoreInstructions({
                  botId: block.instructionUpdate!.botId,
                  versionId: block.instructionUpdate!.undoVersionId!,
                  expectedInstructions: block.instructionUpdate!.after,
                  undo: true,
                });
                setUndone(true);
              } catch (err) {
                setError(errorText(err));
              } finally {
                setPendingAction(null);
              }
            }}
          >
            {undone ? <Trans>Restored</Trans> : <Trans>Undo</Trans>}
          </Button>
          {error ? <span className="text-destructive">{error}</span> : null}
        </div>
      </div>
    );

  return (
    <div
      data-testid={
        secretInput
          ? "secret-ask-card"
          : block.instructionUpdate
            ? "instruction-approval-card"
            : undefined
      }
      className="w-full min-w-0 max-w-xl rounded-2xl border border-border bg-card px-5 py-4"
    >
      <div className="text-[15.5px] leading-[1.5] text-foreground">
        {block.instructionUpdate ? (
          <Trans>Update instructions?</Trans>
        ) : replyReview.review ? (
          <Trans>Send public Zendesk reply?</Trans>
        ) : (
          <ChatMarkdown>{block.text}</ChatMarkdown>
        )}
      </div>
      {block.source ? (
        <div data-testid="ask-source" className="mt-1 text-[12.5px] text-muted-foreground">
          {t`For ${sourceRef} · version ${sourceVersion}`}
        </div>
      ) : null}
      {secretInput && block.credential ? (
        <div
          data-testid="secret-ask-destination"
          className="mt-2 break-all text-[13px] text-muted-foreground"
        >
          {block.credential.auth.type === "command"
            ? `${t`Command variable`} · $${commandVariableName(block.credential.name)}`
            : block.credential.origin}
        </div>
      ) : null}
      {replyReview.review ? (
        <ReplyReview
          review={replyReview.review}
          retry={replyReview.retry}
          loading={replyReview.loading}
        />
      ) : needsFullReply && replyReview.loading ? (
        <div className="mt-3 text-sm text-muted-foreground" role="status">
          <Trans>Loading full reply…</Trans>
        </div>
      ) : null}
      {needsFullReply && !replyReview.loading ? (
        <div className="mt-3 text-sm text-muted-foreground" role="status">
          <Trans>Full approval review unavailable.</Trans>
          <Button type="button" variant="ghost" size="sm" onClick={replyReview.retry}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : null}
      {approvalDetail && !secretInput ? (
        approvalActions && !block.instructionUpdate && !block.detailFormat ? (
          <ApprovalDetail detail={approvalDetail} />
        ) : (
          <Fold text={approvalDetail}>
            <pre
              className={
                block.detailFormat === "text"
                  ? "mt-3 whitespace-pre-wrap break-words font-sans text-[15.5px] leading-[1.5] text-foreground"
                  : "mt-3 whitespace-pre-wrap break-words rounded-xl bg-muted px-3.5 py-3 font-mono text-[12.5px] leading-[1.7] text-muted-foreground"
              }
            >
              {approvalDetail}
            </pre>
          </Fold>
        )
      ) : null}
      {block.inquiry ? (
        <section aria-label={t`Customer inquiry`} className="mt-3">
          <h3 className="text-[13px] font-medium text-muted-foreground">
            <Trans>Customer inquiry</Trans>
          </h3>
          <Fold text={block.inquiry}>
            <div
              data-testid="ask-inquiry"
              dir="auto"
              className="mt-1 whitespace-pre-wrap break-words rounded-xl bg-muted px-3.5 py-3 text-[15.5px] leading-[1.5] text-foreground"
            >
              {block.inquiry}
            </div>
          </Fold>
        </section>
      ) : null}
      {block.draft !== undefined ? (
        <section aria-label={t`Proposed reply`} className="mt-3">
          <h3 className="text-[13px] font-medium text-muted-foreground">
            <Trans>Proposed reply</Trans>
          </h3>
          {draftEditable ? (
            <Textarea
              data-testid="ask-draft"
              aria-label={t`Proposed reply`}
              dir="auto"
              maxLength={ASK_DRAFT_MAX_LENGTH}
              disabled={submitting}
              value={draftText}
              ref={draftRef}
              // Grows with the text (`field-sizing: content`); the dock body scrolls past that.
              className="mt-1 min-h-24 resize-none bg-background text-[15.5px] leading-[1.5] md:text-[15.5px]"
              onChange={(event) => setDraftText(event.target.value)}
            />
          ) : (
            <>
              <Fold text={block.draftFinal ?? block.draft}>
                <div
                  data-testid="ask-draft"
                  dir="auto"
                  className="mt-1 whitespace-pre-wrap break-words rounded-xl bg-muted px-3.5 py-3 text-[15.5px] leading-[1.5] text-foreground"
                >
                  {block.draftFinal ?? block.draft}
                </div>
              </Fold>
              {block.draftFinal !== undefined ? (
                <div className="mt-1 text-[12px] text-muted-foreground">
                  <Trans>Edited before answering</Trans>
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}
      {block.instructionUpdate && editing && canAnswer && block.status !== "answered" ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAnswer(JSON.stringify({ instructions: answer }));
          }}
        >
          <Textarea
            aria-label={t`Instructions`}
            maxLength={BOT_INSTRUCTIONS_MAX_LENGTH}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
          />
          <Button type="submit" disabled={submitting}>
            <Trans>Apply</Trans>
          </Button>
          <Button type="button" variant="outline" onClick={() => setEditing(false)}>
            <Trans>Cancel</Trans>
          </Button>
        </form>
      ) : block.status === "answered" ? (
        <>
          <div
            className={`mt-3.5 text-[13.5px] font-medium ${block.answer === "deny" ? "text-muted-foreground" : "text-success"}`}
          >
            {block.instructionUpdate
              ? block.answer === "deny"
                ? t`Dismissed`
                : t`Allowed once`
              : formatAnsweredState(
                  block.answer,
                  Boolean(approvalActions),
                  secretInput,
                  approvalActions?.find((action) => action.id === block.answer)?.outcome,
                  askActions,
                  Boolean(block.syncedFrom),
                )}
            {block.answeredBy ? <AnsweredByLine answeredBy={block.answeredBy} /> : null}
          </div>
          {messageId && block.prerequisites ? <TodoChecklist messageId={messageId} /> : null}
        </>
      ) : block.status === "retired" ? (
        <div className="mt-3.5 text-[13.5px] text-muted-foreground" role="status">
          <span className="font-medium">
            <Trans>No longer needed</Trans>
          </span>
          {block.retiredReason ? (
            <p className="mt-1 whitespace-pre-wrap">{block.retiredReason}</p>
          ) : null}
        </div>
      ) : !canAnswer ? (
        <div className="mt-3.5 text-[13.5px] font-medium text-muted-foreground">
          <Trans>No longer active</Trans>
        </div>
      ) : askActions?.length ? (
        <div className={approvalActions ? "mt-3.5 flex flex-wrap gap-2" : "mt-3.5 space-y-1.5"}>
          {displayActions?.map((action) => (
            <Fragment key={action.id}>
              <Button
                title={approvalActions ? approvalActionTitle(action.id, action.outcome) : undefined}
                variant={approvalActions && action.id === "allow" ? "default" : "outline"}
                className={`h-auto min-w-0 whitespace-normal px-3.5 py-3 text-start font-normal ${approvalActions ? "" : "w-full justify-start"}`}
                disabled={
                  submitting ||
                  (needsFullReply && (action.id === "allow" || action.id === "always"))
                }
                onClick={() =>
                  action.id === "edit" && block.instructionUpdate
                    ? setEditing(true)
                    : void submitAnswer(action.id)
                }
              >
                {pendingAction === action.id ? (
                  <Trans>Sending…</Trans>
                ) : action.id === "edit" && block.instructionUpdate ? (
                  action.label
                ) : approvalActions ? (
                  block.instructionUpdate ? (
                    action.id === "allow" ? (
                      t`Apply`
                    ) : (
                      t`Dismiss`
                    )
                  ) : (
                    approvalActionLabel(action.id, action.label, action.outcome)
                  )
                ) : "todo" in action && action.todo && prerequisiteCount ? (
                  <span className="flex min-w-0 flex-col items-start gap-1">
                    <span>{action.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {prerequisiteCount === 1
                        ? t`adds 1 to-do`
                        : t`adds ${prerequisiteCount} to-dos`}
                    </span>
                  </span>
                ) : (
                  action.label
                )}
              </Button>
              {"todo" in action && action.todo && prerequisiteCount && !approvalActions ? (
                // What choosing it commits the user to, before choosing.
                <ul data-testid="todo-preview" className="space-y-1 ps-3.5 text-[13.5px]">
                  {prerequisiteItems.map((item) => (
                    <li key={item.key}>
                      <span>{item.title}</span>
                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground">
                          <Trans>Show steps</Trans>
                        </summary>
                        <div className="mt-1 space-y-1">
                          <TodoInstructions why={item.why} steps={item.steps} />
                        </div>
                      </details>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Fragment>
          ))}
          {!approvalActions && !block.instructionUpdate
            ? typedAnswer(t`Or type your own answer…`)
            : null}
        </div>
      ) : secretInput ? (
        <form
          className="mt-3.5 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submitAnswer(answer);
          }}
        >
          {loginInput ? (
            <Input
              aria-label={t`Username`}
              autoComplete="off"
              spellCheck={false}
              disabled={submitting}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder={t`Username`}
            />
          ) : null}
          <Input
            aria-label={secretLabel}
            type="password"
            autoComplete="off"
            spellCheck={false}
            disabled={submitting}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder={secretLabel}
          />
          <Button
            type="submit"
            className="self-start"
            disabled={answer.length === 0 || (loginInput && !username.trim()) || submitting}
          >
            {submitting ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>
        </form>
      ) : editing ? (
        <div className="mt-3.5">{typedAnswer(t`Type your answer…`, () => setEditing(false))}</div>
      ) : (
        <div className="mt-3.5 flex gap-2">
          <Button disabled={submitting} onClick={() => void submitAnswer("approved")}>
            {submitting ? <Trans>Sending…</Trans> : <Trans>Send it</Trans>}
          </Button>
          <Button variant="outline" disabled={submitting} onClick={() => setEditing(true)}>
            <Trans>Edit first</Trans>
          </Button>
        </div>
      )}
      {whoActs ? (
        <p data-testid="ask-who-acts" className="mt-2.5 text-[12.5px] text-muted-foreground">
          {/* "the bot" opens some lines when the card has no bot name. */}
          {whoActs.charAt(0).toUpperCase() + whoActs.slice(1)}
        </p>
      ) : null}
      {error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null}
    </div>
  );
}

type PendingAnswerFile = { id: string; file: File; previewUrl?: string };

/**
 * A question card's own answer box. Enter sends, Shift+Enter adds a line; it grows with the text
 * up to about six lines. Its text and files stay while the decision dock cycles (cards stay
 * mounted). Dictation lands in the box to check before sending; it is never sent on its own.
 */
function TypedAnswer({
  placeholder,
  busy,
  sending,
  onSubmit,
  onCancel,
  voice,
  attachmentMaxBytes,
}: {
  placeholder: string;
  /** Any answer of this card is being sent. */
  busy: boolean;
  /** This box's answer is being sent. */
  sending: boolean;
  onSubmit: (text: string, files: readonly File[]) => Promise<boolean>;
  onCancel?: () => void;
  voice?: AskVoice;
  attachmentMaxBytes?: number;
}) {
  const { t } = useLingui();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PendingAnswerFile[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  usePendingAttachmentPreviewCleanup(files);
  const talk = useHoldToTalk({
    transcribe: voice?.transcribe,
    disabled: !voice || voice.disabled,
    // Releasing adds the words to the box; the user sends them.
    releaseHint: t`Hold to talk, release to add the text`,
    onText: (heard) =>
      setText((current) =>
        !current ? heard : /\s$/.test(current) ? `${current}${heard}` : `${current} ${heard}`,
      ),
  });
  const canSend = !busy && (text.trim().length > 0 || files.length > 0);

  function addFiles(list: FileList | null) {
    if (!attachmentMaxBytes || !list?.length) return;
    const next: PendingAnswerFile[] = [];
    const skipped: string[] = [];
    for (const file of Array.from(list)) {
      if (files.length + next.length >= ATTACHMENT_MAX_COUNT) {
        skipped.push(t`${file.name} (max ${ATTACHMENT_MAX_COUNT} attachments)`);
        continue;
      }
      if (file.size > attachmentMaxBytes) {
        skipped.push(t`${file.name} (over ${attachmentSizeLabel(attachmentMaxBytes)})`);
        continue;
      }
      const mimeType = inferAttachmentMimeType(file.name, file.type);
      if (!mimeType) {
        skipped.push(file.name);
        continue;
      }
      next.push({
        id: `${file.name}-${file.size}-${file.lastModified}-${files.length + next.length}`,
        file,
        previewUrl: mimeType.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      });
    }
    if (next.length) setFiles((current) => [...current, ...next]);
    setNotice(skipped.length ? t`Skipped ${skipped.join(", ")}` : null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeFile(pending: PendingAnswerFile) {
    revokePendingAttachmentPreviews([pending]);
    setFiles((current) => current.filter((item) => item.id !== pending.id));
  }

  async function send() {
    if (!canSend) return;
    const sent = await onSubmit(
      text,
      files.map((pending) => pending.file),
    );
    if (!sent) return;
    revokePendingAttachmentPreviews(files);
    setText("");
    setFiles([]);
    setNotice(null);
  }

  return (
    <div className="pt-1">
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {attachmentMaxBytes ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT}
              className="hidden"
              data-testid="ask-attach-input"
              onChange={(event) => addFiles(event.target.files)}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={t`Attach file`}
              disabled={busy}
              onClick={() => fileInputRef.current?.click()}
              className="size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
            >
              <Plus size={16} strokeWidth={2} />
            </Button>
          </>
        ) : null}
        <HoldToTalkStrip talk={talk} />
        <Textarea
          data-testid="ask-type-answer"
          aria-label={t`Your answer`}
          hidden={talk.recording !== null}
          rows={1}
          dir="auto"
          className="max-h-36 min-h-9 resize-none overflow-y-auto"
          placeholder={placeholder}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            // Browsers without `field-sizing: content` grow through the inline height.
            const element = event.currentTarget;
            element.style.height = "auto";
            element.style.height = `${element.scrollHeight}px`;
          }}
          onPaste={(event) => {
            const clipboard = event.clipboardData;
            if (!attachmentMaxBytes || !isFilePaste(clipboard)) return;
            // Pasted files become attachments; any pasted text still lands at the cursor.
            event.preventDefault();
            addFiles(clipboard.files);
            const pasted = clipboard.getData("text/plain");
            if (!pasted) return;
            const { selectionStart, selectionEnd } = event.currentTarget;
            setText(`${text.slice(0, selectionStart)}${pasted}${text.slice(selectionEnd)}`);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void send();
          }}
        />
        {voice ? <HoldToTalkControls talk={talk} disabled={voice.disabled || busy} /> : null}
        {talk.recording?.locked ? null : (
          <Button type="submit" aria-label={t`Send answer`} disabled={!canSend}>
            {sending ? <Trans>Sending…</Trans> : <Trans>Send</Trans>}
          </Button>
        )}
        {onCancel ? (
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            <Trans>Cancel</Trans>
          </Button>
        ) : null}
      </form>
      {files.length ? (
        <div className="mt-2 flex flex-wrap gap-2" data-testid="ask-attachments">
          {files.map((pending) => (
            <div
              key={pending.id}
              className="flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1.5 text-[13px] text-foreground/75"
            >
              {pending.previewUrl ? (
                <img
                  src={pending.previewUrl}
                  alt={pending.file.name}
                  className="h-8 w-8 rounded object-cover"
                />
              ) : (
                <Paperclip size={14} strokeWidth={1.8} />
              )}
              <span className="max-w-[180px] truncate" dir="auto">
                {pending.file.name}
              </span>
              <button
                type="button"
                aria-label={t`Remove ${pending.file.name}`}
                disabled={busy}
                onClick={() => removeFile(pending)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X size={13} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {notice ? <p className="mt-2 text-[12.5px] text-warning">{notice}</p> : null}
    </div>
  );
}
