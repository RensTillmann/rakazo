import { Trans, useLingui } from "@lingui/react/macro";
import {
  ACTIONABLE_USER_TODO_STATUSES,
  type UserTodo,
  type UserTodoStatus,
} from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@rakazo/ui-web";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { rpc } from "../lib/rpc";
import { useVisibleResource } from "../lib/use-visible-resource";

const OPEN_POLL_MS = 5_000;
const CLOSED_POLL_MS = 60_000;
/** Titles and topics longer than this are clipped; the full text stays in the tooltip. */
const SHORT_TEXT = 40;

const ACTIONABLE: readonly UserTodoStatus[] = ACTIONABLE_USER_TODO_STATUSES;
/** Unticked boxes the user can tick: `checking` waits on the bot instead. */
const TICKABLE: readonly UserTodoStatus[] = ["open", "remaining", "unavailable"];
const FINISHED: readonly UserTodoStatus[] = ["verified", "confirmed", "retired"];

function clip(text: string) {
  return text.length > SHORT_TEXT ? `${text.slice(0, SHORT_TEXT - 1).trimEnd()}…` : text;
}

/** Header control for the user's manual prerequisites; hidden until a bot hands one over. */
export function TodosControl() {
  const { t } = useLingui();
  const resource = useVisibleResource(() => rpc.todos.list(), { key: "todos" });
  const [open, setOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const sending = useRef(false);

  useEffect(() => {
    let disposed = false;
    let timer: number;
    const interval = open ? OPEN_POLL_MS : CLOSED_POLL_MS;
    async function poll() {
      if (document.visibilityState === "visible") await resource.refresh();
      if (!disposed) timer = window.setTimeout(() => void poll(), interval);
    }
    timer = window.setTimeout(() => void poll(), interval);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [resource.refresh, open]);

  function toggle(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  /** Ticking means "I did this": automatic items ask the bot to verify, manual ones take the user's word. */
  async function tick(todo: UserTodo) {
    if (sending.current || !TICKABLE.includes(todo.status)) return;
    sending.current = true;
    setPendingId(todo.id);
    setMessage(null);
    const input = { todoId: todo.id, revision: todo.revision };
    try {
      if (todo.verification === "automatic") await rpc.todos.check(input);
      else await rpc.todos.confirm(input);
    } catch (error) {
      setMessage(
        (error as { code?: string } | null)?.code === "CONFLICT"
          ? t`This to-do changed; refreshed.`
          : t`Couldn't update this to-do. Try again.`,
      );
    } finally {
      await resource.refresh();
      sending.current = false;
      setPendingId(null);
    }
  }

  const todos = resource.data?.todos ?? [];
  if (!todos.length) return null;
  const count = todos.filter((todo) => ACTIONABLE.includes(todo.status)).length;
  // One group per card, in the server's (actionable-first) order.
  const groups = new Map<string, UserTodo[]>();
  for (const todo of todos) {
    const group = groups.get(todo.groupId);
    if (group) group.push(todo);
    else groups.set(todo.groupId, [todo]);
  }

  /** One short muted line, only for states where it matters; full text in the tooltip. */
  function secondary(todo: UserTodo) {
    const detail = todo.statusDetail;
    const [line, full] =
      todo.status === "checking"
        ? [t`checking…`, null]
        : todo.status === "remaining"
          ? [detail ? t`still missing: ${detail}` : t`still missing`, detail]
          : todo.status === "unavailable"
            ? [t`couldn't check — tick again to retry`, detail]
            : todo.status === "retired"
              ? [t`no longer needed`, detail]
              : [null, null];
    if (!line) return null;
    return (
      <p
        data-testid="todo-secondary"
        title={full ?? line}
        className={`truncate ps-7 text-xs ${todo.status === "remaining" ? "text-warning" : "text-muted-foreground"}`}
      >
        {line}
      </p>
    );
  }

  function item(todo: UserTodo) {
    const isOpen = expanded.has(todo.id);
    const requesting = todo.id === pendingId;
    // Manual ticks are the user's own word, so they show done at once; automatic ones wait on the bot.
    const checked =
      todo.status === "verified" ||
      todo.status === "confirmed" ||
      (requesting && todo.verification === "manual");
    const pending = !checked && (requesting || todo.status === "checking");
    const tickable = TICKABLE.includes(todo.status) && pendingId === null;
    const title = todo.title;
    return (
      <li key={todo.id} data-todo-id={todo.id} className="py-1">
        <div className="flex items-center gap-2">
          <span className="relative grid size-5 shrink-0 place-items-center">
            <input
              type="checkbox"
              aria-label={t`Mark '${title}' as done`}
              aria-busy={pending}
              checked={checked}
              ref={(element) => {
                if (element) element.indeterminate = pending;
              }}
              disabled={!tickable}
              onChange={() => void tick(todo)}
              className="peer size-4 cursor-pointer appearance-none rounded border border-input bg-background checked:border-success checked:bg-success enabled:hover:border-primary disabled:cursor-default"
            />
            {pending ? (
              <LoaderCircle
                aria-hidden
                className="pointer-events-none absolute size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none"
              />
            ) : checked ? (
              <span
                aria-hidden
                className="pointer-events-none absolute text-[11px] leading-none text-background"
              >
                ✓
              </span>
            ) : null}
          </span>
          <button
            type="button"
            aria-label={t`Show how`}
            aria-expanded={isOpen}
            title={title}
            onClick={() => toggle(todo.id)}
            className={`min-w-0 flex-1 truncate text-start hover:underline ${todo.status === "retired" ? "text-muted-foreground" : ""}`}
          >
            {clip(title)}
          </button>
          {todo.status === "confirmed" || (requesting && todo.verification === "manual") ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              <Trans>(you)</Trans>
            </span>
          ) : null}
        </div>
        {secondary(todo)}
        {isOpen ? (
          <div className="ms-7 mt-1.5 space-y-1.5 rounded-md bg-muted/50 p-2.5 text-xs">
            <p className="font-medium">
              <Trans>How</Trans>
            </p>
            <ol className="list-decimal space-y-0.5 ps-4">
              {todo.steps
                .split("\n")
                .map((step) => step.replace(/^\s*\d+[.)]\s*/, "").trim())
                .filter(Boolean)
                .map((step, index) => (
                  <li key={`${index}:${step}`}>{step}</li>
                ))}
            </ol>
            {todo.statusDetail ? (
              <p className="whitespace-pre-wrap text-muted-foreground">{todo.statusDetail}</p>
            ) : null}
            {todo.evidence ? (
              <p className="whitespace-pre-wrap text-muted-foreground">{todo.evidence}</p>
            ) : null}
            <Timestamp todo={todo} />
          </div>
        ) : null}
      </li>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="app-no-drag"
        onClick={() => {
          setMessage(null);
          setOpen(true);
          void resource.refresh();
        }}
      >
        {count ? t`To-dos: ${count}` : t`To-dos`}
      </Button>
      {open ? (
        <Dialog open onOpenChange={setOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>
                <Trans>To-dos</Trans>
              </DialogTitle>
              <DialogDescription className="sr-only">
                <Trans>What your bots need you to do.</Trans>
              </DialogDescription>
            </DialogHeader>
            {message ? (
              <p role="alert" className="text-sm text-warning">
                {message}
              </p>
            ) : null}
            <div className="max-h-[60vh] space-y-3 overflow-y-auto text-sm">
              {[...groups].map(([groupId, items]) => {
                const counted = items.filter((todo) => todo.status !== "retired");
                const done = counted.filter(
                  (todo) => todo.status === "verified" || todo.status === "confirmed",
                ).length;
                const total = counted.length;
                const active = items.filter((todo) => !FINISHED.includes(todo.status));
                const finished = items.filter((todo) => FINISHED.includes(todo.status));
                const finishedCount = finished.length;
                const { botName, groupTitle } = items[0]!;
                const foldKey = `done:${groupId}`;
                const showFinished = expanded.has(foldKey);
                return (
                  <section
                    key={groupId}
                    data-todo-group={groupId}
                    aria-label={groupTitle}
                    className="rounded-md border px-2 py-1.5"
                  >
                    <header className="flex items-center gap-2 px-1 py-1 text-xs">
                      <p className="min-w-0 flex-1 truncate" title={groupTitle}>
                        <span className="font-medium">{botName}</span>
                        <span className="text-muted-foreground"> · {clip(groupTitle)}</span>
                      </p>
                      <span data-testid="todo-progress" className="shrink-0 tabular-nums">
                        {done}/{total}
                      </span>
                      <span
                        data-testid="todo-unblocks"
                        className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-muted-foreground"
                      >
                        {t`unblocks ${botName}`}
                      </span>
                    </header>
                    <ul>{active.map(item)}</ul>
                    {finishedCount ? (
                      <>
                        <button
                          type="button"
                          aria-expanded={showFinished}
                          onClick={() => toggle(foldKey)}
                          className="w-full px-1 py-1 text-start text-xs text-muted-foreground hover:text-foreground"
                        >
                          {t`Done (${finishedCount})`} {showFinished ? "▾" : "▸"}
                        </button>
                        {showFinished ? <ul>{finished.map(item)}</ul> : null}
                      </>
                    ) : null}
                  </section>
                );
              })}
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

/** When the bot last checked, or when the user asked it to; expanded view only. */
function Timestamp({ todo }: { todo: UserTodo }) {
  const { t, i18n } = useLingui();
  const format = (iso: string) =>
    i18n.date(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const checkedAt = todo.checkedAt ? format(todo.checkedAt) : null;
  const requestedAt = todo.checkRequestedAt ? format(todo.checkRequestedAt) : null;
  if (checkedAt) return <p className="text-muted-foreground">{t`Checked ${checkedAt}`}</p>;
  if (requestedAt) {
    return <p className="text-muted-foreground">{t`Check requested ${requestedAt}`}</p>;
  }
  return null;
}
