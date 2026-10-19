# Fleet build of Rakazo

This is Rens's fork of [elie222/rakazo](https://github.com/elie222/rakazo):
[RensTillmann/rakazo](https://github.com/RensTillmann/rakazo).

- `main` follows upstream `main`. We never commit to it.
- `fleet-next` (this branch) is a newer upstream plus our patches, one commit per patch. It is
  **running** since 19 Oct 2026: image `rakazo-fleet/app:bcdacb3` (the fleet build: approvals in
  every run and shell rules, rooms, usage bars, Hindsight provider, and the web catalogs; base upstream
  `76f4259`), computers pinned to `rakazo-fleet/computer:7d5e64c`. `tsc` for 8 packages, 5243 core/
  adapters/api/worker tests, 769 web tests and 358 Postgres tests (with `NODE_ENV=test`, which turns
  off sign-up rate limits) passed in that image. Settings: `RAKAZO_WEBHOOK_HONORS_RULES`,
  `RAKAZO_APPROVAL_EVERY_RUN`, `RAKAZO_STUCK_*_HOURS`, `RAKAZO_ROOM_*`, `RAKAZO_MEMORY_RECALL_EVERY_RUN`,
  `RAKAZO_SUBSCRIPTION_LIMITS` (see `D:/rakazo/.env`). Two migrations ran
  (`20261019120000_subscription_limit_readings`, `20261019121000_chat_group_room_brake_notify`), so
  rollback to `49fa329` needs the `D:/rakazo/backups/pre-fleet-build-20261019-0848.dump` restore.
- `fleet` (`8896cd15`, image `rakazo-fleet/app:d93d461`) is the previous build. Adopt `fleet-next`
  as `fleet` once it has run well for a few days (see "Adopt `fleet-next`").

All commands are for Git Bash on this PC.

## What is on `fleet-next`

The base is upstream commit `76f4259` ("fix(team-chat): backfill Slack thread history
(#1460)"), upstream `main` on 2026-10-18. It is 46 upstream commits past the `fleet` base
`7d5e64c`. Upstream merged our four PRs (#1450 to #1453), so those patches are dropped or
shrunk. Every kept patch was replayed with `git cherry-pick -x`, so its commit message names
the `fleet` commit it came from.

### Kept patches

| Commit on `fleet-next` (from `fleet`) | What it changes | Setting | Upstream PR |
|---|---|---|---|
| `dfd266d` Default message_bot to fyi (from `398b97a`, shrunk) | A `message_bot` call without an `intent` is sent as `fyi` (no automatic reply back), not `request`. The tool description says so. Stored messages without an intent are still read as requests. The hop-limit half of `398b97a` is dropped: upstream merged it as #1452 (see below). | none | fleet-only |
| `42db087` Add a Forward to bot message action behind RAKAZO_FLAG_BOT (from `bb6efae`) and `0bd2c52` Never let a forwarded flag answer a pending ask (from `fd363f3`) | A bot message's More menu gets an extra item that opens a small window with an optional note and Send. Send posts one message, in Rens's name, in the chat of the bot named in the setting, and wakes that bot. The message holds the note, which bot and chat it came from, the message id, run id and time, a link to the message, and the first 500 characters of it. Without the setting the item is hidden and the server refuses. The forwarded message is always a new request: if that bot is busy or waiting on a question card, the card stays open and the message waits, then starts its own run when the bot's current run ends. | `RAKAZO_FLAG_BOT` (bot name or id; unset = off), `RAKAZO_FLAG_LABEL` (menu label, default "Forward to bot…") | not yet |
| `6c91e44` Stop a run at a configurable budget and let the bot write one final line (from `4b262a8`) | A run stops after a maximum number of model calls or minutes, whichever comes first. Then tools are off, the bot gets one last turn to write one line (what it did and what is blocked), and the run ends as completed with that line. If that last turn fails, the run ends with a fixed line instead ("I stopped because this task reached its limit…"). A tool that is already running is not cut off. Only the bot's own model calls count, not a subagent's. | `RAKAZO_RUN_MAX_MODEL_CALLS`, `RAKAZO_RUN_MAX_MINUTES` (each unset = no limit) | not yet |
| `7f5e7e5` Refuse shell commands that start a browser for a bot without browser tools (from `dccb3e1`) | For a bot whose browser is off (`browser_navigate` among its turned-off tools), the shell refuses a command that starts `chromium`, `chrome`, `google-chrome`, `firefox`, `playwright` or `puppeteer`, also by path, after `timeout`, `xvfb-run`, `env` or `nohup`, through `npx`, or inside `bash -c`. The bot reads: "This bot has no browser. Hand the task to a teammate who has one (see your teammates list)." Not caught: a browser started from inside a script. | none (follows the bot's browser switch) | not yet |
| `66502e2` Mark mid-turn narration and let the user toggle it ("Show thoughts") (from `285ba19`) | In runs Rens starts, text a bot writes just before a tool call is still saved as a chat message, but marked as narration. The chat header gets a "Show thoughts" button (lightbulb), stored per browser, default off: off hides that narration; on shows it small, grey and italic. `message_user` updates, question cards and final replies are never marked. Bot-to-bot and routine runs still drop narration (upstream #1451). | none (per-browser toggle) | not yet |
| `9e59014` Show attach_file images and files from bot-to-bot runs (from `5a6000d`) | In `bot_message` runs, the `image` and `file` blocks a bot attaches with `attach_file` show in the chat, in history and live. Steps, tool activity and narration of those runs stay hidden. | none | not yet |
| `ccd76cb` Finish silently on NO_RESPONSE in every run that may finish empty (from `db6b42d`) | A bot woken by a teammate's `fyi` (or by a messaging-channel message) that answers exactly `NO_RESPONSE`, once or repeated, finishes with no chat bubble, as routines already did. A `request` or `question` still gets `NO_RESPONSE` back as its result. | none | not yet |
| `0e8fa9d` Keep the model's thinking in the chat behind Show thoughts (from `d5c7ece`) | The bot's own reasoning is saved with its messages in runs Rens or another bot starts, in order, and shown behind the same lightbulb (folded to three lines). It is never sent back to a model, another bot, a notification, the sidebar preview, search or the bot export. Each piece is cut at 8,000 characters and run secrets are blanked out. Routine and ticket runs keep none, and a silent finish keeps none either. | none (the same per-browser toggle) | not yet |
| `6672bf7` Trust extra web origins from RAKAZO_EXTRA_ORIGINS (from `6d8921b`) | Each origin in the setting is trusted like `WEB_ORIGIN` for sign-in, sign-out, session and RPC calls; any other origin is still refused. The computer screen and terminal load from the address the page was opened on. The images compose file passes `RAKAZO_ALLOWED_HOSTS` to the web service. | `RAKAZO_EXTRA_ORIGINS` (origins, comma-separated) with `RAKAZO_ALLOWED_HOSTS` (host names, for Vite) | not yet |
| `d52e947` Play attached screen recordings inline in the web chat (from `a67fd29`) | `attach_file` accepts `.webm` and `.mp4` (`.m4v` counts as mp4) as `file` blocks within the upload limit, which upstream #1440 made configurable (`MAX_UPLOAD_SIZE_MB`, default 10). The web chat plays them in an inline player; the mobile app shows them as a file. People can upload `.webm`/`.mp4` too. | none | not yet |
| `9ac7fab` Pin session cookie security with RAKAZO_SECURE_COOKIES (from `2f4b717`) | Lets the tailnet address be the main address while `http://127.0.0.1:5173` stays an extra origin. With `false`, both addresses keep the plain `better-auth.session_token` cookie, so sessions stay valid. `true` forces secure cookies, unset keeps upstream's choice, any other value stops the API at start-up. | `RAKAZO_SECURE_COOKIES` (`true`/`false`, unset = upstream) | not yet |
| `1fd5c20` Resizable bots sidebar that snaps to an avatar-only rail, then hides (new on `fleet-next`) | The sidebar edge drags like the right panel's: free widths from 220px to the viewport limit (at most 560px, leaving 320px each for the chat and the right panel). Below 148px it snaps to a 76px rail with only avatars (name as tooltip, unread dot on the avatar, thin section lines that fold a section; search, activity and archived hidden); below 38px it hides. Dragging back out reverses each step; a click still hides or shows it, and the arrow keys step through the same stops. Width is kept per user in the browser; the phone drawer is unchanged. The right panel reserves the real sidebar width. | none | not yet |
| `c031e44` Approvals: Composio batches per action; owner's rules in webhook runs (new on `fleet-next`) | `COMPOSIO_MULTI_EXECUTE_TOOL` is approved per action it runs (`tools[].tool_slug`), not by the wrapper's name (which contains "execute", so even a read asked): the card and push name the actions, and "Always allow" stores each action, never the wrapper (which would allow every action, sending email included). A connector action named `fetch` counts as a read. With the setting on, the owner's rules also decide webhook-triggered runs: "Always allow" skips the card there; without a rule a side effect still asks, and Auto Review stays out. Also types the parsed shell entries (lint). | `RAKAZO_WEBHOOK_HONORS_RULES` (`true`; unset = upstream: every webhook-run side effect asks) | not yet |
| `a02867b` Question and approval cards use the full chat width on phones (new on `fleet-next`) | The card was capped at 74% of the chat width on every screen, so a long tool name broke mid-word on a phone. It now uses the full width below the `sm` breakpoint and keeps 74% above it. | none | not yet |
| `e5add03` Answer identical open question cards together (new on `patch/card-sync`) | When Rens answers a question card (never an approval or secret card) from the card, every other open question card in the same chat with the same question (lowercase, whitespace collapsed, punctuation and a leading "URGENT · " ignored) and the same option labels gets the same answer and its run continues: a button maps by label to that card's own option, typed text is copied. All in the answer's transaction; the copied cards get `syncedFrom: <messageId>`, show "Answered: <label> (same question)", and never sync further. The composer path already answers every waiting run, so it does not sync. | `RAKAZO_SYNC_DUPLICATE_ASKS` (`true`; unset = upstream: each card needs its own answer) | not yet |
| `6aa10d8` Webhook, GitHub and messaging wakes show as "Automatic", folded (new on `fleet-next`) | A delivered wake is stored with the owner's role, so the chat showed the routine prompt and the raw payload as the owner's own message. The source now travels with the message (read from the `webhook:`/`github:`/`messaging:` clientNonce prefix, on page loads and on the live event): the chat puts it on the bot side as a folded card "Automatic · <routine> · <event>" (event hidden on phones), with the full delivery one tap away; a reply to it is labelled "Automatic". A delivery without an idempotency key now gets a unique prefixed nonce, so it is marked too. Catalogs updated with `intl:extract`. | none | not yet |
| `49fa329` A delivery that runs one routine finishes like that routine's run (new on `fleet-next`) | The fleet gate wakes a routine by webhook, and webhook runs behaved as chats: an exact `NO_RESPONSE` was posted as a bubble, mid-turn narration was saved, and the chat went unread after every silent run. A webhook, GitHub or messaging delivery that runs exactly one routine now records it on the run (`routineId`), and the run follows routine chat behaviour (`runBehaviorTrigger`): it may finish silently, gets the routine reply guidance, saves no narration or thinking, and only marks unread when it says something. Approvals keep the real `webhook` trigger. Several routines in one delivery: unchanged. | none | not yet |
| `f8eeddc` Approvals: RAKAZO_APPROVAL_EVERY_RUN asks for consequential actions in every run type (new on `fleet-next`, #7) | With the setting on, a consequential action (one `toolRequiresApproval` flags, or a connector write) in any run that is not a webhook run (user, routine, bot_message, follow_up, messaging, group) shows an approval card unless an `always_allow` rule matches. Auto Review stays out of it, as in webhook runs. Webhook runs keep their stricter rules; ordinary reads and exempt built-ins (shell, files, browser) still run unasked. Off: unchanged. | `RAKAZO_APPROVAL_EVERY_RUN` | not yet |
| `6338f02` Approvals: shell rule kind (new on `fleet-next`, #7) | An approval rule can have `matchKind: "shell"` with a JavaScript regex as `matchValue`. It is tested against the shell command, and again after each `bash -c` / `sh -c`, `env`, `timeout` and `nohup` prefix is peeled off. A matching `require_approval` shell rule makes `shell` ask in every run type although `shell` is normally exempt; a matching `always_allow` shell rule lets it run (in webhook runs only with `RAKAZO_WEBHOOK_HONORS_RULES`). A shell rule beats a tool-level rule. `approvalRules.set` refuses a regex that does not compile; a stored one that does not compile never matches. Settings → Action confirmations lists shell rules and adds them ("Ask before" / "Always allow" matching commands); remove works as for other rules. | none (rules in `action_approval_rules`) | not yet |
| `1f47c31` Approvals: no Always allow on cards a tool-level or shell require_approval rule caused (new on `fleet-next`, #7) | When a `require_approval` rule of kind `tool` or `shell` caused the card, it shows only Allow once and Deny. The server already refuses any answer the card does not offer, so an "always" answer for such a card is refused. Connector and category rules keep the button. | none | not yet |
| `bb09186` Stuck work: reminder and expiry hours from settings (new on `fleet-next`, #8) | The reminder for a queued run or open card (4 h) and its expiry (24 h) can be set in hours (decimals allowed). Unset, empty, zero, negative or not a number keeps the constant. The reconciler scans from the earlier of the two, so an expiry set below the reminder still fires. The web activity list keeps the 4 h mark (no server settings in the browser). | `RAKAZO_STUCK_NOTIFY_HOURS`, `RAKAZO_STUCK_EXPIRE_HOURS` | not yet |
| `2f94229` Capture Anthropic subscription-window headers (new on `fleet-next`, #18) | Every model call (main runs and subagents, through `observedPiStream`) reads Anthropic's undocumented `anthropic-ratelimit-unified-5h-*` / `-7d-*` / `-status` response headers (utilization 0..1, reset in unix seconds) and the worker appends a row to the new table `subscription_limit_readings` (migration `20261019120000_subscription_limit_readings`); the newest row per provider is the current reading. Saving happens off the request path and never fails a call. Only header values are stored, never the token. | `RAKAZO_SUBSCRIPTION_LIMITS` (`true`; unset = nothing captured) | not yet |
| `5c2058f` RPCs `usage.limits` and `usage.thread` (new on `fleet-next`, #18 #23) | `usage.limits` returns the latest reading with its age, a window whose reset passed reads 0% (reset), plus every row of `fleet.usage_bars` (raw query; missing schema or table = none). When the reading is older than 10 min and the user has a Claude subscription sign-in, the API calls `GET https://api.anthropic.com/api/oauth/usage` with that OAuth token (read server-side from the encrypted credential, refreshed if expiring, never logged), stores the result as a reading, calls at most once per 10 min per user and backs off 15 min after a 429. `usage.thread({botId\|groupId})` returns this chat's context size (latest main call's input + cache read + cache write, % of the model's window from Pi's catalog) and today's cache %, tokens, runs and API-price-equivalent cost. | `RAKAZO_SUBSCRIPTION_LIMITS` (`usage.limits` returns `enabled: false` without it; `usage.thread` always works) | not yet |
| `be9bb9c` Usage bars and the chat usage line (new on `fleet-next`, #18 #23) | A slim strip under the header of the chat, Board and Artifacts pages: "Claude · 5 hours", "Claude · this week" and the `fleet.usage_bars` rows, each with % used, reset time, a green/amber/red fill (below 70 / below 90 / from 90 %) and "as of …" when older than 10 min. Under the bot or room name a grey line: context size and %, cache % today, tokens and runs today, cost "at API prices". Both refresh when a run finishes; the strip also every 5 min. Hidden when the setting is off. | `RAKAZO_SUBSCRIPTION_LIMITS` | not yet |
| `34d1d5f` Add a recall-only Hindsight memory provider (new, `patch/memory-provider`) | A `hindsight` memory provider (Settings → memory: base URL, banks, never-recall tags, API key). Recall asks each bank (default `fleet`, `knowledge`, `public`) at `/v1/default/banks/{bank}/memories/recall` with `tag_groups: [{"not": {"tags": [...], "match": "any_strict"}}]` (default tags `pii:person`, `embargo:security`) and merges the results by score up to the limit; it gives up after 8 s. Saving, forgetting and history purges are refused ("use memory_save (fleet MCP)"); providers now say whether they save, so history compaction and clearing a chat skip Hindsight. Like Supermemory local mode, it needs a private address and the deployment owner. New UI strings need `intl:extract`. | none (choose the provider in the Space's memory settings) | not yet |
| `fb46c80` Recall on every run and keep `remember` with a memory provider (new, `patch/memory-provider`) | With the setting, automatic recall runs on every run (routine, creation intro, webhook, messaging), not only in compacted chats; the query is the incoming prompt trimmed to 2000 characters. If Hindsight times out or fails, the bot gets one line: "Shared memory is unavailable right now; say so if it matters". Always (no setting): a bot keeps `remember` when a provider is connected; with Hindsight it gets `recall_memory` but no `save_memory`/`forget_memory`. | `RAKAZO_MEMORY_RECALL_EVERY_RUN=true` for every-run recall (unset = recall only in compacted chats) | not yet |
| `ca89d46` Room tools (new on `patch/rooms`) | Builtins `room_create` (3–6 bots, leader first, `roomKind`, `caseNumber`), `room_update`, `room_post` (posts as the bot, wakes named members or the leader), `room_archive`, `room_list` (members with busy status). Never offered to subagents or ticket runs. The group archive teardown moved out of `router.ts` into `archiveGroupWithTeardown`. | `RAKAZO_ROOM_TOOL_BOTS` (comma bot ids; unset = per-bot disabled tools decide) | not yet |
| `98d815d` Bot @-mentions wake group members | A bot's final group reply wakes the members it @-mentions (never itself, no first-member fallback); a busy member is steered; run nonce `group-mention:<runId>:<botId>`; archived or paused rooms are skipped. | none | not yet |
| `8c640dc` Room brake | Runs per group thread in 24 h (since `budgetResetAt`) over the limit set `pausedAt` and refuse bot-started runs; Rens's sends are exempt. One message wakes at most N bots. `room_resume` works once per pause; then only Rens via `groups.resume` / "Resume room". Migration `20261019121000_chat_group_room_brake_notify` adds `pausedAt`, `budgetResetAt`, `budgetResumes`, `notify` (renamed from `20261019120000_…`, which `patch/usage` also used). | `RAKAZO_ROOM_MAX_RUNS_PER_DAY`, `RAKAZO_ROOM_MAX_WAKES` (unset = no limit) | not yet |
| `4c7065d` Handoff steers a busy target | `handoff_to_bot` steers a member already running in the thread instead of starting a second run, and respects the brake. | none | not yet |
| `3014a6c` Author names in group history | Another bot's message is a `user` turn `[Name] …`, Rens's `[Rens] …`; handoffs render names; web names fall back to the space's bots. | none | not yet |
| `bc2d0af` message_bot in groups | `message_bot` is offered in group threads. | none | not yet |
| `aca0d73` + `ba8622c` Per-room push | A group run's finish/failure push, the stuck-work reminders and stopped notices, and the activity list's bell follow the room's `notify` switch (`runPushEnabled` in `packages/core/src/run-push.ts`); help (cards, approvals, asks) and takeover pushes always go out, so a muted room never hides a question. Outside rooms the bot's "notify on finish" still decides. `notify` is on `Group`/`groups.update`; web group settings and the mobile group settings get a "Notifications for this room" switch. | `chat_groups.notify` (default off) | not yet |
| `5de442d` Archived rooms readable | `getGroupTarget`/`resolveThreadTarget` take `includeArchived`; `threads.head`, `threads.get` and `threads.messages` pass it, so an archived room's history loads. The web opens an archived room from the Archived list read-only: history, an "Archived" note, no composer and no group settings; Restore and Delete stay. Writes still refuse archived rooms. | none | not yet |
| `55331de` Sidebar: "Working…" only while a run works; orange dot when a chat needs your answer or is unread (new, `patch/status-dot`) | "Working…" (and its colour) shows only for a `queued`, `leased` or `running` run. The roster now also reloads on `run.waiting_input` and `computer.takeover.requested`, so a bot that asked a question no longer keeps "Working…" until the next run event. A bot or room whose newest run is `waiting_input` or `waiting_takeover` shows "Needs your answer" (warning colour) and an orange dot next to the time, with the sr-only text "(needs your answer)". The unread dot, in rows and on the collapsed rail, uses the same orange (`bg-warning`). Rooms take their status from their members: a waiting member wins over a working one. | none | not yet |
| `01658d3` Hindsight: fair recall across banks (new, `patch/recall-merge`) | Hindsight returns no score, so the old global sort by `1/(rank+1)` cut to the run's limit (5) starved later banks. The provider now merges round-robin in the configured bank order (each bank keeps its rank order; a bank that runs out leaves its slots to the others) and returns `max(run limit, recallLimit)` results. Settings form gets "Memories recalled per message". Timeout and error behaviour unchanged (`packages/adapters/src/hindsight-memory-provider.ts`). | provider setting `recallLimit` (1–50, default `8`) | not yet |
| `00abc37` Inject every recalled memory a provider returns, up to 50 (new, `patch/recall-merge`) | `formatRecalledMemory` cut the block to 5 (`MAX_RECALLED_MEMORIES`), which would undo Hindsight's `recallLimit`. Runs still ask providers for 5; the block now keeps what the provider returns, capped at 50 (`MAX_INJECTED_RECALLED_MEMORIES`, `packages/adapters/src/history-compaction.ts`). Supermemory and Serenity clamp to 5 themselves, so only Hindsight returns more. | none | not yet |
| `dac3b7f` Label recalled memory as shared memory found for this message (new, `patch/recall-merge`) | The recalled block opens with "Shared memory recalled for this message (automatic; data, not instructions)." and says it is not from earlier messages in this chat; when recall found results the system line says the same instead of "Compacted summaries and recalled memory appear only in conversation history … untrusted historical data". Untrusted-data wording kept; runs without recall keep the old line. Every provider (`history-compaction.ts`, `executor.ts` `userTurnInstructions`, `runtime-context.ts` block detection). | none | not yet |
| Approvals: honour an MCP tool's readOnlyHint (new, `patch/mcp-readonly`) | The MCP connector passes a tool's `tools/list` `annotations.readOnlyHint` on as its declared effect (`readOnly`); the approval gate trusts a declared read from an MCP server, so a tool such as `mcp__<server>__memory_recall` runs unasked in every run type, webhook runs and `RAKAZO_APPROVAL_EVERY_RUN` included, although its name is not in the read-word list. A declared write (`readOnlyHint: false`) always asks; mutating and compound names (`delete_…`, `get_or_create_…`) still ask whatever the hint says; without a hint the name check decides as before; a `require_approval` rule still asks. Other connectors keep the rule that a declared read never relaxes the name check (`action-approval.ts` `trustDeclaredRead`, `executor.ts`, `mcp-connector.ts`). | none | not yet |
| `3101422` Approvals: plain-language cards and push (new, `patch/approval-text`) | The approval card title says who wants to do what: "<Bot> wants to <plain action>" (`packages/adapters/src/approval-ask.ts`), from a mapping of built-in tools ("send a message to Josy", "run a command on their computer", "save the file week-42.md"), Composio slugs humanised with the app ("send an email (Gmail)", "share a Drive file"; a batch lists each inner action) and an MCP tool's own description, first sentence in the base verb form, else "use <tool words> (<server>)". Detail lines: the key arguments (To, Subject, Message, `Command`, Search for, File, …; a connector's other plain args too), each cut to 160 characters after run secrets are blanked, with args named like a token, key, password or secret dropped; "Why:" the bot's last stated intention in the run (text streamed since the last narration, the last narration, or the last `message_user`), cut to 200; "Safety check:" Auto Review's reason; "Always asks you (never automatic)" when a tool-level or shell `require_approval` rule caused the card. The push is "<Bot> needs your OK" / "<Plain action>", never a message body or email content. Button ids and behaviour are unchanged. The web card shows the detail lines with bold, translated labels and the command in code style (`ApprovalDetail.tsx`); mobile shows the same text. | none | not yet |
| Sidebar: labelled attention badge on avatars in the collapsed rail (new, `patch/collapsed-dot`) | In the avatar-only rail a bot or room that needs your answer or has an unread reply shows the orange dot (`bg-warning`) top right of its avatar, ringed in the sidebar colour (`border-sidebar`). Same condition as the expanded row's dot (`needsAnswer \|\| unread`). The badge (`apps/web/src/components/RosterAttentionBadge.tsx`) carries the label ("Needs your answer" or "unread", existing strings), so the row's sr-only text is skipped in the rail. Expanded sidebar unchanged. | none | not yet |
| @mentions in the mentioned bot's colour (new, `patch/mention-color`) | In rendered message text (bot Markdown and people's plain-text messages, web and mobile), `@<BotName>` of one of the space's bots shows in that bot's avatar colour, medium weight: the persona's darker stop on the light theme (darkened further when pale, as for Staff White) and its lighter stop on the dark theme (`botMentionTextColors` in `packages/core/src/bot-avatar-colors.ts`). Names match case-insensitively, longest first, on word boundaries (`mentionParts` in `packages/chat-ui/src/markdown.ts`); code spans and blocks, links, URLs and email addresses stay plain, unknown names stay plain. The web Shell and the mobile thread provide the space's bots through `MentionBotsContext`. Display only: stored text and mention wakes are unchanged. | none | not yet |
| Click a bot mention or speaker to open its 1:1 chat (new, `patch/mention-open`) | A coloured `@Bot` mention becomes a button-like inline element when the app supplies `MentionOpenBotContext` (`{ onOpenBot, label }` in `packages/chat-ui/src/markdown.ts`, so chat-ui stays router-free): on web `role="button"`, focusable, Enter/Space, hover underline, label "Open chat with {name}"; a click that ends a drag-select (`hasTextSelection`) does not navigate. Mobile mentions open on tap. The speaker avatar plus name above a bot message is one button on web (`MessageView` in `Shell.tsx`) and a tappable name on mobile (`thread.tsx`). Web opens `/app/<botId>` through `openBotChat` (`apps/web/src/pages/shell/open-bot-chat.ts`, closes the mobile drawer), mobile pushes the `/thread` route; in that bot's own 1:1 chat both do nothing. Without the context mentions stay plain coloured text; links, code, emails and stored text are unchanged. | none | not yet |
| Sidebar: WhatsApp-style recency block at the top (new, `patch/roster-order`) | Every bot with any activity (a message, a `queued`/`leased`/`running` run, waiting for Rens's answer with `waiting_input`/`waiting_takeover`, or an unread reply) leaves its pinned slot or folder and renders first, above Pinned, in one block without a heading, newest activity first. It stays there when done: a newer active bot simply goes above it. Activity time is the latest of the newest message time (new roster field `lastMessageAt`, null for a chat without messages; `updatedAt` falls back to the bot record's own update time, so it cannot tell "no activity") and live bumps seen by the client (starts working, starts waiting, a new unread reply), so a bot jumps to the top before its first message lands. Page-load order comes from the server times, so it is the same across reloads and devices apart from a live bump not yet on the server. Bots without any activity stay in Pinned or their folder; on the web an emptied folder keeps its header as for any empty folder (not during search), an emptied Pinned or Unassigned is hidden. Rooms never move. `trackRosterActivity` only changes its state (same map reference otherwise) on a real change, so polls do not reshuffle; ordering is the pure `orderRosterWithActiveFirst` (`packages/core/src/roster-active-order.ts`). Rows in the top block cannot be dragged, dropped on or Alt+Arrow reordered: its order is a view, not the saved roster order. Same order in the avatar rail, the phone drawer and the mobile inbox. | none | not yet |
| Recover runs orphaned by a worker restart (new, `patch/orphan-recover`) | Once at worker start-up, after the graphile runner is up (its pool and worker ids are captured from `pool:create`/`worker:create` in `GraphileJobWorkerHost`), `recoverOrphanedJobs` (`packages/adapters/src/orphan-recovery.ts`) reads graphile jobs locked by any other id. With one worker service those workers are dead. For each such `run.continue` job whose run is `leased`/`running` it sets the run's `leaseExpiresAt` to now (the fence stays), so `continueRun` reclaims it at once, then calls `graphile_worker.force_unlock_workers(<dead ids>)`; other jobs of a dead worker are only unlocked. Logs one line per recovered run (run, bot, old worker id) and the count. Without it a run caught by a deploy stays `running` until graphile frees the lock after 4 hours (incident 19 Oct, Isabella). Not safe with more than one worker service. | `RAKAZO_WORKER_RECOVER_ON_START=true` (unset = upstream) | not yet |
| Fleet: notes for `fleet-next` | This file. Never sent upstream. | — | — |

### Dropped patches (merged upstream)

Line numbers are in `fleet-next`.

| `fleet` commit | Upstream commit | Why it is dropped |
|---|---|---|
| `7182094` Drop mid-turn narration in bot-to-bot runs | `5b35ea7` (#1451) | Same rule: `runPromotesMidTurnNarration` excludes `bot_message` (`packages/adapters/src/executor.ts:8651-8653`). Upstream also keeps the last held-back narration as the reply when a `request`/`question` run ends empty (`executor.ts:7683-7693`). |
| `398b97a` hop-limit half | `c647a04` (#1452) | `BOT_MESSAGE_MAX_HOPS` with default 6 is upstream code, identical to ours (`packages/core/src/bot-messages.ts:14-21`, `:53-55`; `apps/api/src/team-chat-bridge.ts:983`). The `fyi` half is kept as `dfd266d`. |
| `8bcffb4` Make the message_user length cap configurable | `da0a7c0` (#1453) | `RAKAZO_MESSAGE_USER_MAX_CHARS` drives the tool schema and description, the truncation and the system-prompt guidance (`packages/adapters/src/user-progress.ts:27-36`, `builtin-tools.ts:395,403`, `executor.ts:6719,8636`). Upstream parses more strictly: only plain digits count (`1e3` or `0x10` now mean the default 500). The current `4000` is fine. |
| `b0c611d` Keep the prompt cache when a user message arrives mid-run | `16b99f2` (#1450) | Byte-identical diff (`packages/adapters/src/runtime-context.ts:231-233,383`). |

Related upstream issues are closed too: [#1454](https://github.com/elie222/rakazo/issues/1454)
(fixed by `a1c5e4f`, #1461) and [#1455](https://github.com/elie222/rakazo/issues/1455)
(fixed by `c7a1f01`, #1463).

### Conflicts resolved during the replay

- `398b97a` (fyi and hop limit): every conflict was in the hop-limit code, so upstream's
  version was taken in `.env.example`, `apps/api/src/team-chat-bridge.ts`,
  `docs/self-host.md`, `packages/core/src/bot-messages.ts` and both bot-message tests, and only
  `DEFAULT_BOT_MESSAGE_INTENT` plus its test were added back.
- `bb6efae` (Forward to bot), `.env.example`: kept upstream's `BOT_MESSAGE_MAX_HOPS` lines and
  our `RAKAZO_FLAG_*` lines.
- `fd363f3` (flag never answers an ask), `packages/db/src/events.ts`: upstream added
  webhook steering (`originTrigger: "webhook"`, run trigger `webhook`). Both kept: a `flag` row
  still runs as `follow_up` and a `webhook` row as `webhook` (`createPendingSteeringRun`), and
  `steeringOrigin` checks both before the messaging/app split.
- `d5c7ece` (thinking), `packages/adapters/src/executor.ts` `publishMidTurnNarration`:
  upstream #1401 resets `assembled = ""` after publishing narration; kept that and our thinking
  split before `publishMessage`.

Applied without conflicts but worth knowing: the run budget now sits inside upstream's
OpenTelemetry wrapper (`withPiTelemetry`) in `packages/adapters/src/pi-runtime.ts`, and the
silent `NO_RESPONSE` finish sits after upstream's held-back narration in `executor.ts`.

The room patches are the first fleet patches with a database migration (`chat_groups` columns). Rolling them back needs a database restore (or dropping the four columns by hand). Every env setting defaults to upstream behaviour.

## Deploying `fleet-next`

The deployment runs `rakazo-fleet/app:d93d461` (fleet `d93d4611`) with
`ghcr.io/elie222/rakazo/computer:edge`. Moving to `fleet-next` changes three things.

### 1. Database migrations

Upstream added three Prisma migrations between `d93d461` and `fleet-next`. The api service
applies them at start-up (`prisma migrate deploy`):

| Migration | Upstream | Change |
|---|---|---|
| `20261011120000_bot_instruction_history` | `a03e0f5` (#1316) | `bots`: adds `selfUpdateInstructions` (boolean, default false), `instructionHistory` (jsonb, default `[]`), `pendingInstructionsRunId` (text) |
| `20261014120000_run_retry_of_run` | `e2599a7` (#1397) | `runs`: adds `retryOfRunId` (text) |
| `20261014120001_runs_retry_of_run_id_key_concurrent` | `e2599a7` (#1397) | `CREATE UNIQUE INDEX CONCURRENTLY "runs_retryOfRunId_key"` on `runs` |
| `20261019120000_subscription_limit_readings` | fleet `2f94229` | new table `subscription_limit_readings` (provider, five_hour_util, five_hour_reset_at, seven_day_util, seven_day_reset_at, status, observed_at) with an index on (provider, observed_at). The first fleet migration; it only adds a table, which an older image ignores. |

Their timestamps are older than the newest migration already in the database
(`20261015120000_organic_avatar_default`); `migrate deploy` applies migrations that are
missing, whatever their date.

The inspect views (`D:/fleet/rakazo/inspect/sql/views.sql`) read `bots` (`v_bots`) and `runs`
(`v_runs`), but only named columns, and these migrations only add columns and an index.
Nothing a view uses is dropped or changed, so the migrations do not collide with the views.
Still follow the usual order (it costs nothing):

```bash
cd D:/fleet/rakazo/inspect
sql/apply.sh sql/drop.sql     # before the switch
# ... switch the image ...
sql/apply.sh                  # after the api is healthy
```

Rollback: once these migrations ran, go back by restoring the backup taken before the switch
(see "Roll back"). The old image would most likely still start on the added columns, but
that is untested.

### 2. Pin the computer image

Bot computers come from `RAKAZO_COMPUTER_IMAGE:RAKAZO_COMPUTER_IMAGE_TAG`. Compose joins the
two with `:` (`infra/compose/docker-compose.images.yml:37,70`) and passes the result to the
supervisor as `RAKAZO_COMPUTER_IMAGE`
(`infra/sandboxes/supervisor/src/computer-spec.ts:6`).

- The supervisor never pulls. Before it starts a computer, it looks for the image locally
  (`infra/sandboxes/supervisor/src/index.ts:1102-1107`). If the image is missing, it builds it
  from the computer source inside the app image and gives it that name (`index.ts:1111-1142`).
- An existing bot computer is kept only while its image id equals the configured image's id
  (`index.ts:227,257`); otherwise the computer container is replaced (the home volume stays).
- The only pull is Compose's pull-only `computer` stub (`docker-compose.images.yml:36-40`),
  which pulls when the image is missing, unless `--pull never` is given; `docker compose pull`
  and `install-images.sh` pull it too.
- A digest works for the supervisor (`docker image inspect
  ghcr.io/elie222/rakazo/computer@sha256:ba4a…` resolves locally), but the `:` Compose puts in
  between means `RAKAZO_COMPUTER_IMAGE_TAG` cannot carry a bare digest. A local tag works.

Which version: `fleet-next` changes nothing under `infra/sandboxes/computer` since `7d5e64c`
(`git log 7d5e64c..fleet-next -- infra/sandboxes/computer` is empty), so it needs the same
computer image the deployment runs now: the local `ghcr.io/elie222/rakazo/computer:edge`, id
`sha256:ba4a7801eda4c7cad20e380631a0ca58963e5acd5a815b8ecdf5f9c012a6aadd`, label
`org.opencontainers.image.revision=7d5e64c886da7d556673f99e4923b013315007a9`. On GHCR that is
`computer:sha-7d5e64c886da7d556673f99e4923b013315007a9`. GHCR's `:edge` has moved on (index
`sha256:ebb1bf72…` on 2026-10-18), so any pull of `:edge` would bring a computer that no
longer matches the app.

Pin it under a local name before switching:

```bash
docker tag ghcr.io/elie222/rakazo/computer@sha256:ba4a7801eda4c7cad20e380631a0ca58963e5acd5a815b8ecdf5f9c012a6aadd \
  rakazo-fleet/computer:7d5e64c
docker image inspect rakazo-fleet/computer:7d5e64c --format '{{.Id}}'   # sha256:ba4a7801…
```

and in `D:/rakazo/.env`:

```env
RAKAZO_COMPUTER_IMAGE=rakazo-fleet/computer
RAKAZO_COMPUTER_IMAGE_TAG=7d5e64c
```

The supervisor finds this tag locally and neither pulls nor builds. The image id is the same
as now, so the existing bot computers are kept. Do the `docker tag` first: if `.env` names a
tag that is not on this PC, the supervisor builds a new computer image and replaces every
bot computer, and `compose up` without `--pull never` fails to pull `rakazo-fleet/computer`.
When a later upstream changes `infra/sandboxes/computer`, take the matching
`computer:sha-<upstream commit>` from GHCR (or build `infra/sandboxes/computer`) and tag it
the same way.

### 3. Other settings

- `MAX_UPLOAD_SIZE_MB` (upstream #1440, default 10) sets the upload and `attach_file` limit.
  Only needed to change it: add it to `.env`, and to the `supervisor` service's `environment:`
  in `D:/rakazo/docker-compose.images.yml` as `MAX_UPLOAD_SIZE_MB: ${MAX_UPLOAD_SIZE_MB:-10}`,
  as upstream's compose file now does.
- The `.env` lines of `d93d461` stay as they are (`RAKAZO_MESSAGE_USER_MAX_CHARS=4000`,
  `RAKAZO_FLAG_*`, `RAKAZO_RUN_MAX_*`, the tailnet URLs with `RAKAZO_EXTRA_ORIGINS` and
  `RAKAZO_SECURE_COOKIES=false`).
- `RAKAZO_SUBSCRIPTION_LIMITS=true` turns on the usage bars (#18). The worker captures the
  readings and the api serves them, so both need it (both read `.env`).

### Order of the switch

1. Build and test the image from `fleet-next` (see "Rebuild the image"); tag `<TAG>` is
   `git rev-parse --short=7 fleet-next`.
2. Check no run is active and back up the database ("Switch", steps 1 and 2).
3. `sql/apply.sh sql/drop.sql` in `D:/fleet/rakazo/inspect`.
4. `docker tag` the computer image as above.
5. In `D:/rakazo/.env`: `RAKAZO_IMAGE_TAG=<TAG>` and the two computer image lines.
6. `docker compose --env-file .env -f docker-compose.images.yml up -d --pull never`; wait for
   the api to be healthy (it runs the migrations first).
7. `sql/apply.sh` in `D:/fleet/rakazo/inspect`.

## Adopt `fleet-next`

Once the `fleet-next` image runs well, make it the `fleet` branch:

```bash
cd D:/rakazo-fork
git tag fleet-20261018-before-update fleet
git branch -f fleet fleet-next
git push --force-with-lease origin fleet
```

## Rebuild the image

```bash
cd D:/rakazo-fork
git switch fleet-next
TAG=$(git rev-parse --short=7 HEAD)
docker build -f infra/compose/Dockerfile \
  --build-arg GIT_SHA=$(git rev-parse HEAD) \
  --label org.opencontainers.image.revision=$(git rev-parse HEAD) \
  --label org.opencontainers.image.source=https://github.com/RensTillmann/rakazo \
  -t rakazo-fleet/app:$TAG .
```

This uses upstream's own Dockerfile, the same one GitHub uses for
`ghcr.io/elie222/rakazo/app`. Only the `app` image is rebuilt. It runs the api, worker,
supervisor and web services. The `computer` image is not affected by our patches; see
"Pin the computer image".

### Run the tests in the image

```bash
docker run --rm --user root --network none --entrypoint '' rakazo-fleet/app:$TAG \
  pnpm exec vitest run packages/core/src packages/adapters/src apps/api/src apps/worker/src
```

All tests must pass before switching. Web tests that render React need `NODE_ENV=test` (the
image sets `production`): add `-e NODE_ENV=test` and list the web test files, for example
`apps/web/src/components/ArtifactFileCard.test.tsx`.

## Switch the deployment to the fork image

1. Check that no bot is in the middle of a run (restarting the worker interrupts it):

   ```bash
   docker exec -i rakazo-postgres-1 psql -U rakazo -d rakazo -At \
     -c "SELECT status, count(*) FROM runs WHERE status IN ('running','queued') GROUP BY status"
   ```

   No output means nothing is running.

2. Back up the database:

   ```bash
   cd D:/rakazo
   docker exec rakazo-postgres-1 pg_dump -U rakazo -Fc rakazo > backups/pre-fleet-$(date +%Y%m%d-%H%M).dump
   ```

3. In `D:/rakazo/.env`, set `RAKAZO_IMAGE=rakazo-fleet/app` and `RAKAZO_IMAGE_TAG=<TAG>`.

4. Recreate the services. `--pull never` matters: `rakazo-fleet/app` and
   `rakazo-fleet/computer` exist only on this PC, so a pull would fail.

   ```bash
   cd D:/rakazo
   docker compose --env-file .env -f docker-compose.images.yml up -d --pull never
   docker ps --format "{{.Names}}  {{.Image}}  {{.Status}}"
   ```

   `api`, `worker`, `supervisor` and `web` should show `rakazo-fleet/app:<TAG>` and become
   healthy.

While on the fork images:

- Do not run `docker compose pull` or `install-images.sh` without `--pull-never`.
- Ignore the update commands on Rakazo's Software update page; they pull upstream images.

## Roll back

Restore the backup from "Switch" step 2 when the switch added migrations (it does for
`fleet-next`), then put the previous image lines back in `D:/rakazo/.env`
(`RAKAZO_IMAGE_TAG=d93d461`; the computer lines may stay on `rakazo-fleet/computer:7d5e64c`,
the same image) and run `up -d --pull never` as above. Take the inspect views out first and
put them back afterwards.

Upstream `:edge` (`RAKAZO_IMAGE=ghcr.io/elie222/rakazo/app`, `RAKAZO_IMAGE_TAG=edge`) ignores
our settings. With the tailnet address as the main one (https `BETTER_AUTH_URL`), first put
`BETTER_AUTH_URL`, `WEB_ORIGIN` and `API_URL` back to `http://127.0.0.1:5173`: upstream ignores
`RAKAZO_SECURE_COOKIES`, renames the session cookie and signs everyone out.

## Take upstream updates

1. Look at what changed:

   ```bash
   cd D:/rakazo-fork
   git fetch upstream
   git log --oneline fleet-next..upstream/main
   git diff --stat $(git merge-base fleet-next upstream/main) upstream/main -- packages/db/prisma/migrations infra/sandboxes/computer
   ```

   Migrations mean a backup-restore rollback and a check against the inspect views;
   computer changes mean a new pinned computer image.

2. For each upstream PR of ours that merged, check that upstream covers the behaviour, then
   drop or shrink the commit. Replay the rest onto the new upstream on a new branch, one
   commit per patch (`git cherry-pick -x <commit>`), keeping both upstream's and our
   behaviour on conflicts. Record the base, the table and the conflicts here.

## Adding a patch

Each patch is one commit with its tests, written so it could go upstream on its own. To send
one upstream as its own PR, start from current upstream `main`:

```bash
cd D:/rakazo-fork
git fetch upstream
git switch -c pr/<name> upstream/main
git cherry-pick <commit>          # fix conflicts if upstream moved, then run the tests
git push -u origin pr/<name>
gh pr create --repo elie222/rakazo --base main --head RensTillmann:pr/<name>
```

Then put the PR number in the table above.
