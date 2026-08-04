# discord — Discord chat, as Katari agents

A single module, `discord`, plus its FFI sidecar `src/discord.ts` (a
[discord.js](https://discord.js.org) client). The provider serves the bot token, and every call takes
that token plus a channel, so nothing a program holds can be invalidated by a restart. Independent of
any AI layer: an app reacts to messages with whatever agent it hands to `watch_messages`. Twin of the
`slack` package.

- `discord.provider(source = ...)` — serves `discord.credential` from a `credentials.source` for the
  extent of the continuation, resolved at every ask, so a rotated token lands on the next call rather
  than on the next restart. It connects to nothing: a call that needs the gateway opens one for its own
  lifetime.
- `discord.watch_messages(channel, deliver_to)` — serve a channel forever, delivering each incoming
  message to your agent as one `discord.message(id, channel, author, display_name, text, files)` value.
  Bot posts (this bot's own replies included) are not delivered, so replying cannot loop. Never
  resolves; composes under `parallel [ … ]`. The callback's own argument is named `value`. The watch
  supervises itself — a runtime restart's interruption reopens the gateway on a capped backoff, while
  `auth_error` still stops it loudly; `discord_watch` is the mortal single-connection form for a caller
  composing its own policy.
- `discord.list_messages(channel, after ?= "", limit ?= 50) -> array[message]` — the channel's history
  after a message id, in posted order, as the same `message` value the watch delivers, so one handler
  serves both paths.
- `discord.send_message(channel, text, files ?= []) -> string` — post to a channel, returning the
  posted message's id.
- `discord.try_send(channel, text, files ?= []) -> delivered | dropped(reason)` — resilient post: a
  blank text with no files posts nothing, a transient `api_error` drops just this post, and
  `auth_error` still re-raises.
- `discord.ask(channel, prompt, controls) -> answer` — post the prompt with its controls as one message
  and block until someone in the channel completes one of them. The channel's membership is the trust
  boundary; the first completed interaction is the answer.
- `discord.limits() -> caps` — Discord's own numbers as data, pure.
- `discord.check_controls(controls) -> valid | invalid(reason)` — whether a question is askable, as a
  pure value: counts, ids (duplicates included) and every string length. Run it where the controls are
  built.

## Failures

- `discord.auth_error(message)` — the token is invalid or expired (401), or the bot lacks permission in
  the channel (403). An operator resolves it.
- `discord.api_error(message)` — everything else: a rate limit (429), a channel that is not a sendable
  text channel, a payload past one of Discord's caps, a transient network fault. Usually per-message.
- `discord.discord_error` is the union of the two, raised as a `prelude.throw`, never a panic.

`use discord.provider(...)` connects to nothing, so it throws only the credential's own
`env.missing_secret` / `oauth.server_error`; a bad token fails the call that wanted the gateway.

## Delivery

Within one live gateway connection each message reaches `deliver_to` exactly once, in order. Across a
reconnect or a runtime restart the gateway has no per-event acknowledgement and Discord backfills
nothing onto a fresh session, so a message can be missed and, more rarely, repeated. No dedup memory is
kept here.

A restart interrupts the external call in flight — a watch, or an open `ask` — as a catchable panic.
Fork the watch again and it serves the channel again: the token resolves afresh, and the new call opens
its own socket. The messages that arrive while nothing is watching are the gap. A bot that reads that
gap back stores the `id` of each handled message beside whatever marks it handled and reads forward
from it with `list_messages`, oldest first; an empty page marks the gap closed, a short one does not,
since dropped bot posts shorten a page too.

An open `ask`'s posted controls go stale across a restart — nothing is left to strip them, so a late
click gets Discord's own "interaction failed" notice. Ask again.

## Identity

`author` (on a `message`) and `by` (on an `answer`) are the raw Discord snowflake. `display_name` beside
each is what Discord's own client shows for that person: their per-server nickname, else their global
display name, else their username. The chain is total, and the name rides in on the gateway event
itself, so it costs no extra API call and no privileged intent.

A display name is self-chosen and not unique: authorize on the id, and use the name to address someone.
A snowflake is an enumerable numeric id, so a plain digest of one is reversible — tag it with
`crypto.pseudonym` under a secret key before letting it leave the program.

## Asking a human

`ask` takes data — a list of `control` values — and returns data: which control was completed and with
what. Approval, free-form text, editing a draft and picking from a list are that one call with different
controls.

| control | renders as | answers with |
| --- | --- | --- |
| `button(id, label)` | a button; pressing it answers | `clicked(id, by, display_name)` |
| `select(id, label, options)` | a dropdown (`label` is its placeholder) | `chose(id, option, by, display_name)` |
| `form(id, label, title, fields)` | a button that opens a dialog of `field(id, label, value ?= "", multiline ?= false)` boxes; submitting answers | `submitted(id, values, by, display_name)` |

Opening a dialog and closing it again completes nothing, so the question stays open. Once answered the
controls come off the message and the outcome is left in their place; a question that ends without an
answer is stripped the same way and left reading `(expired)`. Stripping is best effort in both cases.
That record reads as the control's own label or picked option, so write those as the audit line you
would want to find later.

Every string a control carries has a Discord cap. Presentation is clamped to fit; anything Discord
routes back or a human approves fails instead, since a clamped id could collide and a docked
`field.value` would be approved as though it were whole.

| field | cap | over the cap, or blank |
| --- | --- | --- |
| the message's own text — `ask`'s `prompt`, `send_message` / `try_send`'s `text` | 2000 | fails the post; it is not a control, so `check_controls` cannot see it |
| `button.label`, `form.label` | 80 | clamped with a trailing `…`; blank renders as the control's `id` |
| `select.label` (the placeholder) | 150 | clamped; blank leaves Discord's own default line |
| `form.title` | 45 (24 keeps the same form renderable on the slack twin) | clamped; blank renders as `id` |
| `field.label` | 45 | clamped; blank renders as the field's `id` |
| `button.id`, `select.id`, `field.id` | 100 | fails the ask as `api_error` |
| `form.id` | 94 (its dialog's identifier carries a prefix) | fails the ask as `api_error`, where the question *posts* |
| `select.options[]` | 1–100 each, ≤25 options | fails the ask as `api_error` |
| `field.value` (the prefill) | 4000 | fails the ask as `api_error` |
| rows on one message | 5 — buttons pack 5 to a row, each dropdown takes one of its own | fails the ask as `api_error` |
| `form.fields` | 1–5 | fails the ask as `api_error`, where the dialog *opens* |

`discord.limits()` publishes every number above and `discord.check_controls(controls)` reads them, so a
gate's constructor can refuse itself before a run starts. It reports more than `ask` fails on: the
silent clamps too, and duplicate ids, which nothing else catches — the sidecar keeps the first, so
pressing the second control completes the first's answer. `ask` returns an `answer` and carries no room
for a verdict, so the check stays a call of its own.

The prompt is not a control, so `check_controls` does not see it. A prompt built out of text the program
did not write is bounded with `string.fit(value = ..., cap = discord.limits().message_text,
marker = ...)`.

Lengths are counted in Unicode code points here and in UTF-16 code units by the renderer, so an emoji
outside the BMP is one character to `check_controls` and two to Discord.

`ask` holds no time limit: a deadline is `time.with_deadline` around it, a withdrawal is
`region.cancel_by_id` on the fiber holding it.

## Divergences from the slack twin

The complete list lives in one place: the
[slack package's README](https://github.com/katari-lang/katari-package-slack#divergences-from-the-discord-twin).
`slack/scripts/check-twin.mjs` (`pnpm test` in the slack package) reads both modules and compares every
published name, data field, agent argument and callback argument name; a shape one twin grew without the
other fails the check until it is given to the other or declared as a divergence.

## Secrets / env

`DISCORD_TOKEN` — your bot token. Store it with `katari env set DISCORD_TOKEN --secret`. It is a
`string of private`, resolved at every call and passed straight to the sidecar.

To get one: create an application in the
[Discord Developer Portal](https://discord.com/developers/applications), add a **Bot**, and copy its
token. The sidecar requests the `Guilds`, `GuildMessages` and `MessageContent` gateway intents, so
enable the **MESSAGE CONTENT intent** on the Bot page (the other two are unprivileged). Then invite the
bot to your server with permission to read and send messages in the channel you watch.

## Sidecar

`src/discord.ts` imports `discord.js` and `@katari-lang/port`; run `pnpm install` in this package so
`katari apply` can bundle it. `pnpm run typecheck` type-checks the sidecar, and `pnpm test` runs
`scripts/check-limits.mjs`, which fails when `discord.limits()` and the sidecar's `LIMIT` disagree
(nothing in Katari can read a constant out of the TypeScript, so the numbers are written down twice).

## Usage

```katari
import discord

agent echo(value: discord.message) -> null {
  let _outcome = discord.try_send(channel = value.channel, text = f"echo: ${value.text}", files = value.files)
  null
}

agent echo_bot(channel: string) -> never {
  use discord.provider(source = credentials.env(key = "DISCORD_TOKEN"))
  discord.watch_messages(channel = channel, deliver_to = echo)
}
```

That bot escalates `prelude.throw[discord.discord_error | env.missing_secret | oauth.server_error]` to
its run root: nothing connects at the provider, so a bad token stops the watch rather than the `use`. A
resident bot forks the watch into a region instead; the watch supervises itself, so what reaches the
region's events is only what no reconnect heals.
