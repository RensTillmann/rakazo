# Fleet build of Rakazo

This is Rens's fork of [elie222/rakazo](https://github.com/elie222/rakazo):
[RensTillmann/rakazo](https://github.com/RensTillmann/rakazo).

- `main` follows upstream `main`. We never commit to it.
- `fleet` is upstream plus our own patches, one commit per patch. The images the
  deployment in `D:/rakazo` runs are built from `fleet`.

All commands are for Git Bash on this PC.

## What is on `fleet`

The base is upstream commit `7d5e64c` ("Report a timed-out page browser as a timeout
instead of unavailable (#1411)"), which is the version the published `:edge` image
was built from on 2026-10-15. On top of it:

| Commit | What it changes | Setting | Upstream PR |
|---|---|---|---|
| Drop mid-turn narration in bot-to-bot runs | Text a bot writes just before a tool call is no longer saved as a chat bubble in runs started by another bot's message (`bot_message`). It still shows briefly as the live "working…" line. Runs Rens starts are unchanged. | none | [#1451](https://github.com/elie222/rakazo/pull/1451) |
| Default message_bot to fyi and make the hop limit configurable | A `message_bot` call without an `intent` is sent as `fyi` (no automatic reply back), not `request`. The bot-to-bot chain limit can be changed. | `BOT_MESSAGE_MAX_HOPS` (default 6) | Hop limit only: [#1452](https://github.com/elie222/rakazo/pull/1452). The `fyi` default stays fleet-only. If #1452 merges, take upstream's version of the hop limit and keep only the `fyi` default in this commit. |
| Make the message_user length cap configurable | The 500-character cap on `message_user` can be raised. The tool schema, the tool description, the truncation note and the system-prompt guidance all state the configured number. Mid-turn narration keeps 500. | `RAKAZO_MESSAGE_USER_MAX_CHARS` (default 500) | [#1453](https://github.com/elie222/rakazo/pull/1453) |
| Keep the prompt cache when a user message arrives mid-run | Messages added during a run (the empty-reply continuation, steering, finished-shell notices) get their own slot instead of pushing the oldest history message out, so the earlier conversation stays byte-identical and is read from the prompt cache instead of re-written. History cap and tool-result shortening unchanged. Replay of the 17 Oct ticket: about 22% cheaper. | none | [#1450](https://github.com/elie222/rakazo/pull/1450) |
| Add a Forward to bot message action behind RAKAZO_FLAG_BOT (`bb6efae`, merged in `d8343bd`; flag never answers an ask: `fd363f3`, merged in `a55ea97`) | A bot message's More menu gets an extra item that opens a small window with an optional note and Send. Send posts one message, in Rens's name, in the chat of the bot named in the setting, and wakes that bot. The message holds the note, which bot and chat it came from, the message id, run id and time, a link to the message, and the first 500 characters of it. Without the setting the item is hidden and the server refuses. The forwarded message is always a new request: if that bot is busy or waiting on a question card (for example Apply / Later / Drop), the card stays open and the message waits, then starts its own run when the bot's current run ends. | `RAKAZO_FLAG_BOT` (bot name or id; unset = off), `RAKAZO_FLAG_LABEL` (menu label, default "Forward to bot…") | not yet |
| Stop a run at a configurable budget and let the bot write one final line (`4b262a8`, merged in `85344bc`) | A run stops after a maximum number of model calls or minutes, whichever comes first. Then tools are off, the bot gets one last turn to write one line (what it did and what is blocked), and the run ends as completed with that line. If that last turn fails, the run ends with a fixed line instead ("I stopped because this task reached its limit…"). A tool that is already running is not cut off: a hung shell command runs until its own 5-minute timeout and that time counts. Only the bot's own model calls count, not a subagent's. | `RAKAZO_RUN_MAX_MODEL_CALLS`, `RAKAZO_RUN_MAX_MINUTES` (each unset = no limit) | not yet |
| Refuse shell commands that start a browser for a bot without browser tools (`dccb3e1`, merged in `419b22b`) | For a bot whose browser is off (`browser_navigate` among its turned-off tools), the shell refuses a command that starts `chromium`, `chrome`, `google-chrome`, `firefox`, `playwright` or `puppeteer`, also by path (`/usr/bin/chromium`), after `timeout`, `xvfb-run`, `env` or `nohup`, through `npx`, or inside `bash -c`. The bot reads: "This bot has no browser. Hand the task to a teammate who has one (see your teammates list)." A browser word elsewhere (`git log --grep chrome`) is fine. Not caught: a browser started from inside a script. Bots with the browser on are unchanged. | none (follows the bot's browser switch) | not yet |
| Mark mid-turn narration and let the user toggle it ("Show thoughts") (`285ba19`, merged in `db6ebaa`) | In runs Rens starts, text a bot writes just before a tool call is still saved as a chat message, but marked as narration. The chat header gets a "Show thoughts" button (lightbulb), stored per browser, default off: off hides that narration (and messages made only of it); on shows it small, grey and italic. `message_user` updates, question cards and final replies are never marked; older messages show as before. The live "working…" line is unchanged. Bot-to-bot and routine runs still drop narration. | none (per-browser toggle) | not yet |
| Show attach_file images and files from bot-to-bot runs (`5a6000d`, merged in `e2ae2d7`) | In runs started by another bot's message (`bot_message`), the `image` and `file` blocks a bot attaches with `attach_file` now show in the chat, in history and live without a page refresh, like its text reply and question cards already did. Before, they were saved in the thread but hidden. Steps, tool activity and narration of those runs stay hidden; background (ticket) runs, peer receipt chips and the sidebar preview are unchanged. | none | not yet |
| Finish silently on NO_RESPONSE in every run that may finish empty (`db6b42d`, merged in `ad7ac73`) | A bot woken by a teammate's `fyi` (or by a messaging-channel message) that answers exactly `NO_RESPONSE`, once or repeated, now finishes with no chat bubble, as routines already did. Before, the word showed up as a message. Such a run that ends with only tool steps posts nothing either. A `request` or `question` still gets `NO_RESPONSE` back as its result, as before. | none | not yet |
| Keep the model's thinking behind "Show thoughts" (`d5c7ece`, merged in `ad7ac73`) | The bot's own reasoning (what the model thinks before it writes or calls a tool) is now saved with its messages in runs Rens or another bot starts, in order: with a narration message, between the tool steps, and before the final reply. The lightbulb shows it small, grey and italic, folded to three lines with "Show more"; off hides it. It is never sent back to a model and never shows up in another bot's message, a notification, the sidebar preview, search or the bot export. Each piece is cut at 8,000 characters (marked as cut), and secrets the run knows are blanked out. Claude Sonnet 5.5 decides by itself when to think, so short easy replies often have none. Routine and ticket runs keep none, and a silent finish (`NO_RESPONSE`) keeps none either. The mobile app hides it. | none (the same per-browser toggle) | not yet |
| Trust extra web origins from RAKAZO_EXTRA_ORIGINS (`6d8921b`, merged in `6d97ffa`) | The chat can be opened from a second address, here the phone over Tailscale (`https://g16.tail5f04cd.ts.net:5173`), next to `http://127.0.0.1:5173` on the PC. Each origin in the setting is trusted like `WEB_ORIGIN` for sign-in, sign-out, session and RPC calls; any other origin is still refused. `WEB_ORIGIN`, the cookie name and cookie settings stay as they were, so the PC session stays valid. The computer screen and terminal load from the address the page was opened on. The images compose file passes `RAKAZO_ALLOWED_HOSTS` to the web service. Still tied to `WEB_ORIGIN` (they open the PC address): the link in a "Forward to bot" message, connecting an app or an MCP server that signs in through OAuth (start those on the PC), and password-reset or verification e-mail links. | `RAKAZO_EXTRA_ORIGINS` (origins, comma-separated) with `RAKAZO_ALLOWED_HOSTS` (host names, for Vite) | not yet |
| Play attached screen recordings inline in the web chat (`a67fd29`, merged in `6d97ffa`) | `attach_file` used to refuse `.webm` and `.mp4` ("unsupported attachment type"). They are now allowed as `file` blocks (`video/webm`, `video/mp4`; `.m4v` counts as mp4) within the existing 10 MiB attachment limit, so they also show from bot-to-bot runs. The web chat plays a video file block (a `video/*` type, or a video file name when the stored type is generic) in an inline player with controls, loaded once it scrolls near the screen, with name, size and a download button under it. Other files keep the download chip. People can also upload `.webm`/`.mp4` files to a bot themselves. The mobile app shows videos as a file. | none | not yet |
| Pin session cookie security with RAKAZO_SECURE_COOKIES (`2f4b717`, merged in `d93d461`) | Lets the tailnet address be the main address (`BETTER_AUTH_URL`, `WEB_ORIGIN` and `API_URL` = `https://g16.tail5f04cd.ts.net:5173`) with `http://127.0.0.1:5173` kept as an extra origin. Normally an https `BETTER_AUTH_URL` makes Better Auth rename the session cookie to `__Secure-better-auth.session_token` and mark it `Secure`, which signs everyone out (the old cookie is no longer read). With the setting `false`, both addresses keep the plain `better-auth.session_token` cookie, so existing sessions stay valid and sign-in, sign-out, session and RPC work from both. `true` forces secure cookies, unset keeps upstream's choice, any other value stops the API at start-up. An extra loopback origin now also brings its `localhost` twin into the sign-in check (the CORS check already did), so `http://localhost:5173` keeps working. The links Rakazo writes (Forward to bot, connecting an app, reset and verification e-mails, the computer screen) then use the tailnet address, which opens on the phone and on the PC. Still main-address only: starting an MCP server's OAuth sign-in (from `127.0.0.1` it says "MCP OAuth redirect URI is not allowed"; open the tailnet address on the PC). | `RAKAZO_SECURE_COOKIES` (`true`/`false`, unset = upstream) | not yet |
| Fleet: how to build, switch and update | This file. Never sent upstream. | — | — |

Related upstream issues (no fleet patch): [#1454](https://github.com/elie222/rakazo/issues/1454)
(final reply joins text from separate turns) and
[#1455](https://github.com/elie222/rakazo/issues/1455) (sidebar time shows the bot's last
settings change). The PRs were opened from the `pr/*` branches on the fork, based on
upstream `7f9b9ad`. `pr/message-user-max-chars` already resolves the known #1401 conflict
(see "Take upstream updates"); copy that resolution when rebasing `fleet`. Once a PR
merges, the rebase drops or shrinks the matching fleet commit.

None of the patches touch the database. Every setting defaults to upstream behaviour,
so an image built from `fleet` with no new settings behaves like upstream apart from the
narration and `fyi` changes, the browser lock (bots with the browser off), the hidden
thoughts (the "Show thoughts" toggle starts off), the attachments shown from
bot-to-bot runs, the silent `NO_RESPONSE` finish, the saved thinking and the
`.webm`/`.mp4` attachments.

**Running now (checked 18 Oct 2026):** image `rakazo-fleet/app:6d97ffa`, with the phone
address as an extra origin (see the previous build below). The first switch to the fork was
on 17 Oct to `rakazo-fleet/app:b0c611d`, with `RAKAZO_MESSAGE_USER_MAX_CHARS=4000` in
`D:/rakazo/.env`. Database backup taken just before that switch:
`D:/rakazo/backups/pre-fleet-20261017.dump`.

**Built and tested, not running (18 Oct 2026):** image `rakazo-fleet/app:d93d461` (fleet
at `d93d4611`) = `6d97ffa` plus `RAKAZO_SECURE_COOKIES`. To make the tailnet address the
main one, change these lines in `D:/rakazo/.env` (`RAKAZO_ALLOWED_HOSTS` stays; the compose
file needs no change):

```env
BETTER_AUTH_URL=https://g16.tail5f04cd.ts.net:5173
WEB_ORIGIN=https://g16.tail5f04cd.ts.net:5173
API_URL=https://g16.tail5f04cd.ts.net:5173
RAKAZO_IMAGE_TAG=d93d461
RAKAZO_EXTRA_ORIGINS=http://127.0.0.1:5173
RAKAZO_SECURE_COOKIES=false
```

Then switch as usual. Never set the https URLs without `RAKAZO_SECURE_COOKIES=false`: that
signs everyone out. The links then need `tailscale serve` to be running. With the old URL
lines the image behaves like `6d97ffa`. To go back, restore the three URL lines and
`RAKAZO_EXTRA_ORIGINS=https://g16.tail5f04cd.ts.net:5173`, drop `RAKAZO_SECURE_COOKIES`, and
switch back to `6d97ffa` if you like; sessions stay valid both ways.

Previous build: image `rakazo-fleet/app:6d97ffa` (fleet at `6d97ffa3`) = `ad7ac73` plus the
extra web origin (phone over Tailscale) and the videos in the chat. The phone address needs
in `D:/rakazo/.env`:

```env
RAKAZO_EXTRA_ORIGINS=https://g16.tail5f04cd.ts.net:5173
RAKAZO_ALLOWED_HOSTS=g16.tail5f04cd.ts.net
```

and the `web` service in `D:/rakazo/docker-compose.images.yml` needs the line
`RAKAZO_ALLOWED_HOSTS: ${RAKAZO_ALLOWED_HOSTS:-}` under `environment:`, as in
`infra/compose/docker-compose.images.yml` on `fleet` (the `web` service does not read
`.env` by itself; without that line the phone gets "Blocked request" from Vite). Without
these lines the image behaves like `ad7ac73` apart from the videos.

Previous build: image `rakazo-fleet/app:ad7ac73` (fleet
at `ad7ac73c`) = `e2ae2d7` plus the silent `NO_RESPONSE` finish and the saved thinking.
No new setting; it uses the same `.env` lines as `e2ae2d7`.

Previous build: image `rakazo-fleet/app:e2ae2d7` (fleet at `e2ae2d79`) = `db6ebaa` plus
attachments from bot-to-bot runs. No new setting; it uses the same `.env` lines as
`419b22b` below.

Previous build: image `rakazo-fleet/app:db6ebaa` (fleet at `db6ebaa2`) = `419b22b` plus
the "Show thoughts" toggle.

Previous build: image `rakazo-fleet/app:419b22b` (fleet
at `419b22b2`). On top of `b0c611d` it adds the Forward to bot action (the forwarded
message never answers an open question card), the run budget and the browser lock. It
replaces `rakazo-fleet/app:a55ea97` (Forward to bot only) and `rakazo-fleet/app:d8343bd`
(lacks the question-card fix; don't switch to `d8343bd`). To use it, switch to that tag
and add to `D:/rakazo/.env`:

```env
# Elena (dr-eggbot); the id keeps working if she is renamed
RAKAZO_FLAG_BOT=cmvag1iox00184epb1t9edqer
RAKAZO_FLAG_LABEL=Needs fleet improvement…
# Maximum per task: then one last line from the bot, run ends as completed
RAKAZO_RUN_MAX_MODEL_CALLS=40
RAKAZO_RUN_MAX_MINUTES=20
```

To send a patch upstream as its own PR, start from current upstream `main`:

```bash
cd D:/rakazo-fork
git fetch upstream
git switch -c pr/narration upstream/main
git cherry-pick <commit>          # fix conflicts if upstream moved, then run the tests
git push -u origin pr/narration
gh pr create --repo elie222/rakazo --base main --head RensTillmann:pr/narration
```

Then put the PR number in the table above.

## Rebuild the image

```bash
cd D:/rakazo-fork
git switch fleet
TAG=$(git rev-parse --short=7 HEAD)
docker build -f infra/compose/Dockerfile \
  --build-arg GIT_SHA=$(git rev-parse HEAD) \
  --label org.opencontainers.image.revision=$(git rev-parse HEAD) \
  --label org.opencontainers.image.source=https://github.com/RensTillmann/rakazo \
  -t rakazo-fleet/app:$TAG .
```

This uses upstream's own Dockerfile, the same one GitHub uses for
`ghcr.io/elie222/rakazo/app`. On this PC the first build took about 3 minutes; later
builds take 15–40 seconds because Docker reuses the installed packages. The image is
about 1 GB (Docker Desktop lists it as 4.5 GB, the same as the upstream image).

Only the `app` image is rebuilt. It runs the api, worker, supervisor and web services.
The `computer` image (the bots' desktops, `infra/sandboxes/computer`) is not affected by
our patches, so the deployment keeps using `ghcr.io/elie222/rakazo/computer:edge`.

### Run the tests in the image

```bash
docker run --rm --user root --network none --entrypoint '' rakazo-fleet/app:$TAG \
  pnpm exec vitest run packages/core/src packages/adapters/src apps/api/src apps/worker/src
```

All tests must pass before switching. (`pnpm test` in the repo runs the same tests, but
needs pnpm and a full install on Windows; the image already has everything.)

Web tests that render React need `NODE_ENV=test` (the image sets `production`): add
`-e NODE_ENV=test` and list the web test files, for example
`apps/web/src/components/ArtifactFileCard.test.tsx`.
`apps/web/src/lib/desktop.test.ts` ("keeps conversation header controls clickable") already
fails on `ad7ac73` (expects one match, finds two); the patches since do not touch it.

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

3. In `D:/rakazo/.env`, change these two lines:

   ```env
   RAKAZO_IMAGE=rakazo-fleet/app
   RAKAZO_IMAGE_TAG=<TAG>
   ```

   `<TAG>` is the tag you built, for example the value of `$TAG` above
   (`docker images rakazo-fleet/app` lists them). Then add:

   ```env
   RAKAZO_MESSAGE_USER_MAX_CHARS=4000
   ```

   Leave `RAKAZO_COMPUTER_IMAGE` and `RAKAZO_COMPUTER_IMAGE_TAG` as they are. Add
   `BOT_MESSAGE_MAX_HOPS=<number>` only if the 6-hop chain limit should change.

4. Recreate the services. `--pull never` matters: `rakazo-fleet/app` exists only on this
   PC, so a pull would fail.

   ```bash
   cd D:/rakazo
   docker compose --env-file .env -f docker-compose.images.yml up -d --pull never
   docker ps --format "{{.Names}}  {{.Image}}  {{.Status}}"
   ```

   `api`, `worker`, `supervisor` and `web` should show `rakazo-fleet/app:<TAG>` and become
   healthy. Postgres and the bots' computer containers stay as they are.

While on the fork image:

- Do not run `docker compose pull` or `install-images.sh` without `--pull-never`; both
  try to download `rakazo-fleet/app` and fail.
- Ignore the update commands on Rakazo's Software update page; they pull upstream images.

## Roll back to upstream `:edge`

In `D:/rakazo/.env`, put the two image lines back:

```env
RAKAZO_IMAGE=ghcr.io/elie222/rakazo/app
RAKAZO_IMAGE_TAG=edge
```

and run:

```bash
cd D:/rakazo
docker compose --env-file .env -f docker-compose.images.yml up -d --pull never
```

The extra settings (`RAKAZO_MESSAGE_USER_MAX_CHARS`, `BOT_MESSAGE_MAX_HOPS`,
`RAKAZO_FLAG_BOT`, `RAKAZO_FLAG_LABEL`, `RAKAZO_RUN_MAX_MODEL_CALLS`,
`RAKAZO_RUN_MAX_MINUTES`, `RAKAZO_EXTRA_ORIGINS`, `RAKAZO_SECURE_COOKIES`) can stay;
upstream ignores them. Upstream reads `RAKAZO_ALLOWED_HOSTS` too, but its own compose file
does not pass it to the web, so the phone address stops working after a rollback. If the
tailnet address is the main one (https `BETTER_AUTH_URL`), first put `BETTER_AUTH_URL`,
`WEB_ORIGIN` and `API_URL` back to `http://127.0.0.1:5173`: upstream ignores
`RAKAZO_SECURE_COOKIES`, so with an https `BETTER_AUTH_URL` it renames the session cookie
and signs everyone out.

For an emergency rollback without editing `.env` first (values on the command line win
over `.env`; fix `.env` afterwards, or the next `up` switches back to the fork):

```bash
cd D:/rakazo
RAKAZO_IMAGE=ghcr.io/elie222/rakazo/app RAKAZO_IMAGE_TAG=edge \
  docker compose --env-file .env -f docker-compose.images.yml up -d --pull never
```

`--pull never` keeps the `:edge` image that is already on this PC, which is the
`7d5e64c` build the deployment ran before the switch. If `:edge` has been pulled since,
it is a newer upstream version. To go back to exactly `7d5e64c`, use
`RAKAZO_IMAGE_TAG=sha-7d5e64c886da7d556673f99e4923b013315007a9` and leave out
`--pull never`; that tag points at the same image.

Rolling back is only safe while the fork image and the rollback image share the same
database migrations. After moving `fleet` to a newer upstream base that adds
migrations, roll back by restoring the backup from step 2, not by switching images.

## Take upstream updates

Before an upgrade or an image switch, take the fleet inspect views out of the way. The
read-only "fleet inspect" service in `D:/fleet/rakazo/inspect` reads Rakazo's tables
through Postgres views (schema `fleet_inspect`), and Postgres refuses to drop or change a
column that a view uses, so a migration could stop with an error. In Git Bash:

```bash
cd D:/fleet/rakazo/inspect
sql/apply.sh sql/drop.sql     # before: remove the views
# ... upgrade Rakazo or switch the image ...
sql/apply.sh                  # after: create the views again
```

If `sql/apply.sh` then stops with a missing column, the views need a fix; see "Rakazo
upgrades" in `D:/fleet/rakazo/inspect/README.md`.

1. Update `main` and look at what changed:

   ```bash
   cd D:/rakazo-fork
   git fetch upstream
   git switch main && git merge --ff-only upstream/main && git push origin main
   git log --oneline fleet..upstream/main
   git diff --stat $(git merge-base fleet upstream/main) upstream/main -- packages/db/prisma/migrations
   ```

   If the last command lists files, the update changes the database (see the rollback
   note above).

2. Keep a marker for the current state, then move `fleet` onto the new upstream:

   ```bash
   git switch fleet
   git tag fleet-$(date +%Y%m%d)-before-update
   git rebase upstream/main
   ```

   Our commits are replayed one by one. If upstream already merged one of them, Git skips
   it. On a conflict, fix the files, `git add` them and `git rebase --continue`; or
   `git rebase --abort` to stop with nothing changed. To take only some upstream commits,
   rebase onto a chosen commit instead of `upstream/main`, or `git cherry-pick` single
   upstream commits onto `fleet`.

   Known conflict: upstream commit `5d1b795` (#1401, "keep mid-turn progress off short
   turns") rewrites the same `message_user` code as the message_user cap patch. Keep
   both changes. Patch 1 and patch 2 replay cleanly onto upstream `main` as of
   2026-10-17.

3. Rebuild and test (see above), then publish the branch:

   ```bash
   git push --force-with-lease origin fleet
   ```

4. Switch the deployment to the new tag (step 3 of "Switch", only the
   `RAKAZO_IMAGE_TAG` line changes). Back up the database first.

## Adding a patch

Each patch is one commit on `fleet` with its tests, written so it could go upstream on
its own. From a patch file made with `git format-patch`:

```bash
cd D:/rakazo-fork
git switch fleet
git am /path/to/the.patch
```

Then rebuild, test, push and switch as above.
