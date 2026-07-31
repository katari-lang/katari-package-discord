# discord — Discord chat, as Katari agents

A single module, `discord`, plus its FFI sidecar `src/discord.ts`: a
[discord.js](https://discord.js.org) client behind a provider — the Discord twin of the Slack
package. The provider serves the **bot token**, and **every call takes it**: a token plus a channel is
all anything here needs, so nothing a program holds can be invalidated by a restart. Independent of any
AI layer: an app reacts to messages with whatever agent it hands to `watch_messages` as `deliver_to`.

The surface is two planes: **messages** in and out, and **one interaction primitive**, `ask` — plus
three pure helpers that need no credential at all.

- `discord.provider(source = ...)` — serves `discord.credential` from a `credentials.source` for the
  extent of the continuation, resolved at **every** ask (a rotated token lands on the next call, not on
  the next restart). It connects to nothing and closes nothing: a call that needs the gateway opens one
  for its own lifetime.
- `discord.watch_messages(channel, deliver_to)` — serve a channel forever, delivering each incoming
  message to your agent as one `discord.message(id, channel, author, display_name, text, files)` value.
  Bot posts (this bot's own replies included) are not delivered, so replying cannot loop. Never
  resolves; composes under `parallel [ … ]`. The callback's own argument is named `value` (0.6.0).
- `discord.list_messages(channel, after ?= "", limit ?= 50) -> array[message]` — the channel's own
  history after a message id, **in posted order** (0.8.0). The gateway misses messages across a
  reconnect and backfills nothing, so this is the other half of "miss nothing": keep the `id` of the
  last message you handled somewhere durable and read forward from it. Same `message` value the watch
  delivers — attachments downloaded, bot posts dropped — so one handler serves both paths.
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
- `discord.fit_message(text, marker) -> string` — shorten text to fit one message, ending it with your
  own marker when anything was cut. **Pure**; the room is the cap *minus* the marker, which is the half
  of the job that is arithmetic rather than editorial.
- `discord.author_tag(source, author, length ?= 8) -> string` — the keyed pseudonym for a speaker's
  snowflake, so a user id can reach a model or a log without being a user id.

## New in 0.8.0 — a delivered message has an id, and the gap has a reader

`watch_messages` has always documented that a bot which must miss nothing "reconciles against the
channel's own history". The package did not offer a way to do it, and a delivered message carried no
id to reconcile *from*. Both are fixed:

- **`discord.message` grew an `id`** — the message's own snowflake, the same kind of value
  `send_message` returns. Additive: nothing in Katari constructs a `message`, and a `deliver_to` reads
  the fields it names, so existing callbacks compile unchanged.
- **`discord.list_messages(channel, after, limit)`** reads forward from that id, oldest first, one
  REST call with no gateway involved. Discord caps a page at 100, so a wide gap takes several calls;
  a SHORT answer is not proof the gap is closed (dropped bot posts shorten it too) — an EMPTY one is.
- Nothing dedups. A message already handled through the stream comes back if your cursor predates it,
  which is why the cursor belongs beside whatever marks a message handled.

The shape and the attachment download are now written once in the sidecar and used by both paths, so a
reconciled message cannot quietly differ from a watched one.

## Breaking changes in 0.7.0

**The `connection` request is gone, and with it the whole idea of a connection a program holds.** What
the provider serves is the bot token; what every call takes is that token and a channel.

- **`discord.connection` → `discord.credential`** in every effect row. `with discord.connection | io`
  becomes `with discord.credential | io`; nothing else about the call sites changes, because the
  request is served by the same one-line `use discord.provider(source = ...)`.
- **`create_discord_client` and `discord_close` are removed**, and the low-level externals take
  `token: string of private` where they took `client: string` (`discord_send`, `discord_watch`,
  `discord_ask`).
- **`provider` no longer connects, and no longer throws `discord_error`.** Its row is now just the
  credential's own (`env.missing_secret | oauth.server_error`). A bad token used to fail at
  `use discord.provider(...)`; it now fails at the call that wanted the gateway.
- **`watch_messages` now raises `discord_error`** (`prelude.throw[discord_error]` joined its row),
  because opening the socket is its job. A bot that let a bad token stop it loudly at the provider gets
  the same ending from the watch instead — with `auth_error` reaching the fork's `region.failed` as a
  typed value rather than arriving as a panic.
- **The token resolves at every call** rather than once at connect, so a rotation lands without a
  restart. That was impossible while one login owned the scope.
- Also fixed, on the way: `create_discord_client` logged in and `discord_watch` attached its listener
  some later call afterwards, so **every message that arrived in that window was lost**. A watch now
  registers before its socket comes up.

**Why.** A durable program may hold only durable values, and the 0.6.0 client handle was a pointer into
the sidecar's process memory: the sidecar kept `const clients = new Map()` keyed by that handle, so a
runtime restart replayed the *same* handle into a *new* process whose map was empty, and every call
through it panicked. Re-forking the watcher handed the replacement the same dead handle, which made the
documented recovery a silent crash loop. The fix is not to detect the staleness — it is that a token and
a channel name the remote thing from *any* process, so there is nothing left to go stale. (The `e2b`
package was already built this way and never had the bug.)

Files are first-class in both directions: an incoming message's attachments arrive as `file` values
(the sidecar downloads each from Discord's CDN and uploads it over the blob side channel), and
`send_message` posts `file` values back as Discord attachments.

The low-level externals (`discord_send`, `discord_ask`, `discord_watch`) are implemented in the
sidecar. `discord_send` is a plain REST call with no state at all. `discord_watch` / `discord_ask` need
a live socket to *receive*, so the sidecar keeps one gateway per token, refcounted: the first of them
opens it, the last one out closes it. Nothing in Katari names that cache, which is why sharing it is
invisible — a restart simply starts with none, and the calls that were using it were already dead.

**Delivery**: within one live gateway connection each message reaches `deliver_to` exactly once, in
order. Across a **reconnect** nothing is guaranteed in either direction — the gateway has no per-event
acknowledgement, so a message can be missed (an invalidated session, an outage past the resume window,
or the run itself restarting all re-identify, and Discord backfills nothing onto a fresh session) and,
far more rarely, repeated (a resume replays from the last sequence the shard recorded, which advances
when an event *arrives*, not after `deliver_to` returns). No dedup memory is kept here. A bot that must
miss nothing reconciles against the channel's own history.

### Earlier releases

- **0.6.0** — `watch_messages`'s `deliver_to` is called with `value`, not `message`: argument names are
  structural in Katari, so a callback declared `(message: discord.message)` does not type-check here.
  `gmail.watch` and `poll.subscribe` name theirs `value` after the prelude's primary-argument
  convention, and the two chat twins were the only holdouts. New in the same release: `fit_message`.
- **0.5.0** — `try_send` answers with its outcome (`delivered | dropped(reason)`).

## What a runtime restart costs — and what a re-fork gets back

**Re-fork the watcher and it serves the channel again.** That is the whole of 0.7.0's story, and in
0.6.0 it was not true.

A restart interrupts the external call that was in flight — the watch, or an open `ask` — under the
at-most-once rule, which is unavoidable and arrives as a catchable panic. What is *not* lost is anything
that names something remote: the token resolves afresh, the channel id is a channel id, and the new
call opens its own socket. So the recovery is the plain one — a resident bot, whole:

```katari
import discord

// The region's scope marker, and the ceiling its one fiber may raise. A fiber's THROWS sit outside the
// ceiling by the region's contract: they arrive at the watch as `region.failed` instead.
effect resident_scope
type resident_ceiling = discord.credential | io

data watcher_died(name: string, detail: string)

agent reply(value: discord.message) -> null {
  let _outcome = discord.try_send(channel = value.channel, text = f"echo: ${value.text}")
  null
}

agent watch_channel(input: string) -> null with discord.credential | io | prelude.throw[discord.discord_error] {
  discord.watch_messages(channel = input, deliver_to = reply)
}

agent resident(channel: string) -> never with io | prelude.throw[env.missing_secret | oauth.server_error | watcher_died] {
  use discord.provider(source = credentials.env(key = "DISCORD_TOKEN"))
  let nursery: region.nursery[resident_scope, resident_ceiling] = use region.provide[resident_scope, resident_ceiling]
  use handler {
    request region.crashed(id: string, name: string, message: string) {
      // The interrupted call died with the restart; fork another watch and it connects again.
      let _again = region.fork(nursery = nursery, task = watch_channel, argument = channel, name = "channel-watch")
      next
    }
    // A throw that escaped the fiber is a fault no re-fork heals (a revoked token): stop loudly.
    request region.failed(id: string, name: string, error: unknown) {
      prelude.throw(error = watcher_died(name = name, detail = json.stringify(value = error)))
    }
  }
  let _watcher = region.fork(nursery = nursery, task = watch_channel, argument = channel, name = "channel-watch")
  region.watch(nursery = nursery)
}
```

No supervisor ceremony, no re-establishing a session, no epoch to compare. What each ending means:

| ending | what it is | what to do |
| --- | --- | --- |
| `region.crashed` | the call was interrupted (a restart, a teardown) — a panic carrying a message | fork the watch again |
| `region.failed` with `auth_error` | the token is invalid or lacks a permission | stop loudly; an operator must fix it |
| `region.failed` with `api_error` | Discord refused a call (a rate limit, an unsendable channel) | usually per-message; `try_send` already folds it |

What a restart *does* cost: the messages that arrive while nothing is watching (the same gap a reconnect
has, above), and an open `ask`'s posted controls, which nothing is left to strip — a late click gets
Discord's own "interaction failed" notice, and the recovery is to ask again, since whoever wanted the
answer wants it still.

That first cost is the one a bot can choose to pay or not. The gap is real either way, but it is only
*lost* if nothing recorded where the stream had got to. Store the `id` of each handled message beside
whatever marks it handled, and a forked-again watch can read the gap back with `list_messages` before
(or while) it listens:

```katari
@"One page of the gap, handled oldest first; answers the cursor to read from next. Call it again while
it keeps moving — an EMPTY page is the end, and a SHORT page is not, because dropped bot posts shorten
one too."
agent catch_up_once(channel: string, since: string) -> string with discord.credential | io | prelude.throw[discord.discord_error] {
  let page = discord.list_messages(channel = channel, after = since)
  for (let message in page) {
    next handle(message = message)
  }
  match (array.get(target = page, index = array.length(target = page) - 1)) {
    case null -> since
    case last -> last.id
  }
}
```

Whether that is worth it is the app's call, and the honest default is no: a community bot that misses a
question during a redeploy is fine, and the asker repeats themselves. A bot whose channel is a WORK
QUEUE is not fine, and for that one the cursor is the whole difference between at-most-once and
at-least-once delivery.

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
import discord

agent tag_of(message: discord.message) -> string with io | prelude.throw[env.missing_secret | oauth.server_error] {
  let tag = discord.author_tag(source = credentials.env(key = "DISCORD_TOKEN"), author = message.author)
  // → "5b31f5f5" — eight hex characters, stable per key, meaningless without it
  tag
}
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
import discord

data gate_unaskable(reason: string)
agent refuse_to_open_the_gate(why: string) -> never with prelude.throw[gate_unaskable] { prelude.throw(error = gate_unaskable(reason = why)) }

agent open_the_gate(channel: string, prompt: string) -> discord.answer with discord.credential | io | prelude.throw[discord.discord_error | gate_unaskable] {
  let controls = [discord.button(id = "approve", label = "approve"), discord.button(id = "deny", label = "deny")]
  match (discord.check_controls(controls = controls)) {
    case discord.valid() -> discord.ask(channel = channel, prompt = prompt, controls = controls)
    case discord.invalid(reason => reason) -> refuse_to_open_the_gate(why = reason)
  }
}
```

One cap is deliberately **outside** what it can answer: the **prompt**. A question is one Discord
message, so its text is bound by `limits().message_text` (2000) — but the prompt is not a control, so
`check_controls` never sees it. A caller that builds a prompt out of text it did not write (a draft, a
brief, a stranger's message) has to bound that text itself against that number. Past it Discord refuses
the post, which means the question cannot be asked at all, which — for anything shaped like an approval
gate — means the action can never be approved however often it is retried.

`discord.fit_message(text, marker)` is that bounding, packaged:

```katari
import discord

agent gate_prompt(headline: string, draft: string) -> string {
  let prompt = discord.fit_message(
    text = f"${headline}\n\n${draft}",
    marker = "\n… (cut to fit one Discord message — ask for the rest)",
  )
  prompt
}
```

The room is `message_text` **minus the marker's own length**, because the marker is posted too —
measuring the text, cutting it to the cap and appending afterwards is the way this is got wrong, and it
lands back over the cap every time. Text that already fits comes back unchanged, so it is safe to wrap
around everything. The marker is *yours* because only you know what the reader needs told, and something
must be told: text silently docked reads exactly like text that ended, and a model reading it will
answer from a fragment as though it had the whole. Write it as the fact ("the first 1,900 of 7,400
characters"), not as a bare ellipsis.

Both are **pure** — no credential, no `io`, nothing to catch — so they belong where the controls are
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
import discord

@"What the approval gates." request do_it() -> null
@"…and what stands in for it when the answer was anything else." request skip() -> null
@"Send the mail AT THE VALUES that came back." request send(values: record[string]) -> null
@"…and what stands in for it when the operator denied." request refuse() -> null

// Approval: two buttons, and the program branches on the id it wrote.
agent approve(channel: string, what: string) -> null with discord.credential | do_it | skip | io | prelude.throw[discord.discord_error] {
  match (discord.ask(
    channel = channel,
    prompt = f"Approve: ${what}?",
    controls = [discord.button(id = "approve", label = "approve"), discord.button(id = "deny", label = "deny")],
  )) {
    case discord.clicked(id => "approve", by => _) -> do_it()
    case rest -> skip()
  }
}

// Editing a draft: a PREFILLED form beside a deny button. A submit is approval AT THOSE VALUES.
agent confirm_draft(channel: string, subject: string, body: string) -> null with discord.credential | send | refuse | io | prelude.throw[discord.discord_error] {
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
}
```

A form of one *empty* field is the free-text shape; a `select` over a computed list is the pick shape.

Once a question is answered the controls come off and the outcome stays: `→ <the control's label, or
the picked option> (by @who)`. So a `button`'s `label` and a `select`'s `option` strings are not only
what a human clicks — they become the channel's lasting, public account of what was decided. Write
them as the audit line you would want to find later. That line names the answerer as a Discord
mention; the `by` the `answer` carries is the raw id.

## Divergences from the slack twin

**The complete list lives in one place: the
[slack package's README](https://github.com/katari-lang/katari-package-slack#divergences-from-the-discord-twin),
under *Divergences*.** It is not repeated here, and that is the point — it used to be, in three places (this
file, the slack README, and the `slack.ktr` header), and all three had drifted apart into three
different lists by the time anyone compared them.

What keeps that one list honest is `slack/scripts/check-twin.mjs` (`pnpm test` in the slack package):
it reads *both* modules and compares every published name, every data field, every agent argument and
every callback's argument names. A shape one twin grows without the other fails the check until it is
either given to the other or **declared as a divergence, with a reason** — and those declarations are
what the slack README's table narrates. A number that differs is reported the same way: the script
prints the *portable envelope*, the tighter of each `limits()` pair, which is what a control rendering
on both platforms must fit.

The short version, for orientation: this side carries `display_name` and clamps over-long captions;
that side carries `message.thread` / `thread_ts`, takes two credentials, and rejects rather than clamps.
Trust the script and the slack README over this paragraph.

## Secrets / env

- `DISCORD_TOKEN` — your bot token. Store it in the runtime:
  `katari env set DISCORD_TOKEN --secret`. It is a `string of private`, resolved at every call and
  passed straight to the sidecar, which authenticates each REST call and each gateway login with it.

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

A third check covers the *twin contract* and lives in the other package, because it needs both modules:
`pnpm test` in `slack/` runs `scripts/check-twin.mjs`, which compares the two published surfaces name by
name and argument by argument. Run it whenever this package's surface changes — it is what turns "the
same data types with the same fields" from a claim in a README into something that fails a build.

## Usage

```katari
import discord

// Echo every message back to the channel it came from, attachments included.
// The callback's argument is named `value`: that is what `watch_messages` calls it with.
agent echo(value: discord.message) -> null {
  // `try_send` answers with its outcome. An echo has nobody to report to, so it drops the answer
  // deliberately — a bot that tells someone "posted" reads it instead.
  let _outcome = discord.try_send(channel = value.channel, text = f"echo: ${value.text}", files = value.files)
  null
}

agent echo_bot(channel: string) -> never {
  use discord.provider(source = credentials.env(key = "DISCORD_TOKEN"))
  discord.watch_messages(channel = channel, deliver_to = echo)
}
```

That bot escalates `prelude.throw[discord.discord_error | env.missing_secret | oauth.server_error]` to
its run root: nothing connects at the provider any more, so a bad token stops the watch rather than the
`use`. A resident bot forks the watch into a region instead and re-forks it on `region.crashed` — see
*What a runtime restart costs*, above.

To hand file posting to an AI loop as a tool, bind `discord.send_message` under a role-specific
description with a doc-on-`let` — the package no longer ships a separate `send_files` wrapper, because
a wrapper that differed only in argument order and doc text was one agent too many.
