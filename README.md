# discord — the Discord gateway, as Katari agents

A single module, `discord`, plus its FFI sidecar `src/discord.ts`: a
[discord.js](https://discord.js.org) gateway client behind a provider — the Discord twin of the Slack
package. The connection is **owned by the provider** — log in once, and every call in its scope shares
the same live gateway client. Independent of any AI layer: an app reacts to messages with whatever
agent it hands to `watch_messages` as `deliver_to`.

The surface is two planes: **messages** in and out, and **one interaction primitive**, `ask`.

- `discord.provider(source = ...)` — resolves the bot token ONCE (a `credentials.source`) and serves
  the connection for the extent of the continuation.
- `discord.watch_messages(channel, deliver_to)` — serve a channel forever, delivering each incoming
  message to your agent as one `discord.message(channel, author, text, files)` value. Bot posts (this
  bot's own replies included) are not delivered, so replying cannot loop. Never resolves; composes
  under `parallel [ … ]`.
- `discord.send_message(channel, text, files ?= [])` — post to a channel, returning the posted
  message's id; pass `[]` (or omit) for a plain text post.
- `discord.try_send(channel, text, files ?= [])` — the resilient wrapper every bot writes: a blank
  text with no files posts nothing, a transient `api_error` drops just this post, and `auth_error`
  still re-raises.
- `discord.ask(channel, prompt, controls) -> answer` — post the prompt with its controls as one
  message and BLOCK until someone in the channel completes one of them. The channel's membership is
  the trust boundary; the first completed interaction is the answer.

Files are first-class in both directions: an incoming message's attachments arrive as `file` values
(the sidecar downloads each from Discord's CDN and uploads it over the blob side channel), and
`send_message` posts `file` values back as Discord attachments.

The low-level externals (`create_discord_client`, `discord_send`, `discord_ask`, `discord_watch`) are
implemented in the sidecar, which keeps the live clients in a module-level map keyed by opaque handle.

**Delivery**: within one live gateway connection each message reaches `deliver_to` exactly once, in
order. Across a **reconnect** nothing is guaranteed in either direction — the gateway has no per-event
acknowledgement, so a message can be missed (an invalidated session, an outage past the resume window,
or the run itself restarting all re-identify, and Discord backfills nothing onto a fresh session) and,
far more rarely, repeated (a resume replays from the last sequence the shard recorded, which advances
when an event *arrives*, not after `deliver_to` returns). No dedup memory is kept here. A bot that must
miss nothing reconciles against the channel's own history.

## Asking a human: controls in, an answer out

`ask` takes **data** — a list of `control` values — and returns **data**: which control was completed
and with what. Approval, free-form text, editing a draft and picking from a list are that one call
with different controls, not four agents.

| control | renders as | answers with |
| --- | --- | --- |
| `button(id, label)` | a button; pressing it answers | `clicked(id, by)` |
| `select(id, label, options)` | a dropdown (`label` is its placeholder) | `chose(id, option, by)` |
| `form(id, label, title, fields)` | a button that opens a dialog of `field(id, label, value ?= "", multiline ?= false)` boxes; submitting answers | `submitted(id, values, by)` |

A form is two Discord steps because that is Discord's physics — text input exists only in a dialog, and
a dialog opens only in reply to a click. Opening a dialog and closing it again completes nothing, so
the question stays open. Once answered, the controls come off the message and the outcome is left in
their place — and a question that ends *without* an answer (a `time.with_deadline` expiry, a cancel, a
teardown) is stripped the same way and left reading `(expired)`, so no dead ask leaves live controls
behind. Stripping is best effort in both cases.

Keep a `form`'s `title` to **24 characters**: that is the twin contract's bound rather than Discord's
own (which allows 45), so a form written here renders unchanged on the Slack twin, whose dialog title
caps at 24. Discord's other caps are its own — a button label ≤80, a dropdown of ≤25 options of ≤100
characters, 1–5 fields per dialog, a field value ≤4000 — and exceeding one is a payload the platform
rejects, surfacing as `api_error`.

`ask` holds **no time limit**: a deadline is `time.with_deadline` around it, a withdrawal is
`region.cancel_by_id` on the fiber holding it. `by` is the answerer's raw Discord snowflake — an
enumerable id, so tag it with `crypto.hmac_sha256` before it leaves the program.

```katari
// Approval: two buttons, and the program branches on the id it wrote.
match (discord.ask(
  channel = channel,
  prompt = f"Approve: ${what}?",
  controls = [discord.button(id = "approve", label = "approve"), discord.button(id = "deny", label = "deny")],
)) {
  case discord.clicked(id => "approve", by => _) -> do_it()
  case rest -> skip()
}

// Editing a draft: a PREFILLED form beside a deny button. A submit is approval AT THOSE VALUES.
match (discord.ask(
  channel = channel,
  prompt = "Send this mail? Edit and submit to send, or deny.",
  controls = [
    discord.form(id = "send", label = "edit & send", title = "mail draft", fields = [
      discord.field(id = "subject", label = "subject", value = subject),
      discord.field(id = "body", label = "body", value = body, multiline = true),
    ]),
    discord.button(id = "deny", label = "deny"),
  ],
)) {
  case discord.submitted(id => _, values => values, by => _) -> send(values = values)
  case rest -> refuse()
}
```

A form of one *empty* field is the free-text shape; a `select` over a computed list is the pick shape.

Once a question is answered the controls come off and the outcome stays: `→ <the control's label, or
the picked option> (by @who)`. So a `button`'s `label` and a `select`'s `option` strings are not only
what a human clicks — they become the channel's lasting, public account of what was decided. Write
them as the audit line you would want to find later. That line names the answerer as a Discord
mention; the `by` the `answer` carries is the raw id.

## Divergences from the slack twin

The two packages carry the same data types with the same fields. Everything that differs is here:

- **`message.thread`** — Slack's only extra field, absent here. Slack addresses a thread by its
  parent's `ts`, which doubles as the message's identity; Discord has no such value, so its `message`
  is the first four fields of Slack's.
- **`form.title` is capped at 24 characters** — the tighter of the two platforms' caps (Discord's own
  is 45), so a title that fits the twin fits here. Every other cap is each platform's own: Discord
  takes an ≤80-character button label and ≤25 options of ≤100 characters where Slack takes 75.
- **`discord_error` classification** — the same two constructors as Slack's `slack_error`, but
  classified from HTTP status (401/403 → `auth_error`) rather than from Slack's error strings.
- **Delivery guarantee** — Slack's socket acknowledges each event and re-sends an acknowledgement it
  lost, so that side is **at-least-once**. Discord's gateway acknowledges nothing per event, so this
  side guarantees **neither** across a reconnect: a message may be missed, and far more rarely
  repeated (see *Delivery*, above). A program that needs one uniform guarantee across both must
  supply it itself.

Form validation is *not* on that list, deliberately: both sides make every input optional and both
return `values` total over the declared fields, with a blank box as `""`. Neither invents a check the
`field` type has no knob for.

## Secrets / env

- `DISCORD_TOKEN` — your bot token. Store it in the runtime:
  `katari env set DISCORD_TOKEN --secret`. It is a `string of private`, passed straight to the
  sidecar's login and never surfaced elsewhere.

To get a token: create an application in the
[Discord Developer Portal](https://discord.com/developers/applications), add a **Bot**, and copy its
token. The sidecar requests the `Guilds`, `GuildMessages` and `MessageContent` gateway intents, so
enable the **MESSAGE CONTENT intent** on the Bot page (the other two are unprivileged). Then invite
the bot to your server with permission to read and send messages in the channel you watch.

## Sidecar dependencies

`src/discord.ts` imports `discord.js` and `@katari-lang/port`. They are declared in `package.json`;
run `pnpm install` (or `npm install`) in this package so `katari apply` can bundle the sidecar. (A
pure-Katari consumer that never applies this package does not need them.)

## Usage

```katari
import discord

// Echo every message back to the channel it came from, attachments included.
agent echo(message: discord.message) -> null {
  discord.try_send(channel = message.channel, text = f"echo: ${message.text}", files = message.files)
}

agent echo_bot(channel: string) -> never {
  use discord.provider(source = credentials.env(key = "DISCORD_TOKEN"))
  discord.watch_messages(channel = channel, deliver_to = echo)
}
```

To hand file posting to an AI loop as a tool, bind `discord.send_message` under a role-specific
description with a doc-on-`let` — the package no longer ships a separate `send_files` wrapper, because
a wrapper that differed only in argument order and doc text was one agent too many.
