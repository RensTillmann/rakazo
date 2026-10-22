import { Trans, useLingui } from "@lingui/react/macro";
import type { MaintenanceCommand } from "@rakazo/contracts";
import {
  isWaitingAuthorityReason,
  maintenanceAttentionSentence,
  maintenanceIssueCode,
} from "@rakazo/core";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@rakazo/ui-web";
import { useEffect, useRef, useState } from "react";
import { newClientId } from "../lib/client-id";
import { FleetMaintenanceError, readFleetMaintenance, sendFleetMaintenance } from "../lib/rpc";
import { useVisibleResource } from "../lib/use-visible-resource";
import { FleetRecoveryList } from "./FleetRecoveryList";

const MAINTENANCE_CHANGED_EVENT = "rakazo:maintenance-changed";

/**
 * What needs attention, folded under a count: held runs grouped by reason and the status's own
 * issues, each code with its plain sentence.
 */
export function AttentionIssues({ issues }: { issues: readonly string[] }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const parsed = issues.map(maintenanceIssueCode);
  const heldRuns = (waiting: boolean) =>
    new Set(
      parsed.flatMap((issue) =>
        issue.runId && isWaitingAuthorityReason(issue.code) === waiting ? [issue.runId] : [],
      ),
    ).size;
  // Waiting on the user's answer to a card is not attention: counted on its own.
  const runs = heldRuns(false);
  const waiting = heldRuns(true);
  // The generic "some runs" issue is said by the run count itself.
  const others = parsed.filter(
    (issue) =>
      !issue.runId && !(runs + waiting > 0 && issue.code === "continuation-needs-attention"),
  );
  const counts = new Map<string, number>();
  for (const issue of parsed) if (issue.runId) counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  const rows = [
    ...[...counts].map(([code, count]) => ({ code, count })),
    ...others.map((issue) => ({ code: issue.code, count: 0 })),
  ];
  const summary = [
    runs === 1 ? t`1 run needs attention` : runs > 1 ? t`${runs} runs need attention` : null,
    waiting === 1
      ? t`1 run waiting on your answer`
      : waiting > 1
        ? t`${waiting} runs waiting on your answer`
        : null,
    others.length === 1
      ? t`1 issue`
      : others.length > 1
        ? t`${others.length} issues`
        : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="text-start underline-offset-2 hover:underline"
      >
        {summary} · {open ? t`hide` : t`show`}
      </button>
      {open ? (
        <ul data-testid="fleet-attention-codes" className="mt-1 list-disc space-y-1 ps-5">
          {rows.map(({ code, count }) => (
            <li key={code}>
              <code className="text-xs">{code}</code>
              {count > 1 ? ` ×${count}` : ""}: {maintenanceAttentionSentence(code)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Mount within the shell's user/space boundary; server authorization owns visibility. */
export function FleetPauseControls({ spaceId }: { spaceId: string | null }) {
  const { t } = useLingui();
  const resource = useVisibleResource(() => readFleetMaintenance(spaceId), {
    key: `maintenance:${spaceId ?? "primary"}`,
    event: MAINTENANCE_CHANGED_EVENT,
  });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [retry, setRetry] = useState<MaintenanceCommand | null>(null);
  const [confirmRevision, setConfirmRevision] = useState<number | null>(null);
  const [recoveryVersion, setRecoveryVersion] = useState(0);
  const sending = useRef(false);
  const snapshot = resource.data;
  const unauthorized = denied || (resource.error instanceof FleetMaintenanceError &&
    (resource.error.status === 401 || resource.error.status === 403));

  useEffect(() => {
    if (unauthorized) return;
    let disposed = false;
    let timer: number;
    async function poll() {
      if (document.visibilityState === "visible") await resource.refresh();
      if (!disposed) timer = window.setTimeout(() => void poll(), 5_000);
    }
    timer = window.setTimeout(() => void poll(), 5_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void resource.refresh();
    };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [resource.refresh, unauthorized]);

  async function submit(command: MaintenanceCommand) {
    if (sending.current || unauthorized) return;
    sending.current = true;
    setBusy(true);
    setMessage(null);
    setConfirmRevision(null);
    try {
      await sendFleetMaintenance(spaceId, command);
      setRetry(null);
      await resource.refresh();
      // Other tabs read on this event; broadcasting never issues a mutation.
      try {
        window.localStorage.setItem(MAINTENANCE_CHANGED_EVENT, newClientId());
      } catch {
        // Storage is optional; visible polling still refreshes every tab.
      }
    } catch (error) {
      if (error instanceof FleetMaintenanceError && (error.status === 401 || error.status === 403)) {
        setDenied(true);
        setRetry(null);
      } else if (error instanceof FleetMaintenanceError && error.status < 500) {
        setRetry(null);
        setMessage(error.status === 409
          ? t`Fleet changed. Review the refreshed status before choosing again.`
          : t`Request rejected. Refresh status before choosing again.`);
        await resource.refresh();
      } else {
        // A failed response does not prove the transaction failed. Reuse the entire command.
        setRetry(command);
        setMessage(t`Outcome unknown. Refresh status or retry the same request.`);
        await resource.refresh();
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  function choose(action: MaintenanceCommand["action"]) {
    if (!snapshot || resource.error || busy || retry || unauthorized) return;
    if (action === "force-stop" && confirmRevision !== snapshot.state.revision) {
      setConfirmRevision(null);
      setMessage(t`Fleet changed. Review the refreshed status before choosing again.`);
      return;
    }
    void submit({ requestId: newClientId(), action, expectedRevision: snapshot.state.revision });
  }

  if (unauthorized) return null;
  if (!snapshot) {
    return (
      <span role="status" className="text-xs text-muted-foreground">
        {resource.error ? t`Fleet status unavailable` : t`Checking Fleet status…`}
      </span>
    );
  }

  const phase = snapshot.status.phase === "running" ? t`Running`
    : snapshot.status.phase === "pausing" ? t`Pausing`
      : snapshot.status.phase === "paused" ? t`Paused` : t`Needs attention`;
  const disabled = busy || Boolean(resource.error) || Boolean(retry);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="app-no-drag"
        onClick={() => setOpen(true)}
      >
        {resource.error ? t`Fleet: Status unavailable` : retry ? t`Fleet: Outcome unknown` : t`Fleet: ${phase}`}
      </Button>
      {open ? (
        <Dialog open onOpenChange={(next) => {
          if (!busy) {
            setOpen(next);
            if (!next) setConfirmRevision(null);
          }
        }}>
          <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
            <DialogHeader>
              <DialogTitle><Trans>Fleet control</Trans></DialogTitle>
              <DialogDescription>
                <Trans>Pause new Fleet work while active runs reach a safe checkpoint. Resume is always manual.</Trans>
              </DialogDescription>
            </DialogHeader>
            {/* The body scrolls; the header and the action footer stay in view at any zoom. */}
            <div
              data-testid="fleet-control-body"
              className="-mx-1 min-h-0 flex-1 space-y-3 overflow-y-auto px-1"
            >
            <div role="status" aria-live="polite" className="space-y-2 text-sm">
              {resource.error ? (
                <p className="text-warning"><Trans>Status unavailable. Last known state is stale; new actions are disabled.</Trans></p>
              ) : null}
              <p>{resource.error ? t`Last known: ${phase}` : phase}</p>
              {snapshot.state.active || snapshot.status.phase === "needs_attention" ? (
                <>
                  <dl className="space-y-1">
                    <div><dt className="inline"><Trans>Active runs:</Trans></dt> <dd className="inline">{snapshot.status.activeRuns}</dd></div>
                    <div><dt className="inline"><Trans>Active effects:</Trans></dt> <dd className="inline">{snapshot.status.activeEffects}</dd></div>
                    <div><dt className="inline"><Trans>Queued/held runs:</Trans></dt> <dd className="inline">{snapshot.status.pendingRuns}</dd></div>
                  </dl>
                  {snapshot.status.issues.length ? (
                    <AttentionIssues issues={snapshot.status.issues} />
                  ) : null}
                </>
              ) : null}
            </div>
            {snapshot.status.activeRuns || snapshot.status.activeEffects ||
              snapshot.status.phase === "needs_attention" ? (
              <div className="text-sm">
                <FleetRecoveryList
                  spaceId={spaceId}
                  version={recoveryVersion}
                  onSettled={() => void resource.refresh()}
                />
              </div>
            ) : null}
            {message ? <p role="alert" className="text-sm text-warning">{message}</p> : null}
            {confirmRevision !== null ? (
              <div className="space-y-3 rounded-md border border-destructive p-3">
                <p className="text-sm"><Trans>Force stop interrupts active work instead of waiting for a safe checkpoint. Progress may be incomplete. Already-started effects cannot be undone and their outcome may remain unknown. Fleet will be paused until you resume it.</Trans></p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="destructive" disabled={disabled} onClick={() => choose("force-stop")}>
                    <Trans>Confirm force stop</Trans>
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => setConfirmRevision(null)}>
                    <Trans>Cancel</Trans>
                  </Button>
                </div>
              </div>
            ) : null}
            </div>
            <DialogFooter className="shrink-0 flex-wrap gap-2">
              <Button variant="outline" disabled={busy} onClick={() => {
                setRecoveryVersion((value) => value + 1);
                void resource.refresh();
              }}>
                <Trans>Refresh status</Trans>
              </Button>
              {retry ? (
                <Button disabled={busy} onClick={() => void submit(retry)}><Trans>Retry request</Trans></Button>
              ) : (
                <>
                  {snapshot.state.active ? (
                    <Button disabled={disabled} onClick={() => choose("resume")}><Trans>Resume Fleet</Trans></Button>
                  ) : (
                    <Button disabled={disabled} onClick={() => choose("enter")}><Trans>Pause Fleet</Trans></Button>
                  )}
                  {confirmRevision === null ? (
                    <Button variant="outline" disabled={disabled} onClick={() => setConfirmRevision(snapshot.state.revision)}>
                      <Trans>Force stop…</Trans>
                    </Button>
                  ) : null}
                </>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
