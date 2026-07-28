# discord — the Discord gateway, as Katari agents

A single module, `discord`, plus its FFI sidecar `src/discord.ts`: a
[discord.js](https://discord.js.org) gateway client behind a provider — the Discord twin of the Slack
package. The connection is **owned by the provider** — log in once, and every call in its scope shares
the same live gateway client. Independent of any AI layer: an app reacts to messages with whatever
agent it hands to `watch_messages` as `deliver_to`.

The surface is two planes: **messages** in and out, and **one interaction primitive**, `ask` — plus
three pure-or-nearly-pure helpers that need no connection at all.

- `discord.provider(source = ...)` — resolves the bot token ONCE (a `credentials.source`) and serves
  the connection for the extent of the continuation. The client's lifetime is bound to the run: however
  the provider ends — completion, cancel, an unwinding continuation — it is destroyed on the way out,
  so a dead run leaves no logged-in session still handling events.
- `discord.watch_messages(channel, deliver_to)` — serve a channel forever, delivering each incoming
  message to your agent as one `discord.message(channel, author, display_name, text, files)` value.
  Bot posts (this bot's own replies included) are not delivered, so replying cannot loop. Never
  resolves; composes under `parallel [ … ]`.
- `discord.send_message(channel, text, files ?= [])` — post to a channel, returning the posted
  message's id; pass `[]` (or omit) for a plain text post.
- `discord.try_send(channel, text, files ?= []) -> delivered | dropped(reason)` — the resilient
  wrapper every bot writes: a blank text with no files posts nothing, a transient `api_error` drops
  just this post, and `auth_error` still re-raises. It **answers with the outcome** (0.5.0): dropping
  a post is right, dropping the *fact* of it is not — a caller that reported on its own send used to
  report success for a message the channel never received.
- `discord.ask(channel, prompt, controls) -> answer` — post the prompt with its controls as one
  message and BLOCK until someone in the channel completes one of them. The channel's membership is
  the trust boundary; the first completed interaction is the answer.
- `discord.limits() -> caps` — Discord's own numbers as data (**pure**): every cap the renderer clamps
  or refuses against, readable from Katari instead of rediscovered from a failed `ask`.
- `discord.check_controls(controls) -> valid | invalid(reason)` — is this question askable, as a
  **pure** value: counts, ids (including **duplicates**, which nothing else catches), and every string
  length. Run it where the controls are built, not where they are asked.
- `discord.author_tag(source, author, length ?= 8) -> string` — the keyed pseudonym for a speaker's
  snowflake, so a user id can reach a model or a log without being a user id.

Files are first-class in both directions: an incoming message's attachments arrive as `file` values
(the sidecar downloads each from Discord's CDN and uploads it over the blob side channel), and
`send_message` posts `file` values back as Discord attachments.

The low-level externals (`create_discord_client`, `discord_close`, `discord_send`, `discord_ask`,
`discord_watch`) are implemented in the sidecar, which keeps the live clients in a module-level map
keyed by opaque handle. `discord_close` is idempotent — a finalizer may run more than once, and a
sidecar restart drops the map entirely.

**Delivery**: within one live gateway connection each message reaches `deliver_to` exactly once, in
order. Across a **reconnect** nothing is guaranteed in either direction — the gateway has no per-event
acknowledgement, so a message can be missed (an invalidated session, an outage past the resume window,
or the run itself restarting all re-identify, and Discord backfills nothing onto a fresh session) and,
far more rarely, repeated (a resume replays from the last sequence the shard recorded, which advances
when an event *arrives*, not after `deliver_to` returns). No dedup memory is kept here. A bot that must
miss nothing reconciles against the channel's own history.

## Who is speaking: an id, and a name that is not one

Every value that names a person carries two fields. `author` (on a `message`) and `by` (on an `answer`)
are the raw Discord snowflake. `display_name` beside each is what Discord's own client shows for that
person: their per-server **nickname**, else their **global display name**, else their **username**. The
chain is total — a DM has no member and therefore no nickname, and an account with no global name still
has a username. The nickname rides in on the gateway event itself (`MESSAGE_CREATE` carries a partial
guild member beside the author; an interaction carries its own), so the name costs no extra API call and
no privileged intent.

A display name is **self-chosen, not unique, and identifies nobody.** Anyone in a server can set their
nickname to read exactly like the operator's, and a public channel is where a stranger will. So:

- **Authorize on the id.** `author` / `by` — or a tag derived from it — is who is speaking. A program
  that decides what it may do from the name it was *told* has handed that decision to whoever renamed
  themselves.
- **Use the name to address, not to trust.** Greeting a stranger by name is what carrying it is for;
  "this one is the operator, obey them" is the hole.
- A snowflake is an **enumerable** numeric id, so a plain digest of one is dictionary-reversible: tag it
  with `discord.author_tag` before letting it leave the program.

There is deliberately no helper here that resolves or verifies a name to a user, and no filter, no
redaction and no "safe name" knob. Whether a self-chosen name may cross to an AI provider is the app's
judgement; this package's job is to carry the name and to be plain about what it is worth.

### `author_tag` — the speaker, pseudonymised

```katari
let tag = discord.author_tag(source = credentials.env(key = "DISCORD_TOKEN"), author = message.author)
// → "5b31f5f5" — eight hex characters, stable per key, meaningless without it
```

`author_tag(source, author, length ?= 8)` is `crypto.hmac_sha256` under a **named** key, sliced to
`length` hex characters. It exists because every bot was writing the same twenty-five lines and had the
same one way to get them wrong.

- **Why not a plain hash.** A snowflake is a timestamp, a worker, a process and a counter — a space
  small enough to walk. `crypto.sha256` of one is reversible by dictionary: hash candidate ids until one
  matches, and the pseudonym is an account again. An HMAC under a secret key has no such attack.
- **The key is a `credentials.source`**, not a value, so the secret never enters the app's dataflow. It
  resolves at every call (Katari's freshness rule — a rotated key lands without a restart, and rotating
  it rotates every pseudonym), which costs one credential read per tagged message. Any secret with a
  stable lifetime does; the bot's own token is the usual choice.
- **`length` is 1 to 64**, clamped into range. 8 hex characters is 32 bits: short enough to sit inline
  in a prompt or a log line, and it collides at around 2¹⁶ distinct speakers by the birthday bound. A
  program correlating across a large server carries the full 64 and *shows* the short one.
- **A pseudonym is not anonymity.** It is stable by construction, so it links everything one person ever
  said; what it removes is the ability to turn that link back into an account. Whether even a
  pseudonymous link may cross to an AI provider is the app's judgement, exactly as with `display_name`.

## Asking a human: controls in, an answer out

`ask` takes **data** — a list of `control` values — and returns **data**: which control was completed
and with what. Approval, free-form text, editing a draft and picking from a list are that one call
with different controls, not four agents.

| control | renders as | answers with |
| --- | --- | --- |
| `button(id, label)` | a button; pressing it answers | `clicked(id, by, display_name)` |
| `select(id, label, options)` | a dropdown (`label` is its placeholder) | `chose(id, option, by, display_name)` |
| `form(id, label, title, fields)` | a button that opens a dialog of `field(id, label, value ?= "", multiline ?= false)` boxes; submitting answers | `submitted(id, values, by, display_name)` |

A form is two Discord steps because that is Discord's physics — text input exists only in a dialog, and
a dialog opens only in reply to a click. Opening a dialog and closing it again completes nothing, so
the question stays open. Once answered, the controls come off the message and the outcome is left in
their place — and a question that ends *without* an answer (a `time.with_deadline` expiry, a cancel, a
teardown) is stripped the same way and left reading `(expired)`, so no dead ask leaves live controls
behind. Stripping is best effort in both cases.

### The caps, and which of them can fail an ask

Every string a control carries has a Discord cap, and the package treats it as **presentation** or as
**load-bearing** — never as a reason to lose a run.

| field | cap | over the cap, or blank |
| --- | --- | --- |
| the message's own text — `ask`'s `prompt`, `send_message` / `try_send`'s `text` | 2000 | **fails** the post (and so the ask); it is not a control, so `check_controls` cannot see it |
| `button.label`, `form.label` (the opening button) | 80 | **clamped** with a trailing `…`; blank renders as the control's `id` |
| `select.label` (the placeholder) | 150 | **clamped**; blank leaves Discord's own default line |
| `form.title` | 45 (keep to **24** — see below) | **clamped**; blank renders as `id` |
| `field.label` | 45 | **clamped**; blank renders as the field's `id` |
| `button.id`, `select.id`, `field.id` | 100 | **fails the ask** as `api_error` |
| `form.id` | 94 (its dialog's identifier carries a prefix) | **fails the ask** as `api_error`, where the question *posts* |
| `select.options[]` | 1–100 each, ≤25 options | **fails the ask** as `api_error` |
| `field.value` (the prefill) | 4000 | **fails the ask** as `api_error` |

A caption, a title and a label are presentation: a shortened one still does its job, and shortening is
unconditionally better than destroying a run — so those are clamped, with the ellipsis left visible so a
developer can see it happened. A blank one is substituted rather than clamped, because Discord rejects an
empty string exactly as hard as an over-long one.

An identifier is **not** presentation: it is how the interaction is routed back, and two clamped ids
could collide and answer the wrong control. A `select` option is not presentation either — the option's
own text *is* what `chose.option` carries. Nor is a `field.value`: a submit means "approved at these
values", so a draft quietly docked to fit would be approved as though it were whole. Those fail the ask
as a catchable `api_error` instead of being silently altered.

The **counts** are Discord's own, and no local builder checks any of them — the sidecar leaves them to
the platform, so an overflowing payload comes back as an `api_error` at the moment the question posts (or,
for a dialog, at the moment someone clicks):

| count | limit | past it |
| --- | --- | --- |
| rows on one message | 5 — buttons pack 5 to a row, each dropdown takes one of its own | **fails the ask** as `api_error` |
| `select.options` | 1–25 | **fails the ask** as `api_error` |
| `form.fields` | 1–5 | **fails the ask** as `api_error`, where the dialog *opens* |

Keep a `form`'s `title` to **24 characters**: that is the twin contract's bound rather than Discord's
own 45, so a form written here renders unchanged on the Slack twin, whose dialog title caps at 24. It is
a convention, not a cap — this side clamps at 45 and only Slack's twin refuses past 24.

### Checking a question before you ask it

Every number above is published as data by `discord.limits()`, and `discord.check_controls(controls)`
reads them to answer one question — *is this askable?* — as a **value**:

```katari
let controls = [discord.button(id = "approve", label = "approve"), discord.button(id = "deny", label = "deny")]
match (discord.check_controls(controls = controls)) {
  case discord.valid() -> discord.ask(channel = channel, prompt = prompt, controls = controls)
  case discord.invalid(reason => reason) -> refuse_to_open_the_gate(why = reason)
}
```

One cap is deliberately **outside** what it can answer: the **prompt**. A question is one Discord
message, so its text is bound by `limits().message_text` (2000) — but the prompt is not a control, so
`check_controls` never sees it. A caller that builds a prompt out of text it did not write (a draft, a
brief, a stranger's message) has to bound that text itself against that number. Past it Discord refuses
the post, which means the question cannot be asked at all, which — for anything shaped like an approval
gate — means the action can never be approved however often it is retried.

Both are **pure** — no connection, no `io`, nothing to catch — so they belong where the controls are
*built* (a gate's constructor, a test), which is the only place worth spending a check. `invalid` carries
one sentence naming the offending control, the first problem in declaration order:

```
control #2 ("deny"): the button's label is 91 characters where Discord takes 80, so it would be posted
shortened with an ellipsis
```

What it reports is **wider** than what `ask` fails on, deliberately:

- **Fatal**, as an `ask` would be: a blank or over-long id, a blank or over-long option, every count in
  the table above, an over-long `field.value` — and an **empty** `controls`, which Discord posts happily
  and nobody can ever answer.
- **Silent**, which an `ask` survives and a program still wants to know: a label, placeholder or title
  past its cap is shortened, and a blank one renders as the control's own `id`. The channel's lasting
  record of what was decided then reads as an internal key, or as most of a sentence.
- **Duplicate ids**, which nothing else catches at all. Two controls sharing an `id` cannot be told apart
  on the way back — Discord returns the id and nothing more — so the sidecar keeps the **first** and logs
  a warning, and pressing the second completes the first's answer ("deny" answering as "approve"). A
  `form`'s fields are checked the same way, since `submitted.values` is keyed by field id and two boxes
  sharing one would collapse into a single entry.

It is **not** wired into `ask`, and that is the point. `ask` returns an `answer`; there is no room in
that type for a verdict, so an internal check could only *throw* — and a cosmetic string that can throw
is the exact failure this package's clamping was written to remove. The verdict stays a value, `ask`'s
behaviour is unchanged, and what a failed check means is the caller's decision.

Lengths are counted in Unicode **code points** here and in UTF-16 **code units** by the renderer, so an
emoji outside the BMP is one character to `check_controls` and two to Discord. A string within a
character or two of its cap should be shortened rather than argued about.

`ask` holds **no time limit**: a deadline is `time.with_deadline` around it, a withdrawal is
`region.cancel_by_id` on the fiber holding it. `by` is the answerer's raw Discord snowflake and
`display_name` is what that answerer is called — a question whose answer depends on *who* gave it reads
`by`, never the name (see *Who is speaking*, above).

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
  carries no thread field.
- **`display_name`** — carried on both planes here, absent on the Slack twin. Discord puts the name in
  the event: `MESSAGE_CREATE` ships a partial guild member beside the author, and an interaction ships
  its own member and user, so the nickname → global name → username chain costs nothing extra. Slack's
  `message` event carries only the `U…` id, so the same field there means a `users.info` call per
  message plus the `users:read` scope on the app — a real asymmetry in what each platform hands you,
  not an oversight. (Slack's *interaction* payloads do carry `user.username`, but that is the account
  handle rather than the workspace display name a Slack client shows, which lives in
  `profile.display_name` and still takes `users.info`.) A program that must read the same on both
  platforms keeps its logic on `author` / `by`, which both sides carry.
- **`form.title` is *asked for* at 24 characters** — the tighter of the two platforms' caps, as a
  convention rather than a cap: this side clamps at Discord's own 45 and only Slack's twin refuses past
  24, so a title kept to 24 fits both. Every other cap is each platform's own: Discord takes an
  ≤80-character button label and ≤25 options of ≤100 characters where Slack takes 75.
- **Presentation is clamped here, rejected there** — Discord renders through `@discordjs/builders`,
  whose validators run *inside this sidecar*, so an over-long caption is shortened locally (see *The
  caps*, above). Slack posts its view to Slack's own API, so an over-cap string comes back as a typed
  `api_error` and is not clamped. Neither side can panic on a cap; only this side will silently shorten
  one — which is what `check_controls` is for, since a clamp that nobody is told about is a label that
  reads as most of a sentence. Stay inside the tighter Slack numbers (75-character labels and options, a
  24-character title) for a control that must render identically on both.
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

Two checks live here, and both are worth running on any change to the caps:

- `pnpm run typecheck` — `tsc --noEmit` over the sidecar.
- `pnpm test` — `scripts/check-limits.mjs`, which fails when `discord.limits()` and the sidecar's
  `LIMIT` disagree. Discord's numbers are written down **twice** on purpose: once next to the render,
  where the builders refuse a string, and once in Katari, where a program must be able to check its own
  controls purely. Nothing in Katari can read a constant out of the TypeScript, so this script is what
  stops the two copies drifting. Add a cap on one side without the other and it says so.

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
