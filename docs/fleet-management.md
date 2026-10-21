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

## Obsolete ordinary questions

An authenticated integration can call `decisions.withdraw` with `botId`, `messageId` and a nonempty
`reason` of at most 500 characters. It withdraws only an unanswered ordinary question owned by that
account and space on a `waiting_input` run. Approval, secret, credential and instruction-update cards
are refused, as are answered questions and runs with another pending question.

Withdrawal cancels only that old run and its work, retains the question in history, and publishes the
normal `run.cancelled` event so the decision dock refreshes. It does not record a user answer. A real
answer racing withdrawal wins or loses atomically; a resumed run cannot be withdrawn. Repeating a
withdrawal returns `withdrawn: false` without another terminal event. Other active runs are untouched.
The cancellation payload includes `messageId`, `reason` and `withdrawnByUserId`. Integrations must
distinguish this deliberate withdrawal from an unanswered expiry rather than automatically re-asking it.

After withdrawing an obsolete question, the integration may ask its corrected question normally.
Unchanged pending questions still use the existing duplicate protection. This API is not a new
built-in fleet-management tool and does not grant permission to perform the action being discussed.

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
