# Fleet management

A bot can set up a fleet of bots the way you would: create groups, organize the sidebar, rewrite
the instructions of bots it created, pick their model and schedule them. This is controlled per
bot and is off by default.

## Turning it on

Open a bot's settings, expand **Advanced** and turn on **Fleet management**. The switch is on web,
the Electron desktop app (which hosts the web UI) and mobile bot settings.

- It is off for every new bot. A bot that creates another bot, or a duplicate, starts with it off;
  the switch is never inherited.
- It is checked again each time a tool is called, so turning it off takes effect immediately.
- Subagents get none of the fleet tools, not even `list_fleet`.

## Which runs can use the fleet tools

Only runs you started can use them: a message you sent, a follow-up to your message, or the end of
a call. Runs started by another bot's message, a messaging channel, a spawn, tickets, a webhook or a
routine get none of the fleet tools, including `list_fleet`. The tools are hidden from them and
rejected if called.

A run that has received a message from a messaging channel or a webhook while it was working
cannot change the fleet for the rest of that run. Channel or webhook messages that were already in
the thread history before the run started are not covered by this rule. A follow-up counts as yours only when every
message it answers came from you in the app.

## Tools

- `list_fleet`: lists active bots, groups and sections. With `bot_id` of a bot it created, it instead
  returns only that bot's full instructions and current version.
- `create_group`: creates a group from existing bots.
- `update_group`: renames a group or adds and removes members.
- `organize_bot`: sets a section (`section`), clears it (`clear_section: true`) or sets a pin on a bot
  or a group.
- `update_bot` with `bot_id`: edits a child bot's name, title, description, color and
  notifications. It never changes instructions. Without `bot_id` it acts on the calling bot as
  before.
- `set_child_instructions`: replaces a child bot's instructions. The bot passes the version it read
  with `list_fleet`.
- `set_child_bot_model`: sets or clears a child bot's model and thinking level.
- `create_child_routine`: schedules a prompt for a child bot.

## Approval

`create_group`, `update_group`, `set_child_instructions`, `set_child_bot_model` and
`create_child_routine` always show an approval card. Auto-review and "Always allow" do not skip it,
and the card offers allow or deny only. The card lists what will actually run, resolved before the
pause:

- Create group: the name and every member.
- Update group: the members added and removed, and the new name.
- Instructions: the whole new text, with the old and new lengths.
- Model change: the current and the new model (From and To), and a Thinking line when the thinking
  level is set or reset.
- Routine: the prompt and the resolved time.

If the request cannot be shown whole on the card, it is refused instead of cut off. If the child's
instructions, model or thinking level change while the card waits, approving does not overwrite them;
the bot has to ask again.

`list_fleet`, `organize_bot` and `update_bot` need no card.

## Complete approval details

Approval cards retain the complete redacted resolved summary and the displayed argument values,
including multiline messages and evidence links. The tool description, intention and safety reason
are not cut off at presentation length limits. Secret-named arguments remain omitted and known
secret values are redacted before display. Push notifications are still shortened; they are not a
substitute for reviewing the full card. This does not change authorization or mark external setup
complete.

## Reply cards and who acts

A reply card is an `ask_user` card with `draft` (the reply), `inquiry` (the customer's full inquiry and
material context, at most 20,000 characters) and `source` (`{ ref, version }`, the conversation and the
latest message the draft answers). The card shows the inquiry and the reply in full; long text folds
behind "Show all" and is never cut. The reply stays editable until the card is answered. The answer is
bound to the reply as sent (`draftFinal`, when edited) and to the source version: the bot is told to act
on it only while that version is still the latest.

A newer version of the same `source.ref` from the same bot in the same chat replaces the older open
card: its run alone is cancelled (like `decisions.withdraw`), the card is retired with "Replaced by a
newer card for … (version a → b)" and never answered, and a click from an old tab changes nothing. The
same version is still refused as a duplicate. A card that loses its run lease replaces nothing.

Every open card says under its buttons who acts and what a click does: approvals ("<bot> runs this only
if you allow it …", with a tooltip per button), instruction updates, space creation, questions, reply
cards and secret requests. No card speaks of an unnamed operator or developer.

When the user edits a reply before answering, one learning note goes to the feedback bot
(`RAKAZO_FLAG_BOT`, Elena) through the forward path, with the original and the sent text. The nonce is
the card, so it is sent once; it approves, sends and changes nothing. Without `RAKAZO_FLAG_BOT` no note
is sent. A note that fails after the answer committed is logged, not retried.

The approval to send a Zendesk reply (`zd_reply { ticket, body, status, tags? }`) shows the Fleet's
`zd_reply_context` for the ticket: the customer's full `inquiry`, the thread and any note. The version
the user approved is the `source.version` of the bot's newest answered reply card for
`zendesk:<ticket>`; when the newest customer message is another version, the review says in plain words
that the customer wrote again (comment ids stay out of the review).
A context in another shape shows as unavailable, never guessed. The contract is pinned by the Fleet's
fixture, copied whole into `apps/api/src/fixtures/zd_reply_context.json`.

Withdrawal approvals recorded before source binding are reconciled on every reconciler pass from their
exact route-bound envelope only: an ended source invalidates the request (its card is then retired), a
live one gets its source recorded so a later answer, withdrawal or stop ends it at once. A request
without such an envelope is never given a guessed source.

## Cards end with their run

A card never stays pending on a run that ended. Whenever runs are cancelled (Stop, withdrawal, thread
clear, expiry, supersession, teaching takeover, room changes), every unanswered card of theirs,
questions and approvals alike, is retired in the same transaction with a reason ("Withdrawn: <reason>"
for a withdrawal, "Its run ended without an answer" otherwise) and a `thread.message.updated` event
refreshes open tabs. Bound approval requests are invalidated as before. The reconciler retires cards
already left open on ended runs, without touching the runs.

Stuck-work expiry (`RAKAZO_STUCK_EXPIRE_HOURS`) never cancels a run that waits on an open card: a
decision waits for the user as long as it takes, across a pause and a resume. For other stuck work the
age excludes time the global pause held (from the maintenance audit), so queued work the pause kept is
not cancelled the moment it resumes; work that is stuck for its own reasons still expires.

## Obsolete ordinary questions

An authenticated integration can call `decisions.withdraw` with `botId`, `messageId` and a nonempty
`reason` of at most 500 characters. It withdraws only an unanswered ordinary question owned by that
account and space on a `waiting_input` run. Approval, secret, credential and instruction-update cards
are refused, as are answered questions and runs with another pending question.

Withdrawal cancels only that old run and its work, retains the question in history retired as
"Withdrawn: <reason>", and publishes the normal `run.cancelled` event so the decision dock refreshes. It
does not record a user answer. A question left open on a run that already ended (cancelled, completed or
failed) is retired the same way without touching the run, and returns `withdrawn: true`. A real
answer racing withdrawal wins or loses atomically; a resumed run cannot be withdrawn. Repeating a
withdrawal returns `withdrawn: false` without another terminal event. Other active runs are untouched.
The cancellation payload includes `messageId`, `reason` and `withdrawnByUserId`. Integrations must
distinguish this deliberate withdrawal from an unanswered expiry rather than automatically re-asking it.

After withdrawing an obsolete question, the integration may ask its corrected question normally.
Unchanged pending questions still use the existing duplicate protection. This API is not a new
built-in fleet-management tool and does not grant permission to perform the action being discussed.

## Manual prerequisites and to-dos

A question card can hand manual steps to the user. `ask_user` takes `prerequisites` (1–10 items, each
`{ key, title, steps, why, blocks?, verification: "automatic" | "manual" }`, keys unique on the card;
`why` at most 600 characters; `blocks` up to 10 other cases or jobs that truly depend on the item, such
as "Case 142" or "#144", never the asking bot's own waiting work), `option` (the exact label of the
option that means "I'll do it"), `release` (`each` or `all`, default `all`) and `priority` (`p0`–`p3`).
An option that is not one of the card's options, or an invalid item, is refused before the card is
stored. The card stores the items as `prerequisites` and marks that option `todo: true`.

What the user is asked to do must come with clear instructions. Every new item needs a non-empty `why`
and `steps` with at least one numbered step ("1. …"); `ask_user` parses new items with one schema
(`AskPrerequisiteInput`) and refuses the whole set otherwise, naming each item and field to fix. The
tool description tells the bot what a good item holds: why it is needed, who acts and what happens
next, about how long it takes, real URLs, exact menu names and values, the bot's Credentials (never
the chat) as the place for a secret, how it is checked, and "(not checked)" after any step it has not
verified. Cards already stored keep the stored shape and are not re-checked.

While the card is open, the to-do option says "adds N to-dos" and lists the item titles under it;
"Show steps" unfolds each item's why and numbered steps, so the user sees what they commit to before
choosing.

Answering with that option, inside the answer's transaction, creates one `UserTodo` per item, grouped
by the card (`sourceMessageId`). An item whose `key` already has a to-do in the space keeps that to-do's
identity and progress; changed steps (ignoring whitespace) or verification reset it to open and clear
its evidence, and a retired one starts over. The answer stays in history as an answer. The to-do records
intent only: nothing is marked done and nothing is approved. The resumed bot is told the to-do ids and
not to ask again. The answering tab refetches the to-dos at once, so the panel and the card's checklist
show them without waiting for the next poll.

The To-dos button in the left sidebar (also in the collapsed rail) is always shown; it carries the open
count when something is open and opens the list ("Nothing waiting on you" when nothing is), grouped by card: cards with an unfinished item that blocks other work first, then by priority
(unknown after p3), then oldest asked; items keep the bot's order. A group has one header line (bot ·
topic, a "Show question" link that opens the card in its chat or room through the usual `?m=` message
jump, progress "2/3", retired items excluded); each item is one line: a checkbox, a short title, a red
"blocks …" chip while it blocks other work, and only when it matters one short muted line. Clicking the
title opens why it is needed, the numbered steps, who checks it, and chips for the card's case and the
asked date. Finished items fold into one "Done (N)" row; retired ones show ⊘ and a struck-through title.
The answered card in the chat shows the same rows for its own items (the decision dock drops a card once
it is answered). Feedback
about a to-do goes through the existing Feedback to Elena flow.

Ticking the checkbox (only the box toggles) means "I did this". For 5 seconds it shows a countdown and
Undo; nothing is sent if it is undone or the tab closes. Then:

- An automatic item becomes `checking` (a spinner in place of the box) and its case coordinator gets
  the same bounded, read-only `todo_check` run as the hourly sweep (below), at once; nothing is posted
  in the chat. The run calls `todo_report(todo_id, outcome, evidence, remaining_step?)`. `verified`
  (positive evidence only) ticks the box. `remaining` (checked, not done) unticks it with "still
  missing: …"; `unavailable` (could not check) unticks it with "couldn't check — tick again to retry",
  and is never treated as a failed access check. During the global pause the run stays queued and is
  held like any other work; it runs after resume. Meanwhile the item says "waiting — Fleet paused"
  instead of "checking…" (`todos.list` returns `checksHeld`).
- A manual item becomes `confirmed`, ticked with the line "Confirmed by you" rather than verified. No
  bot run checks it.
- A box is ticked only once its item is verified or confirmed, and then cannot be unticked; a pending
  box cannot be ticked again.

Only the requesting bot, or the case coordinator checking for it, can report; only the requesting bot can retire (`todo_retire(todo_id, reason)` for a cancelled or
superseded requirement; it then folds into "Done (N)" as no longer needed and takes no actions). Every action is
a compare-and-set on the to-do's revision: a stale tab gets `CONFLICT`, two clicks make one transition.

Satisfied items release only the requesting bot's work, through an ordinary message in its thread (the
same send path as a user message, so a global pause still holds the run): with `each`, every satisfied
item wakes the bot once, naming it; with `all`, the last satisfied item of the card wakes it once,
listing them all, and retiring the last open item releases the satisfied rest. A satisfaction never
wakes the bot twice (`releasedRevision`). Releasing never grants an approval or clears the pause.
The release message stays visible in the chat even when it waits behind the check run that verified
the item: a message queued behind background work (`todo_check`, ticket runs) is not linked to that
run, whose own steps the transcript hides. A withdrawn or ended card previews in the sidebar as
"No longer needed" (with its reason), not as its question.

RPC: `todos.list`, `todos.check({ todoId, revision })`, `todos.confirm({ todoId, revision })`, scoped to
the caller's space and own to-dos. Table `user_todos`, migration `20261021200000_user_todos`.

### Link to the tracker case

A card's to-dos belong to their tracker case by number: `ask_user` takes `caseRef` (the issue number)
for the whole set, and each item's `blocks` may name tracker issues as `{ issue, label? }` (free text
is kept for display only). `user_todos.caseRef` stores it; migration `20261022090000_user_todo_case_ref`
backfilled it only where the card question started exactly "Case <n> · " or "URGENT · Case <n> · ",
and left every other to-do unlinked (null), never guessed. The panel's "Case <n>" chip links to the
issue through the case link setting (`RAKAZO_CASE_LINK_URL`).

The Fleet service, signed in as the deployment owner, uses two RPCs (other callers get `FORBIDDEN`):
`todos.byCase({ caseRef })` returns every to-do of the case in the caller's space, all statuses; and
`todos.retireForCase({ caseRef, reason })` retires the case's open, checking, remaining and unavailable
to-dos with the reason through the same compare-and-set as `todo_retire` (new revision, history kept,
nothing deleted) and returns those it retired. Verified, confirmed and retired to-dos stay as they are.
It releases no work, since the case itself ended, and is idempotent. A check still running is retired
too; its later report is refused. A to-do created later for the case is a normal open to-do.

### Hourly checks

The worker's reconciler checks pending automatic to-dos once an hour, so a finished step releases work
without another click. A to-do is due when it is open, still to do or couldn't-check and its last check
request (or its creation) is an hour old, or when a check has not reported for an hour. Manual to-dos
are never swept: they cost no model call. A to-do whose check run is still queued or running (a
check-now held by the pause) is not checked again.

A due to-do goes to `checking` through the same compare-and-set as Done — check now, and gets the same
`todo_check` run, tagged `todo-check:<id>:<revision>`. The run belongs to the case coordinator
(`RAKAZO_CASE_COORDINATOR_BOTS`, comma-separated names or ids, first is the default; read once at
startup and matched by id, else by name, the same way for recovery items): the bot that
asked when it is one of them (only Josy, or Elena for fleet cases, ask Rens cards), the default one
for a case card another bot asked, and the asking bot when there is no case. The run is
context-bounded and quiet: its prompt carries only the to-do, why it is needed, its steps and its last
result, never the conversation; it posts nothing in the chat
and cannot ask, message or call the user. It is read-only: any action that would change something, or
that the owner's rules would ask about, is refused (no card). Its shell runs only a plain pipeline of
allowlisted reads, parsed before it runs: `gh api` with GET only (no other `-X`/`--method`, no
`-f`/`-F`/`--input`, no GraphQL), `gh-app-login` without arguments, `git ls-remote`, `dig`, `nslookup`,
`host`, `curl` over http(s) with GET or HEAD only and no data, upload, form, config or file output,
and `cat`, `ls`, `head`, `tail`, `grep`, `jq`, `wc`. Redirection, `;`, `&&`, `||`, `&`, subshells,
variables and command substitution are refused. A refused command records the to-do as couldn't check
("needs a command that may change something"); it is checked again the next hour. Normal runs keep
their shell as before. The result comes back through `todo_report`, the one
completion path, so a sweep and a check-now on the same to-do resolve it once and release its work once.
A check that cannot be done is `unavailable` and is retried the next hour, with the same to-do.

No scheduled check starts while the global pause holds admission (checked again inside each to-do's
transaction). A verified to-do releases its bot only through the ordinary send path, which the pause
still holds; it never grants an approval.

## Dependent-effect identity

New MCP `question_withdraw` effects record the exact supporting question in
`ExternalEffect.sourceMessageId`, independently of direct or catalog display aliases.
Before recording a new binding, the recorder locks the source thread then run in a
transaction, re-reads the exact source and creates the effect before releasing those
locks. Answer/withdraw transactions use the same locks, preventing a new binding
from appearing after their invalidation scan. The recorder checks the owning account, space and bot,
that the source is a single ordinary unanswered question, and that its exact run/thread
is waiting for input. Unrelated tools accepting `message_id` do not imply a dependency.
The nullable indexed reference preserves existing effect requests and history.

Answering or withdrawing an ordinary source question invalidates its explicitly bound
intended/approved effects in the same database transaction. The effect result records
`source_question_unavailable`, not a fabricated human answer. Denied, completed,
executing and uncertain effects, unrelated sources and other spaces remain unchanged.

Approval answers lock the exact space-scoped effect row before reading its status,
serializing the decision with source invalidation. An invalidation that wins first
is rejected without queueing the approval run or recording a human answer; an answer
that wins first is subsequently invalidated by the source-ending transaction.

Execution claims re-read the bound ordinary question and waiting source run under
the same source-thread then source-run locks before the effect status CAS. An
unavailable source invalidates the pending effect rather than executing it. The
claim is the execution linearization point; a source ending cannot undo an external
call whose claim already won. Missing account identity fails closed.

The shared cancellation transaction also invalidates explicitly bound pending effects
for messages attached to the cancelled runs, before callers delete any messages.
This covers thread clearing, group archival/removal and group dissolution that use
that seam. The run update holds the source-run lock until commit; new recorders and
claims re-read the cancelled status under that lock and cannot proceed. Storage
failures propagate to the owning transaction rather than leaving cleanup best-effort.

Aged-run expiry uses that same dependency invalidation after its cancellation CAS
wins and before status messages or steering continuation are created. An answer
that wins the expiry fence causes no invalidation. An invalidation failure aborts
the owning transaction, rather than starting continuation on partial cleanup.

Explicit thread Stop also invalidates dependencies for only the runs its cancellation
update returns, inside the same transaction and before steering/progress cleanup.
No won cancellation means no dependency scan; storage failure aborts Stop before
post-commit notification or sandbox teardown.

Queued user/reaction supersession uses a single conditional cancellation returning
only the rows that still qualify, then invalidates their source dependencies before
task cleanup in that transaction. A run claimed since a prior observation is not
cancelled, nor is its task or dependency touched. Failure aborts the owning send.

Teaching takeover conditionally cancels only active runs owned by the requesting
account and space, and invalidates their source dependencies inside that same
transaction before progress cleanup. Only returned cancellations are scanned;
invalidation failure aborts before computer lease changes.

Team-chat fallback cancellation after a competing routine wake also invalidates
source dependencies in the owning cancellation transaction before task cleanup.
Only active runs matching the exact account, space, bot and thread can be cancelled;
a lost cancellation does not modify the task or source dependencies. Invalidation
failure propagates before the external-message reservation is abandoned.

Execution claims also recover the source from exact persisted route-bound direct
and MCP catalog withdrawal envelopes that predate the source column. They use the
same ownership checks and source locks, invalidate unavailable sources, and persist
the recovered binding only when the execution CAS wins. Terminal history is never
rebound. Plain argument objects, unbound catalog requests, malformed envelopes and
other tools do not establish source identity; their existing replay guards remain.
This claim-time recovery is not a background backfill or automatic UI refresh for
legacy pending cards.

An approval card whose effect was invalidated is retired, not left waiting. Right
after a source question is answered or withdrawn, and on every reconciler pass (Stop,
expiry, clears and anything missed), the card gets `status: "retired"` with a
`retiredReason` under the same thread -> run -> effect locks an answer takes. It is
never an answer: no `answer`, no `answeredBy`, no approval. A `thread.message.updated`
event refreshes open tabs and the decision dock, the card leaves the dock and the
pending counts, and every client shows "No longer needed" with the reason. The paused
run is queued again unless another of its cards still waits; on resume its tool call
gets the stored "no longer applies" result, as after a denial. A click from a stale tab
gets CONFLICT, sends nothing, and the dock says so. If the approval had already won,
the claim still revalidates the source and invalidates instead of executing.

The reference is not a human answer or an authorization grant.

## What a bot cannot do

- Permanently delete a bot.
- Read, request or change secrets. Instructions, profile fields and routine names and prompts that
  contain a credential are refused.
- Edit a bot it did not create. It can only change a section or pin on any of your bots.
- Move a bot between spaces. Every tool works inside the space and account of the run.
- Remove itself from the group it is running in.

## Limits

- A group has 2 to 10 members.
- Instructions are at most 20,000 characters.
- `list_fleet` returns at most 200 bots and 100 groups, and says when the result is truncated.
- A bot writes at most one set of instructions per child per run, and must pass the version it read.
  If the child changed in the meantime, the edit is refused and the bot reads it again.

## History, events and routines

Instruction edits are saved as versions in the bot's instructions history, with the reason
"Updated by" and the name of the bot that made them.

Creating a group appends a `group.created` event to the calling bot's thread; changing a group
appends a `group.updated` event to the group's thread. Changes to a bot append `bot.updated` to that
bot's thread.

Routines a bot creates for a child are managed by you in the child's **Routines** screen. A bot
cannot list or cancel them.
