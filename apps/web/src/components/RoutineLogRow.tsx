import { useLingui } from "@lingui/react/macro";
import { formatMessageTime } from "@rakazo/core";
import { cn } from "@rakazo/ui-web";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import type { RoutineLogFold } from "../lib/routine-log-folds";

/**
 * Fleet patch: a routine run's own output folded to one muted line in the owner's chat. Clicking it
 * shows the original messages in place; clicking again folds them.
 */
export function RoutineLogRow({
  routineName,
  createdAt,
  expanded,
  onToggle,
}: {
  routineName: string;
  createdAt: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t, i18n } = useLingui();
  const time = formatMessageTime(createdAt, i18n.locale || "en");
  return (
    <button
      type="button"
      data-testid="routine-log-row"
      aria-expanded={expanded}
      onClick={onToggle}
      className="flex max-w-full items-center gap-1.5 self-start rounded-lg px-2 py-1 text-start text-[12.5px] text-muted-foreground hover:bg-muted hover:text-foreground/75"
    >
      <ChevronRight
        aria-hidden
        className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")}
      />
      <span className="min-w-0 truncate">{t`Routine log · ${routineName} · ${time}`}</span>
    </button>
  );
}

/**
 * One transcript message under its routine-log fold: unfolded messages render as they are; a
 * folded run shows only its row (drawn by the first message); an expanded run keeps the row on top
 * of the original rendering so it can fold again.
 */
export function RoutineLogFoldable({
  fold,
  messageId,
  expanded,
  onToggle,
  children,
}: {
  fold: RoutineLogFold | undefined;
  messageId: string;
  expanded: boolean;
  onToggle: (leaderId: string) => void;
  children: ReactNode;
}) {
  if (!fold) return children;
  const leader = fold.leaderId === messageId;
  const row = leader ? (
    <RoutineLogRow
      routineName={fold.routineName}
      createdAt={fold.createdAt}
      expanded={expanded}
      onToggle={() => onToggle(fold.leaderId)}
    />
  ) : null;
  if (!expanded) return row;
  return (
    <>
      {row}
      {children}
    </>
  );
}
