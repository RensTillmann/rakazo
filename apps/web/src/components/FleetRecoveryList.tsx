import { Trans, useLingui } from "@lingui/react/macro";
import type {
  MaintenanceRecoveryCommand,
  MaintenanceRecoveryItem,
  MaintenanceRecoveryResult,
} from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useCallback, useEffect, useState } from "react";
import { newClientId } from "../lib/client-id";
import { readFleetRecovery, settleFleetRecovery } from "../lib/rpc";

/**
 * Unfinished operations behind "Pausing"/"Needs attention". Settling records what evidence (or
 * the owner's own check) shows happened; it never resumes, retries or undoes work.
 */
export function FleetRecoveryList({
  spaceId,
  version,
  onSettled,
}: {
  spaceId: string | null;
  version: number;
  onSettled: () => void;
}) {
  const { t } = useLingui();
  const [items, setItems] = useState<MaintenanceRecoveryItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<"completed" | "failed" | null>(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      setItems((await readFleetRecovery(spaceId)).items);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [spaceId]);
  useEffect(() => {
    void load();
  }, [load, version]);

  function resultText(result: MaintenanceRecoveryResult): string {
    switch (result.outcome) {
      case "settled":
        return t`Recorded. It is now ${result.status}.`;
      case "replayed":
        return t`Already recorded.`;
      case "changed":
        return t`It changed meanwhile (now ${result.status}); nothing was overwritten.`;
      default:
        return result.reason ?? t`Not recorded.`;
    }
  }

  async function settle(command: MaintenanceRecoveryCommand) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      setMessage(resultText(await settleFleetRecovery(spaceId, command)));
      setVerifying(null);
      setOutcome(null);
      setNote("");
    } catch {
      setMessage(t`Outcome unknown. The list below shows the current state.`);
    } finally {
      setBusy(false);
      await load();
      onSettled();
    }
  }

  if (failed && !items)
    return (
      <p className="text-warning">
        <Trans>Unfinished operations unavailable.</Trans>
      </p>
    );
  if (!items)
    return (
      <p className="text-muted-foreground">
        <Trans>Loading unfinished operations…</Trans>
      </p>
    );
  if (items.length === 0) return null;

  const stateLabel = (item: MaintenanceRecoveryItem) =>
    item.state === "draining"
      ? t`Finishing on its own`
      : item.state === "settleable"
        ? t`Evidence found`
        : t`Outcome unknown`;

  return (
    <section aria-label={t`Unfinished operations`} className="space-y-2">
      <h3 className="font-medium">
        <Trans>Unfinished operations</Trans>
      </h3>
      {message ? (
        <p role="status" className="text-warning">
          {message}
        </p>
      ) : null}
      <ul className="space-y-2">
        {items.map((item) => (
          <li
            key={`${item.kind}:${item.id}`}
            className="space-y-1 rounded-md border border-border p-2"
          >
            <p>
              <span className="font-medium">{item.operation}</span>
              {item.bot ? <> · {item.bot}</> : null} · {item.status} ·{" "}
              <span>{stateLabel(item)}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {item.kind} {item.id}
              {item.runId && item.runId !== item.id ? (
                <>
                  {" "}
                  · <Trans>run</Trans> {item.runId} ({item.runStatus})
                </>
              ) : null}
              {item.startedAt ? (
                <>
                  {" "}
                  · <Trans>started</Trans> {item.startedAt}
                </>
              ) : null}
            </p>
            <p>{item.evidence}</p>
            {item.proposed ? (
              <div className="space-y-1">
                <p>
                  <Trans>Evidence:</Trans> {item.proposed.basis}
                </p>
                {item.kind === "attempt" || item.kind === "effect" ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void settle({
                        requestId: newClientId(),
                        basis: "evidence",
                        kind: item.kind as "attempt" | "effect",
                        id: item.id,
                        expectedStatus: item.status,
                      })
                    }
                  >
                    <Trans>Record as {item.proposed.status}</Trans>
                  </Button>
                ) : null}
              </div>
            ) : null}
            {item.missing ? (
              <p className="text-muted-foreground">
                <Trans>Missing:</Trans> {item.missing}
              </p>
            ) : null}
            {item.ownerVerifiable && item.kind === "effect" ? (
              verifying === item.id ? (
                <div className="space-y-2 rounded-md border border-warning p-2">
                  <p>
                    <Trans>
                      Record what you verified at the destination. This does not resume or retry
                      anything.
                    </Trans>
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant={outcome === "completed" ? "default" : "outline"}
                      disabled={busy}
                      onClick={() => setOutcome("completed")}
                    >
                      <Trans>It took effect</Trans>
                    </Button>
                    <Button
                      size="sm"
                      variant={outcome === "failed" ? "default" : "outline"}
                      disabled={busy}
                      onClick={() => setOutcome("failed")}
                    >
                      <Trans>It did not take effect</Trans>
                    </Button>
                  </div>
                  <label className="block space-y-1">
                    <span>
                      <Trans>What did you check?</Trans>
                    </span>
                    <textarea
                      className="w-full rounded-md border border-border bg-background p-2"
                      rows={2}
                      maxLength={2000}
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={busy || !outcome || note.trim().length < 10}
                      onClick={() =>
                        outcome &&
                        void settle({
                          requestId: newClientId(),
                          basis: "owner-verified",
                          kind: "effect",
                          id: item.id,
                          expectedStatus: item.status,
                          outcome,
                          note,
                        })
                      }
                    >
                      <Trans>Record my check</Trans>
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setVerifying(null)}
                    >
                      <Trans>Cancel</Trans>
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setVerifying(item.id);
                    setOutcome(null);
                    setNote("");
                  }}
                >
                  <Trans>I checked it…</Trans>
                </Button>
              )
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
