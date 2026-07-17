# discord — the Discord gateway, as Katari agents

A single module, `discord`, plus its FFI sidecar `src/discord.ts`: a
[discord.js](https://discord.js.org) gateway client behind a provider, with watch / send agents on
top. The connection is **owned by the provider** — log in once, and every call in its scope shares
the same live gateway client. Independent of any AI layer: an app reacts to messages by handling the
`on_message` request with whatever logic it likes.

- `discord.provider(token = ...)` — logs in once and serves the connection for the extent of the
  continuation.
- `discord.watch_messages(channel_id)` — serve a channel forever, raising `on_message` once per
  incoming message. Never resolves; composes under `parallel [ … ]`.
- `discord.send_message(channel_id, text, files)` — post to a channel; pass `[]` for a plain text
  post.
- `discord.send_files(channel_id, files, caption)` — the tool shape of `send_message`, for an AI
  loop's tool list.

Files are first-class in both directions: an incoming message's attachments arrive as `file` values
(the sidecar downloads each from Discord's CDN and uploads it over the blob side channel), and
`send_message` posts `file` values back as Discord attachments.

The low-level externals (`create_discord_client`, `discord_send`, `discord_watch`) are implemented
in the sidecar, which keeps the live clients in a module-level map keyed by opaque handle.

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

agent echo_bot(channel_id: string) -> never {
  use discord.provider(token = env.get_secret(key = "DISCORD_TOKEN"))
  use handler {
    request discord.on_message(text: string, channel_id: string, files: array[file]) {
      discord.send_message(channel_id = channel_id, text = f"echo: ${text}", files = [])
      next null
    }
  }
  discord.watch_messages(channel_id = channel_id)
}
```

Hand `discord.send_files` to an AI loop's tool list to let the model post images and other files to
the channel on its own.
