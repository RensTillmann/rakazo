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

const ACTIONABLE: readonly UserTodoStatus[] = ACTIONABLE_USER_TODO_STATUSES;
/** Statuses whose box the user can tick (again): `checking` waits on the bot instead. */
const TICKABLE: readonly UserTodoStatus[] = ["open", "remaining", "unavailable"];

/** Header control for the user's manual prerequisites; hidden until a bot hands one over. */
export function TodosControl() {
  const { t } = useLingui();
  const resource = useVisibleResource(() => rpc.todos.list(), { key: "todos" });
  const [open, setOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
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

  /** Ticking a box asks the bot to verify (automatic) or records the user's word (manual). */
  async function tick(todo: UserTodo) {
    if (sending.current) return;
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

  function statusLabel(todo: UserTodo) {
    const detail = todo.statusDetail;
    switch (todo.status) {
      case "open":
        return todo.verification === "automatic"
          ? t`Tick when done; the bot checks it.`
          : t`Tick when you've done it.`;
      case "checking":
        return t`Checking…`;
      case "verified":
        return t`Verified`;
      case "remaining":
        return detail ? t`Still to do: ${detail}` : t`Still to do`;
      case "unavailable":
        return detail ? t`Couldn't check: ${detail}` : t`Couldn't check`;
      case "confirmed":
        return t`Confirmed by you`;
      case "retired":
        return detail ? t`No longer needed: ${detail}` : t`No longer needed`;
    }
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
              <DialogDescription>
                <Trans>Steps your bots need you to do yourself.</Trans>
              </DialogDescription>
            </DialogHeader>
            {message ? (
              <p role="alert" className="text-sm text-warning">
                {message}
              </p>
            ) : null}
            <div className="max-h-[60vh] space-y-4 overflow-y-auto text-sm">
              {[...groups].map(([groupId, items]) => {
                const counted = items.filter((todo) => todo.status !== "retired");
                const done = counted.filter(
                  (todo) => todo.status === "verified" || todo.status === "confirmed",
                ).length;
                const total = counted.length;
                const botName = items[0]!.botName;
                return (
                  <section
                    key={groupId}
                    data-todo-group={groupId}
                    aria-label={items[0]!.groupTitle}
                    className="space-y-2 rounded-md border p-3"
                  >
                    <header>
                      <p className="whitespace-pre-wrap font-medium">{items[0]!.groupTitle}</p>
                      <p className="text-xs text-muted-foreground">
                        {botName} · {t`${done} of ${total} done`}
                      </p>
                    </header>
                    <ul className="space-y-3">
                      {items.map((todo) => {
                        const pending = todo.id === pendingId || todo.status === "checking";
                        const checked = todo.status === "verified" || todo.status === "confirmed";
                        const tickable = TICKABLE.includes(todo.status) && pendingId === null;
                        return (
                          <li key={todo.id} data-todo-id={todo.id} className="flex gap-2.5">
                            <span className="relative mt-0.5 grid size-5 shrink-0 place-items-center">
                              <input
                                type="checkbox"
                                aria-label={todo.title}
                                aria-busy={pending}
                                checked={checked}
                                // Pending reads as "mixed" until the bot or the user settles it.
                                ref={(element) => {
                                  if (element) element.indeterminate = pending;
                                }}
                                disabled={pending || !tickable}
                                onChange={() => void tick(todo)}
                                className={`size-4 accent-primary ${checked ? "" : "disabled:opacity-60"} ${pending ? "opacity-0" : ""}`}
                              />
                              {pending ? (
                                <LoaderCircle
                                  aria-hidden
                                  className="pointer-events-none absolute size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
                                />
                              ) : null}
                            </span>
                            <div className="min-w-0 flex-1 space-y-1">
                              <p
                                className={`font-medium ${todo.status === "retired" ? "text-muted-foreground line-through" : ""}`}
                              >
                                {todo.title}
                              </p>
                              <p className="whitespace-pre-wrap">{todo.steps}</p>
                              <div role="status" className="text-muted-foreground">
                                <p
                                  className={`whitespace-pre-wrap ${checked ? "text-success" : ""}`}
                                >
                                  {checked ? "✓ " : ""}
                                  {statusLabel(todo)}
                                </p>
                                {todo.status === "verified" && todo.evidence ? (
                                  <p className="mt-1 whitespace-pre-wrap">{todo.evidence}</p>
                                ) : null}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
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
