# Fleet build of Rakazo

This is Rens's fork of [elie222/rakazo](https://github.com/elie222/rakazo):
[RensTillmann/rakazo](https://github.com/RensTillmann/rakazo).

- `main` follows upstream `main`. We never commit to it.
- `fleet-next` (this branch) is a newer upstream plus our patches, one commit per patch. It is
  **running** since 18 Oct 2026: image `rakazo-fleet/app:5e8f647` (head `5e8f6471`, base upstream
  `76f4259`), computers pinned to `rakazo-fleet/computer:7d5e64c`. Full suite, web tests and `tsc`
  for every package passed in that image. Rollback needs the `pre-fleet-next-20261018.dump`
  restore (upstream migrations ran).
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

None of the patches touch the database. Every setting defaults to upstream behaviour.

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
