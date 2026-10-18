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
thoughts (the "Show thoughts" toggle starts off) and the attachments shown from
bot-to-bot runs.

**Running now (17 Oct 2026):** image `rakazo-fleet/app:b0c611d` (fleet at `b0c611d6`), with
`RAKAZO_MESSAGE_USER_MAX_CHARS=4000` in `D:/rakazo/.env`. Database backup taken just before
the switch: `D:/rakazo/backups/pre-fleet-20261017.dump`.

**Built and tested, not running (18 Oct 2026):** image `rakazo-fleet/app:e2ae2d7` (fleet
at `e2ae2d79`) = `db6ebaa` plus attachments from bot-to-bot runs. No new setting; it
uses the same `.env` lines as `419b22b` below.

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
`RAKAZO_RUN_MAX_MINUTES`) can stay; upstream ignores them.

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
