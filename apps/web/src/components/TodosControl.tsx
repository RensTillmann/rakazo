import { Trans, useLingui } from "@lingui/react/macro";
import { ReferenceLinksContext, referenceLinkHref } from "@rakazo/chat-ui/web";
import {
  ACTIONABLE_USER_TODO_STATUSES,
  type UserTodo,
  type UserTodoStatus,
} from "@rakazo/contracts";
import { Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import { Ban, ListChecks, LoaderCircle } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { messageJumpLocation, QUESTION_JUMP_SOURCE } from "../lib/message-jump";
import { rpc } from "../lib/rpc";
import { useVisibleResource } from "../lib/use-visible-resource";

const FAST_POLL_MS = 5_000;
const SLOW_POLL_MS = 60_000;
/** After a tick, nothing is sent until this window passes without Undo. */
export const TODO_UNDO_MS = 5_000;
/** Titles longer than this are clipped; the full text stays in the tooltip. */
const SHORT_TEXT = 40;
/** Circumference of the countdown ring (r = 4.5). */
const RING = 2 * Math.PI * 4.5;

const ACTIONABLE: readonly UserTodoStatus[] = ACTIONABLE_USER_TODO_STATUSES;
/** Unticked boxes the user can tick: `checking` waits on the bot instead. */
const TICKABLE: readonly UserTodoStatus[] = ["open", "remaining", "unavailable"];
const FINISHED: readonly UserTodoStatus[] = ["verified", "confirmed", "retired"];
const EMPTY: UserTodo[] = [];
const CHIP = "rounded-full bg-background px-2 py-0.5 text-muted-foreground";

/** A tracker issue's link through the deployment's case link setting; none without it. */
function caseHref(template: string | null | undefined, issue: number) {
  return template ? referenceLinkHref(template, String(issue)) : undefined;
}

function clip(text: string) {
  return text.length > SHORT_TEXT ? `${text.slice(0, SHORT_TEXT - 1).trimEnd()}…` : text;
}

function withId(set: ReadonlySet<string>, id: string, present: boolean): ReadonlySet<string> {
  if (set.has(id) === present) return set;
  const next = new Set(set);
  if (present) next.add(id);
  else next.delete(id);
  return next;
}

/** "N/M": verified or confirmed out of everything still counted (retired excluded). */
function progress(items: readonly UserTodo[]) {
  const counted = items.filter((todo) => todo.status !== "retired");
  const done = counted.filter(
    (todo) => todo.status === "verified" || todo.status === "confirmed",
  ).length;
  return `${done}/${counted.length}`;
}

type UserTodos = {
  /** In the server's order: blocking cards first, then priority, then age; never re-sorted here. */
  todos: UserTodo[];
  /** Ticked items still inside their undo window; nothing has been sent for them. */
  countdown: ReadonlySet<string>;
  /** Items whose check or confirm request is in flight. */
  requesting: ReadonlySet<string>;
  message: string | null;
  tick: (todo: UserTodo) => void;
  undo: (todoId: string) => void;
  /** Poll quickly while the caller is showing the list; returns the release. */
  watch: () => () => void;
  feedback: ((todo: UserTodo | null) => void) | null;
};

const UserTodosContext = createContext<UserTodos | null>(null);

/** One to-dos fetch and poll for the shell: the sidebar panel and every answered card share it. */
export function UserTodosProvider({
  scope,
  enabled,
  onFeedback,
  children,
}: {
  scope: string;
  enabled: boolean;
  onFeedback?: (todo: UserTodo | null) => void;
  children: ReactNode;
}) {
  const { t } = useLingui();
  const resource = useVisibleResource(
    () => (enabled ? rpc.todos.list() : Promise.resolve({ todos: EMPTY })),
    { key: `todos:${enabled ? scope : "off"}` },
  );
  const { refresh } = resource;
  const todos = resource.data?.todos ?? EMPTY;
  const [countdown, setCountdown] = useState<ReadonlySet<string>>(() => new Set());
  const [requesting, setRequesting] = useState<ReadonlySet<string>>(() => new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [watchers, setWatchers] = useState(0);
  const timers = useRef(new Map<string, number>());

  // Leaving the scope (or the page) drops every undo window unsent.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
      setCountdown(new Set());
    };
  }, [scope, enabled]);

  const fast =
    watchers > 0 || requesting.size > 0 || todos.some((todo) => todo.status === "checking");
  useEffect(() => {
    let disposed = false;
    let timer: number;
    const interval = fast ? FAST_POLL_MS : SLOW_POLL_MS;
    async function poll() {
      if (document.visibilityState === "visible") await refresh();
      if (!disposed) timer = window.setTimeout(() => void poll(), interval);
    }
    timer = window.setTimeout(() => void poll(), interval);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [refresh, fast]);

  const send = useCallback(
    async (todo: UserTodo) => {
      setRequesting((current) => withId(current, todo.id, true));
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
        await refresh();
        setRequesting((current) => withId(current, todo.id, false));
      }
    },
    [refresh, t],
  );

  /** Ticking means "I did this"; it is sent only after the undo window, with the revision seen now. */
  const tick = useCallback(
    (todo: UserTodo) => {
      if (!TICKABLE.includes(todo.status) || timers.current.has(todo.id)) return;
      setMessage(null);
      setCountdown((current) => withId(current, todo.id, true));
      timers.current.set(
        todo.id,
        window.setTimeout(() => {
          timers.current.delete(todo.id);
          setCountdown((current) => withId(current, todo.id, false));
          void send(todo);
        }, TODO_UNDO_MS),
      );
    },
    [send],
  );

  const undo = useCallback((todoId: string) => {
    const timer = timers.current.get(todoId);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    timers.current.delete(todoId);
    setCountdown((current) => withId(current, todoId, false));
  }, []);

  const watch = useCallback(() => {
    setWatchers((count) => count + 1);
    return () => setWatchers((count) => count - 1);
  }, []);

  const value = useMemo<UserTodos>(
    () => ({
      todos,
      countdown,
      requesting,
      message,
      tick,
      undo,
      watch,
      feedback: onFeedback ?? null,
    }),
    [todos, countdown, requesting, message, tick, undo, watch, onFeedback],
  );
  return <UserTodosContext.Provider value={value}>{children}</UserTodosContext.Provider>;
}

type BoxState = "unchecked" | "countdown" | "checking" | "checked" | "retired";

const BOX =
  "size-4 cursor-pointer appearance-none rounded border border-input bg-background transition-colors enabled:hover:border-primary enabled:hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-default";

/** One to-do: the box is the only toggle; the title and status line open the details. */
function TodoItem({ todo }: { todo: UserTodo }) {
  const { t } = useLingui();
  const todos = useContext(UserTodosContext)!;
  const caseLinks = useContext(ReferenceLinksContext).case;
  const [open, setOpen] = useState(false);
  const counting = todos.countdown.has(todo.id);
  const requesting = todos.requesting.has(todo.id);
  const manual = todo.verification === "manual";
  // A manual tick is the user's own word, so it shows done once sent; automatic ones wait on the bot.
  const box: BoxState =
    todo.status === "retired"
      ? "retired"
      : todo.status === "verified" || todo.status === "confirmed" || (requesting && manual)
        ? "checked"
        : counting
          ? "countdown"
          : requesting || todo.status === "checking"
            ? "checking"
            : "unchecked";
  const title = todo.title;
  const detail = todo.statusDetail;
  const [line, lineTitle] =
    box === "checking"
      ? [t`checking…`, null]
      : box === "countdown" || box === "checked"
        ? [null, null]
        : todo.status === "remaining"
          ? [detail ? t`still missing: ${detail}` : t`still missing`, detail]
          : todo.status === "unavailable"
            ? [t`couldn't check — tick again to retry`, detail]
            : todo.status === "retired"
              ? [t`no longer needed`, detail]
              : [null, null];

  return (
    <li data-todo-id={todo.id} className="py-1">
      <div className="flex items-start gap-2">
        <span data-box={box} className="relative mt-0.5 grid size-5 shrink-0 place-items-center">
          {box === "retired" ? (
            <span role="img" aria-label={t`No longer needed`} className="text-muted-foreground">
              <Ban aria-hidden className="size-4" />
            </span>
          ) : (
            <>
              <input
                type="checkbox"
                // ICU treats ' as an escape, so the title is quoted with “ ” instead.
                aria-label={t`Mark “${title}” as done`}
                aria-busy={box === "checking"}
                checked={box === "checked" || box === "countdown"}
                ref={(element) => {
                  if (element) element.indeterminate = box === "checking";
                }}
                disabled={box === "checked" || box === "checking"}
                onChange={() => (box === "countdown" ? todos.undo(todo.id) : todos.tick(todo))}
                className={
                  box === "checking"
                    ? "sr-only"
                    : `${BOX} ${box === "checked" ? "border-success bg-success" : ""}`
                }
              />
              {box === "checking" ? (
                <LoaderCircle
                  aria-hidden
                  className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
                />
              ) : box === "countdown" ? (
                <svg
                  aria-hidden
                  viewBox="0 0 12 12"
                  className="pointer-events-none absolute size-3 -rotate-90 text-primary"
                >
                  <circle
                    cx="6"
                    cy="6"
                    r="4.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeDasharray={RING}
                  >
                    <animate
                      attributeName="stroke-dashoffset"
                      from="0"
                      to={String(RING)}
                      dur={`${TODO_UNDO_MS / 1000}s`}
                      fill="freeze"
                    />
                  </circle>
                </svg>
              ) : box === "checked" ? (
                <span
                  aria-hidden
                  className="pointer-events-none absolute text-[11px] leading-none text-background"
                >
                  ✓
                </span>
              ) : null}
            </>
          )}
        </span>
        <button
          type="button"
          aria-label={t`Show how`}
          aria-expanded={open}
          title={title}
          onClick={() => setOpen((value) => !value)}
          className="min-w-0 flex-1 text-start"
        >
          <span
            className={`block truncate hover:underline ${box === "retired" ? "text-muted-foreground line-through" : ""}`}
          >
            {clip(title)}
          </span>
          {line ? (
            <span
              data-testid="todo-secondary"
              title={lineTitle ?? line}
              className={`block truncate text-xs ${todo.status === "remaining" && box === "unchecked" ? "text-warning" : "text-muted-foreground"}`}
            >
              {line}
            </span>
          ) : null}
        </button>
        {counting ? (
          <button
            type="button"
            onClick={() => todos.undo(todo.id)}
            className="shrink-0 rounded-md border px-2 py-0.5 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Trans>Undo</Trans>
          </button>
        ) : null}
        {ACTIONABLE.includes(todo.status) && todo.blocks.length ? (
          <span className="flex shrink-0 flex-wrap justify-end gap-1">
            {todo.blocks.map(({ issue, label: ref }, index) => {
              const href = issue === null ? undefined : caseHref(caseLinks, issue);
              const chip = "rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive";
              return href ? (
                <a
                  key={`${index}:${ref}`}
                  data-testid="todo-blocks"
                  href={href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={`${chip} underline-offset-2 hover:underline`}
                >
                  {t`blocks ${ref}`}
                </a>
              ) : (
                <span key={`${index}:${ref}`} data-testid="todo-blocks" className={chip}>
                  {t`blocks ${ref}`}
                </span>
              );
            })}
          </span>
        ) : null}
        {box === "checked" && manual ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            <Trans>(you)</Trans>
          </span>
        ) : null}
      </div>
      {open ? <TodoDetails todo={todo} /> : null}
    </li>
  );
}

/** The opened item: why, steps, who checks it, and chips. The reason under the title is not repeated. */
function TodoDetails({ todo }: { todo: UserTodo }) {
  const { t, i18n } = useLingui();
  const feedback = useContext(UserTodosContext)?.feedback;
  const { botName, caseRef } = todo;
  const caseLinks = useContext(ReferenceLinksContext).case;
  const caseLink = caseRef === null ? undefined : caseHref(caseLinks, caseRef);
  const asked = i18n.date(new Date(todo.createdAt), { dateStyle: "medium" });
  const format = (iso: string) =>
    i18n.date(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const checkedAt = todo.checkedAt ? format(todo.checkedAt) : null;
  const requestedAt = todo.checkRequestedAt ? format(todo.checkRequestedAt) : null;
  // Evidence and timestamps stay in the tooltip, not as extra lines.
  const tooltip = [
    todo.evidence,
    checkedAt ? t`Checked ${checkedAt}` : requestedAt ? t`Check requested ${requestedAt}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div
      data-testid="todo-details"
      title={tooltip || undefined}
      className="ms-7 mt-1.5 space-y-1.5 rounded-md bg-muted/50 p-2.5 text-xs"
    >
      {todo.why ? (
        <p data-testid="todo-why" className="whitespace-pre-wrap">
          {todo.why}
        </p>
      ) : null}
      <ol className="list-decimal space-y-0.5 ps-4">
        {todo.steps
          .split("\n")
          .map((step) => step.replace(/^\s*\d+[.)]\s*/, "").trim())
          .filter(Boolean)
          .map((step, index) => (
            <li key={`${index}:${step}`}>{step}</li>
          ))}
      </ol>
      <p data-testid="todo-checker" className="text-muted-foreground">
        {todo.verification === "automatic"
          ? t`${botName} checks it when you tick the box`
          : t`You confirm this one`}
      </p>
      <div data-testid="todo-chips" className="flex flex-wrap gap-1.5">
        {caseRef === null ? null : caseLink ? (
          <a
            data-testid="todo-case"
            href={caseLink}
            target="_blank"
            rel="noreferrer noopener"
            className={`${CHIP} underline-offset-2 hover:text-foreground hover:underline`}
          >
            {t`Case ${caseRef}`}
          </a>
        ) : (
          <span data-testid="todo-case" className={CHIP}>
            {t`Case ${caseRef}`}
          </span>
        )}
        <span className={CHIP}>{t`asked ${asked}`}</span>
      </div>
      {feedback ? (
        <button
          type="button"
          onClick={() => feedback(todo)}
          className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          <Trans>Feedback to Elena</Trans>
        </button>
      ) : null}
    </div>
  );
}

function Message() {
  const message = useContext(UserTodosContext)?.message;
  return message ? (
    <p role="alert" className="text-sm text-warning">
      {message}
    </p>
  ) : null;
}

/** "<bot> · <topic>", wrapped to two lines; the full text stays in the tooltip. */
function GroupLabel({ items, className }: { items: readonly UserTodo[]; className: string }) {
  const { botName, groupTitle } = items[0]!;
  return (
    <p className={`line-clamp-2 min-w-0 flex-1 ${className}`} title={`${botName} · ${groupTitle}`}>
      <span className="font-medium">{botName}</span>
      <span className="text-muted-foreground"> · {groupTitle}</span>
    </p>
  );
}

/**
 * The card's place in its chat: the room whose thread holds it, else the bot's 1:1 chat. The shell's
 * `?m=` jump fetches the page around the card, scrolls to it and highlights it.
 */
function questionLocation(todo: UserTodo, rooms: readonly TodoRoom[]) {
  const room = rooms.find((candidate) => candidate.threadId === todo.threadId);
  return messageJumpLocation(
    room
      ? { groupId: room.id, messageId: todo.groupId }
      : { botId: todo.botId, messageId: todo.groupId },
    QUESTION_JUMP_SOURCE,
  );
}

/** A chat a to-do's card can sit in: rooms are told apart from 1:1 chats by their thread. */
export type TodoRoom = { id: string; threadId: string };

/** Every to-do, grouped by card in server order; finished ones fold into one Done row. */
function TodosPanel({ rooms, onNavigate }: { rooms: readonly TodoRoom[]; onNavigate: () => void }) {
  const { t } = useLingui();
  const context = useContext(UserTodosContext)!;
  const [showFinished, setShowFinished] = useState(false);
  const groups = new Map<string, UserTodo[]>();
  for (const todo of context.todos) {
    const group = groups.get(todo.groupId);
    if (group) group.push(todo);
    else groups.set(todo.groupId, [todo]);
  }
  const sections = [...groups].map(([groupId, items]) => ({
    groupId,
    items,
    active: items.filter((todo) => !FINISHED.includes(todo.status)),
    finished: items.filter((todo) => FINISHED.includes(todo.status)),
  }));
  const finishedCount = sections.reduce((sum, section) => sum + section.finished.length, 0);
  const feedback = context.feedback;
  return (
    <div className="space-y-2 text-sm">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 font-medium">
          <Trans>To-dos</Trans>
        </h2>
        {feedback ? (
          <button
            type="button"
            onClick={() => feedback(null)}
            className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Trans>Feedback to Elena</Trans>
          </button>
        ) : null}
      </div>
      <Message />
      <div className="max-h-[60vh] space-y-3 overflow-y-auto">
        {sections.some(({ active }) => active.length) ? null : (
          <p data-testid="todos-empty" className="px-1 py-2 text-xs text-muted-foreground">
            <Trans>Nothing waiting on you</Trans>
          </p>
        )}
        {sections.map(({ groupId, items, active }) =>
          active.length ? (
            <section
              key={groupId}
              data-todo-group={groupId}
              aria-label={items[0]!.groupTitle}
              className="rounded-md border px-2 py-1.5"
            >
              <header className="flex flex-wrap items-start gap-x-2 gap-y-0.5 px-1 py-1 text-xs">
                <GroupLabel items={items} className="" />
                <Link
                  to={questionLocation(items[0]!, rooms)}
                  onClick={onNavigate}
                  className="shrink-0 text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:order-last max-sm:basis-full"
                >
                  <Trans>Show question</Trans>
                </Link>
                <span data-testid="todo-progress" className="shrink-0 tabular-nums">
                  {progress(items)}
                </span>
              </header>
              <ul>
                {active.map((todo) => (
                  <TodoItem key={todo.id} todo={todo} />
                ))}
              </ul>
            </section>
          ) : null,
        )}
        {finishedCount ? (
          <div>
            <button
              type="button"
              aria-expanded={showFinished}
              onClick={() => setShowFinished((value) => !value)}
              className="w-full px-1 py-1 text-start text-xs text-muted-foreground hover:text-foreground"
            >
              {t`Done (${finishedCount})`} {showFinished ? "▾" : "▸"}
            </button>
            {showFinished ? (
              <div data-testid="todo-done" className="space-y-2 px-1">
                {sections.map(({ groupId, items, finished }) =>
                  finished.length ? (
                    <section
                      key={groupId}
                      data-todo-group={groupId}
                      aria-label={items[0]!.groupTitle}
                    >
                      <GroupLabel items={items} className="text-xs" />
                      <ul>
                        {finished.map((todo) => (
                          <TodoItem key={todo.id} todo={todo} />
                        ))}
                      </ul>
                    </section>
                  ) : null,
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Sidebar entry above the profile row, always shown; the badge counts open to-dos. `rooms` routes a
 * room card's "Show question" to the room.
 */
export function TodosSidebarButton({ rail, rooms }: { rail: boolean; rooms: readonly TodoRoom[] }) {
  const { t } = useLingui();
  const context = useContext(UserTodosContext);
  const [open, setOpen] = useState(false);
  const watch = context?.watch;
  useEffect(() => (open && watch ? watch() : undefined), [open, watch]);
  // Always shown, also with nothing to do or when the list failed to load.
  if (!context) return null;
  const count = context.todos.filter((todo) => ACTIONABLE.includes(todo.status)).length;
  const label = count ? t`To-dos, ${count} open` : t`To-dos`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        data-testid="todos-sidebar-button"
        aria-label={label}
        title={rail ? label : undefined}
        className={`mb-1 flex items-center gap-3 rounded-xl py-2 hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          rail ? "mx-auto px-2" : "mx-3 px-2.5"
        }`}
      >
        <span className="relative grid h-[30px] w-[30px] place-items-center rounded-lg bg-accent text-foreground/80">
          <ListChecks size={15} strokeWidth={1.8} aria-hidden />
          {count ? (
            <span
              data-testid="todos-badge"
              className="absolute -end-1.5 -top-1.5 min-w-4 rounded-full bg-primary px-1 text-center text-[10px] font-medium leading-4 tabular-nums text-primary-foreground"
            >
              {count}
            </span>
          ) : null}
        </span>
        <span className={rail ? "sr-only" : "text-[14px] font-medium text-foreground/90"}>
          <Trans>To-dos</Trans>
        </span>
      </PopoverTrigger>
      {open ? (
        <PopoverContent
          side="right"
          align="end"
          sideOffset={8}
          className="w-[min(28rem,calc(100vw-2rem))] p-3"
        >
          <TodosPanel rooms={rooms} onNavigate={() => setOpen(false)} />
        </PopoverContent>
      ) : null}
    </Popover>
  );
}

/** The to-dos an answered card handed over, as the same rows as the sidebar panel. */
export function TodoChecklist({ messageId }: { messageId: string }) {
  const { t } = useLingui();
  const context = useContext(UserTodosContext);
  const items = context?.todos.filter((todo) => todo.groupId === messageId) ?? EMPTY;
  if (!items.length) return null;
  const done = progress(items);
  return (
    <div
      data-testid="todo-checklist"
      className="mt-3 rounded-lg border px-2 py-1.5 text-sm font-normal text-foreground"
    >
      <p className="px-1 text-xs text-muted-foreground">{t`To-dos ${done}`}</p>
      <Message />
      <ul>
        {items.map((todo) => (
          <TodoItem key={todo.id} todo={todo} />
        ))}
      </ul>
    </div>
  );
}
