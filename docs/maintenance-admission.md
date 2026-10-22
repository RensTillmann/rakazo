# Global graceful Fleet pause

The deployment owner can pause all bot work from **Fleet: Running** in the web chat header. This is deployment-global, not a selected-space or per-bot switch. Josy, Elena and repair work have no exemption. Implementation, review and deployment approval remain separate; updating source does not update running services.

## Operator controls

- **Pause Fleet** stops new admission. Active work drains to a safe boundary and saves its continuation; ordinary pause does not kill a browser, computer or process.
- **Resume Fleet** is an explicit owner action. It removes only the global pause, then work is revalidated. It does not enable inactive routines, clear usage/dependency/deadline holds, grant access or revive denied approvals.
- **Force stop…** requires a separate confirmation. It interrupts work rather than waiting for a checkpoint, leaves Fleet paused, and cannot undo an already-started external action.
- There is no expiry, automatic resume, startup bypass or repair-bot bypass.

| Status | Meaning |
| --- | --- |
| Running | Global admission is open; independent holds can still prevent work. |
| Pausing | The global fence is active, but runs or effects have not drained. |
| Paused | No counted active run/effect remains. Queued input can still be waiting. |
| Needs attention | A continuation, cancellation or external outcome cannot be safely established. It is not silently treated as completed. |
| Status unavailable | The last reading is stale or unavailable. New control actions are disabled. |

The dialog shows active runs, active effects and queued/held runs. Visible tabs refresh every five seconds and on focus; a reload is not required. An outage preserves the last reading as explicitly stale, not as proof of quiescence.

If a command's response is lost, use **Retry request**. It resends the identical command identity and revision. Do not manufacture a new force-stop request just to retry: that would be a new instruction and could affect work submitted afterward. A stale-revision conflict requires reviewing fresh state before choosing a new action.

## Work and effect boundaries

Schedules, webhooks, direct/room messages, delegated work, approval continuations, recovery and queued dispatch retain their durable input identities while admission is closed. Queued work is not reported as actively executing. New model/tool/provider operations are fenced; already-started operations may finish and are reconciled.

A checkpoint preserves the runtime continuation, transcripts, steering, exact tool/effect identity and relevant resource/approval bindings. Resume does not regenerate an interrupted tool call with new arguments or a new delivery identity. Approved replay still requires the original approval; a maintenance transition is not authorization.

Uncertain outward deliveries are not blindly resent. Submitted media/cloud work can be reconciled without starting replacement work. Semantic memory recall and asynchronous memory writes count as Fleet activity; a pause between banks retains completed results for the same invocation.

Fleet card actions retain their exact admitted question/answer and per-stage receipts. Completed label/comment/memory stages are reused, and local trust changes commit atomically with their receipt. A changed case or a lost provider acknowledgment does not authorize replaying an uncertain action.

Force-stop acknowledgment requires actual drain evidence. A lease expiring, another worker marking a run cancelled, a local abort signal, or an unknown computer is not proof that a remote attempt stopped. Unresolved attempts/effects remain visible. Held items are scanned without allowing an unresolved first page to starve later work.

Ambient room-response decisions retain their operation and batch identity across lease expiry and bridge restart. Another instance cannot judge the same conversation while that operation is unresolved. Only confirmed producer drain settles it; Force stop and Resume do not manufacture a completion receipt. An orphan without drain evidence remains visible for investigation.

## Unfinished operations

Under the counts, the dialog lists every unfinished operation once: runs, attempts, external effects, Fleet service effects and other in-flight operations. Each shows its producer bot, run, start time, current status and one of three states:

| State | Meaning | Owner action |
| --- | --- | --- |
| Finishing on its own | Its run still holds a live lease (or the operation is in progress). | None; it settles itself. |
| Evidence found | The run's own records decide the outcome. | **Record as …** applies exactly that outcome. |
| Outcome unknown | Nothing recorded decides it. **Missing:** names the evidence that would. | **I checked it…** for an effect whose run ended: choose *It took effect* or *It did not take effect* and say what you checked. |

Each item also says who answers for it and whether you have to act. **Case <n>** appears when the run's to-dos name the case, or one of its own cards starts with "Case <n>" (any letter case, also after "URGENT · ", e.g. "Case 383 · …" or "case 78: …"); a case mentioned later in the text never counts. **Follow-up:** names the accountable coordinator: for a case item, the run's bot when it coordinates cases itself, else the first of `RAKAZO_CASE_COORDINATOR_BOTS`; for anything else, the Fleet coordinator (`RAKAZO_FLEET_COORDINATOR_BOT`, else `RAKAZO_FLAG_BOT`). **Needs you** marks the items only the owner can settle (evidence to apply, or a destination to check); the rest settle themselves or are the coordinator's to chase, and show nothing extra. Coordinators are matched by bot id, else name, among the owner's bots, the same way to-do checks are routed. The API carries them as `caseRef`, `coordinator` and `userActionNeeded`.

An approval that ended `invalidated` (its source question was withdrawn, stopped, replaced or expired) is final: like denied or completed effects it is not unfinished work, so it raises no attention, does not hold a continuation or a cancellation, and is not listed. One list of settled effect statuses (`SETTLED_EFFECT_STATUSES` in `@rakazo/core`) serves the status, continuation revalidation, cancellation acknowledgement and this list.

A Fleet service effect names the Fleet coordinator and, once it is unresolved, how to settle it in the Fleet service: `python -m fleet settle <effect id> --result ok|failed --evidence <link>`. A run's case can also come from the Fleet wake that started it (the service's `case`, or the one `case` all gate items share; a job number is never taken for a case). When the wake says `fleet: true` the Fleet coordinator answers for the item, with `fleet: false` the default case coordinator; never Josy for a fleet case. When a Fleet wake names no case the item says **Case unknown**; without the `fleet` flag it goes to the Fleet coordinator, never a guessed case coordinator. An unresolved Fleet service effect is marked **Needs you**: only the operator can run `fleet settle`.

Evidence is narrow on purpose. A terminal parent run or an expired lease never settles anything. An attempt settles as `interrupted` only when a newer fenced attempt finished the run (the old fence can no longer write). An effect settles only from a recorded call with the same tool and arguments and a recorded completion: success → `completed`; the computer reporting the action failed → `failed`; any other error after the call started → `uncertain`, which keeps the outcome explicitly unknown until the owner checks the destination.

Each settlement is one transaction: owner check, row lock, expected status, evidence re-derived at that moment, then the update plus an audit row in `maintenance_recovery` (operator, basis, from/to status, evidence or note). The effect's `result.reconciliation` carries the same provenance. If the real outcome lands first, the request reports *changed* and overwrites nothing; repeating a request identity returns its original receipt. Settling never resumes, retries, cancels or undoes work and never changes the global pause.

## Resume authority and limits

For a Fleet-spawned bot, resuming asks the Fleet service's `maintenance_validate` (90 s budget, `FLEET_AUTHORITY_TIMEOUT_MS`). A run held because that check did not answer (`fleet-authority-verifier-unavailable`, `fleet-authority-verification-failed`) is checked again automatically every 5 minutes for 24 hours from when it was first held; after that it waits for the owner. Every other Fleet denial (`fleet-…`, for example `fleet-room-authority-changed-…`, `fleet-owner-or-state-changed-…`, `fleet-claimed-job-no-longer-eligible-…`, and a binding the Fleet could not find, `fleet-authority-binding-unavailable`) is asked about again every hour for 24 hours from when the run was first held, never on every pass; a run waiting on your answer to a card (`fleet-current-card-wait-…`) every 5 minutes while it waits, so a fixed Fleet rule clears it without clicks; one the Fleet reports invalid (`fleet-authority-binding-invalid`) is never retried. Either way the run is listed under Unfinished operations as a held run with three owner actions, audited in `maintenance_recovery` (operator, time, the reason it was held). **Check again** asks the Fleet on the next pass (about 30 seconds while Fleet runs, at Resume while paused): allowed continues through the normal path, a refusal records the Fleet's new reason. **Let it continue** and **Stop it** are confirmed first. **Let it continue** marks the run for one override (`maintenance:attention:owner-override`): its next resume skips only the Fleet's check, all of Rakazo's own checks still apply, and the resume consumes it. While Fleet is paused it is recorded and waits for Resume. **Stop it** requests the run's cancellation through the force-stop teardown, which cancels it and closes its open cards. Any other run held for attention offers **Stop it** (owner-only, audited); a run waiting on your answer to a card offers nothing. A run the Fleet declares obsolete (`fleet-category-no-longer-eligible*`) is cancelled automatically, its cards closed, with a `fleet-obsolete` row in `maintenance_recovery`; it never shows as attention. A run held because its authority changed says what changed (`authority-changed-computer`, `-instructions`, `-task`, …) and is checked again hourly for 24 hours, so it resumes if the change is undone.

An action still `executing` while its run is queued or held, with no event for 10 minutes, cannot be settled by its run (the run cannot start while it is unsettled), so the reconciler marks it `uncertain` and Unfinished operations asks you: **I checked it…** — *It took effect* records it completed; *It did not take effect* puts it back to intended, so the run's resume performs it once (same execution id, with its usual approval if it needs one). The owner actions are also an owner-only HTTP command for scripts: `POST /api/maintenance/recovery` (session cookie, trusted `Origin`, JSON) with `{ "requestId": "<unique>", "basis": "owner-recheck" | "owner-override" | "owner-stop", "kind": "run", "id": "<run id>", "expectedStatus": "<current run status>" }`; it returns `{ outcome, status, reason? }` and replays a repeated `requestId`. A run the Fleet holds because it waits on your answer to its case's card (`fleet-current-card-wait-*`) is waiting, not attention: it is counted as "waiting on your answer" and does not turn Fleet control to Needs attention. Fleet control folds the codes under a count ("9 runs need attention · show"), each with a plain sentence (`MAINTENANCE_ATTENTION_SENTENCES` in `@rakazo/core`); the dialog keeps its actions in view and scrolls its body. `FleetAuthorityStub` (`@rakazo/adapters`, re-exported by `@rakazo/testkit`) is a scripted `maintenance_validate` server with the real contract for tests.

Native ownership, account/space membership, resource revisions, exact approval requests and unsettled effects are checked at continuation and lease boundaries. Applicable Fleet dispatch authority is read again rather than trusted from old message text. Independent routine and usage brakes remain in force.

Fleet validates all persisted original and steering inputs using the actual notification category. Fresh mailbox/summary inspections and case-less coordinator notifications can resume without inventing a tracker job or claiming external content was verified; previously acted work still requires current continuation evidence.

An unverifiable legacy/prior-work continuation stays held with a reason and its checkpoint intact; global Resume does not erase it or replay it blindly. Inspect the affected thread and current case authority. Use its normal Stop control only when intentionally abandoning that continuation, then create fresh authorized work. Do not delete state, receipts or checkpoints as a recovery shortcut.

The current trusted Fleet verifier binding is an enabled, assigned, revision-matched MCP server at `http://fleet-service:8790/mcp` for a `fleet:` bot profile. An alternative or ambiguous endpoint is unavailable, not implicitly trusted. Existing tracker deadline authority is GitHub milestone `due_on`; this feature does not implement the separately discussed general deadline/priority design.

## HTTP contract

Shared schemas live in `packages/contracts/src/maintenance.ts`; persistence/admission lives in `packages/db/src/maintenance.ts`.

`GET /api/maintenance` requires the authenticated deployment owner and returns a non-cacheable snapshot:

```json
{
  "state": { "active": true, "revision": 1 },
  "status": {
    "phase": "paused",
    "activeRuns": 0,
    "activeEffects": 0,
    "pendingRuns": 1,
    "issues": []
  }
}
```

`POST /api/maintenance` additionally requires a configured trusted Origin and `application/json`. Its exact body is:

```json
{ "requestId": "unique-command-id", "action": "enter", "expectedRevision": 0 }
```

Actions are `enter`, `resume` and `force-stop`. The acknowledgment contains `{state, replayed}`. An identical committed retry returns its original durable receipt without repeating the action, even if subsequent work/state has changed. Refresh GET for current status. Reusing an identity with different arguments is rejected.

Authentication failure is 401; non-owner/untrusted origin 403; invalid command 400; stale/conflicting command 409; oversized body 413; wrong media type 415; unavailable authority/store 503. The command is not exposed as a model tool. Other accounts, ordinary members and bot credentials cannot operate it.

Owner identity, revision, state and audit receipt are committed atomically. Admission and effect claims use the corresponding database fence; a missing state row or failed authority read fails closed. No network operation belongs inside the admission transaction.

`GET /api/maintenance/recovery` (owner only) returns `{ items: [...] }` with `kind`, `id`, `status`, `state` (`draining`/`settleable`/`unresolved`), `bot`, `runId`, `runStatus`, `operation`, `startedAt`, `lastEvidenceAt`, `evidence`, `proposed` (`{status, basis}` or null), `missing` and `ownerVerifiable`. `POST /api/maintenance/recovery` takes the same Origin/JSON checks and one of:

```json
{ "requestId": "unique-id", "basis": "evidence", "kind": "attempt", "id": "…", "expectedStatus": "running" }
{ "requestId": "unique-id", "basis": "owner-verified", "kind": "effect", "id": "…", "expectedStatus": "uncertain", "outcome": "failed", "note": "What I checked (10+ characters)" }
```

It answers `{ outcome: "settled" | "replayed" | "changed" | "refused", status, reason? }`. Status codes match the control endpoint; the body limit is 4 KiB.

## Coordinated rollout and verification

Apply the native maintenance migration and the Fleet service migrations to the intended database through the existing deployment procedure. Reapply Fleet's `setup/role.sql` as the native database owner after its ledger exists: Fleet needs only its declared public SELECT columns, and native status needs SELECT on the Fleet activity ledger. Do not solve a permission failure by granting public-table writes.

Update API, workers and Fleet service together before activating the control. An old process does not understand the new fences; mixed versions are not proof that a global pause works. Check the deployed revisions and actual status, not just branch HEAD. Merge/deployment and live activation require their own authorization.

Extract updated web message catalogs with `pnpm --filter @rakazo/web intl:extract` before building a release containing new controls. Verify the built interface displays meaningful action labels rather than translation IDs. Historical unfinished attempts and effects can make the first live status **Needs attention** even when their parent runs are terminal; inspect their actual outcomes instead of deleting their records or treating terminal parent status as drain evidence.

Verification uses disposable local PostgreSQL, synthetic users and scripted/emulated providers—not live Fleet or customer accounts. Relevant suites include:

- `packages/db/src/maintenance{,.postgres}.test.ts`: durable commands, contention, persistence and cancellation evidence.
- `apps/api/src/maintenance{,-intake.postgres}.test.ts`: owner/HTTP boundary, retained intake and exact approval behavior.
- `packages/adapters/src/executor-maintenance.test.ts`, Pi budget/transport suites and native host-computer tests: checkpoints, current authority, identities and actual cancellation.
- `packages/adapters/src/messaging-delivery.postgres.test.ts`: ordered delivery, pause races and uncertain outcomes.
- Fleet service maintenance/authority/card suites and gate tests: service-side work and independent holds.

Native maintenance PostgreSQL suites require `MAINTENANCE_TEST_DATABASE_URL`; delivery uses `VERIFY_DATABASE=1` and `DATABASE_URL`. Use separate disposable databases because workers reconcile durable backlog. Fleet's opt-in suites require `FLEET_MAINTENANCE_POSTGRES_OWNER_URL` and `FLEET_MAINTENANCE_POSTGRES_URL` for the same explicitly allowed local test database with its restricted role. Run Unix process/symlink suites on Linux; container tests need an init/subreaper such as `tini`.

Tests alone do not establish UI behavior. Exercise the actual owner interface, outage/restart, queued input, stale revision, separately confirmed force stop and lost-response retry. A retry must not cancel newer queued input; resume must execute the preserved request once. Also verify non-owner/CSRF refusal and a narrow-screen layout.
