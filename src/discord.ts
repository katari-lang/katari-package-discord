// The sidecar half of `discord.ktr` — the discord.js gateway client. Handlers register under this
// file's module path (`discord.*`). Clients live in a module-level map for the sidecar process's
// lifetime (one process per snapshot), keyed by the opaque handle Katari carries around.
//
// Files cross in both directions: an outgoing message's `file` values download over the blob side
// channel and attach to the Discord post; an incoming message's attachments download from Discord's
// CDN and upload over the same side channel, so the delivered message carries real `file` values.

import { katari, KatariData, type KatariAgent, type KatariFile } from "@katari-lang/port";
import { Client, Events, GatewayIntentBits } from "discord.js";

const clients = new Map<string, Client>();
let nextHandle = 1;

/** Read a property off an unknown value without asserting its shape. */
function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

/** The human-readable message for a `discord_error` payload — the JS message off the thrown error. */
function discordErrorMessage(error: unknown): string {
  const message = property(error, "message");
  return typeof message === "string" && message.length > 0 ? message : String(error);
}

/** The qualified `discord_error` constructor for a failure: an invalid token (HTTP 401) or a missing
 *  permission (HTTP 403) is `auth_error` — the operator must fix the credential; everything else (a
 *  rate limit, an unsendable channel, a transient fault) is `api_error`. A failure with no HTTP status
 *  (a transport fault, an unsendable-channel guard) defaults to `api_error`. */
function discordErrorConstructor(error: unknown): string {
  const status = property(error, "status");
  return status === 401 || status === 403 ? "discord.auth_error" : "discord.api_error";
}

/** A filename for an attachment payload: Discord requires one; derive the extension from the MIME
 *  type so an image previews inline instead of downloading as a generic binary. */
function attachmentName(contentType: string | undefined, index: number): string {
  const extensions: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "application/pdf": "pdf",
    "text/plain": "txt",
  };
  const extension = (contentType !== undefined ? extensions[contentType] : undefined) ?? "bin";
  return `file-${index + 1}.${extension}`;
}

katari.agent<{ token: string }>("create_discord_client", async ({ token }) => {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  await client.login(token);
  const handle = `discord-${nextHandle}`;
  nextHandle += 1;
  clients.set(handle, client);
  return handle;
});

katari.agent<{ client: string }>("discord_close", async ({ client }) => {
  // The provider arms this as a `finally`, so a run that ends (completes, is cancelled, or unwinds)
  // tears its gateway connection down: a client left alive stays logged in and keeps receiving events
  // long after its run is gone.
  const connection = clients.get(client);
  // Idempotent: an unknown or already-closed handle is a no-op — a finalizer may run more than once,
  // and a sidecar restart drops the map entirely.
  if (connection === undefined) return null;
  // Drop the entry before destroying so a re-run (or a concurrent lookup) cannot see it half-closed.
  clients.delete(client);
  // `destroy` logs the bot out and closes the gateway WebSocket — discord.js's documented shutdown.
  await connection.destroy();
  return null;
});

katari.agent<{ client: string; channel_id: string; text: string; files: KatariFile[] }>(
  "discord_send",
  async ({ client, channel_id, text, files }) => {
    // An unknown handle is a program defect (a `client` value the runtime never minted), so it stays a
    // bare throw = panic; only the Discord API calls below fail at execution and become a catchable
    // `discord_error`.
    const connection = connectionOf(client);
    try {
      const channel = await connection.channels.fetch(channel_id);
      if (channel === null || !channel.isSendable()) {
        // Not a bug — a per-channel execution failure; the catch below tags it `api_error` (no HTTP
        // status).
        throw new Error(`channel ${channel_id} is not a sendable text channel`);
      }
      // Each file's bytes come over the blob side channel; Discord wants a Buffer + a filename. The
      // slim handle carries no metadata, so the MIME type rides in with the same download.
      const attachments = await Promise.all(
        files.map(async (file, index) => ({
          attachment: Buffer.from(await file.bytes()),
          name: attachmentName(await file.contentType(), index),
        })),
      );
      await channel.send({
        // Discord rejects an empty content string; with attachments the text is optional.
        ...(text === "" ? {} : { content: text }),
        ...(attachments.length > 0 ? { files: attachments } : {}),
      });
      return null;
    } catch (error) {
      // Raise the execution failure as the declared `prelude.throw[discord_error]`, classified auth vs
      // api by HTTP status (qualified constructor name — the boundary checks the tag against the schema
      // const), so the caller can catch it instead of the run panicking.
      katari.throw(new KatariData(discordErrorConstructor(error), { message: discordErrorMessage(error) }));
    }
  },
);

katari.agent<{ client: string; channel_id: string; deliver_to: KatariAgent }>(
  "discord_watch",
  ({ client, channel_id, deliver_to }, context) => {
    const connection = connectionOf(client);
    return new Promise<never>((_resolve, reject) => {
      const listener = (message: {
        author: { bot: boolean };
        channelId: string;
        content: string;
        attachments: Map<string, { url: string; contentType: string | null }>;
      }) => {
        if (message.author.bot || message.channelId !== channel_id) return;
        // Deliver back into the runtime as an inner delegation; the callback's effects escalate
        // through this call to the app's handlers. Attachments download from the CDN and lift into
        // `file` values first (one that fails to download is dropped rather than failing the whole
        // message). A delivery failure tears the watch down (the app's panic clause reports it).
        void (async () => {
          const files: KatariFile[] = [];
          for (const attachment of message.attachments.values()) {
            const response = await fetch(attachment.url);
            if (!response.ok) continue;
            files.push(
              await context.file(new Uint8Array(await response.arrayBuffer()), {
                ...(attachment.contentType === null
                  ? {}
                  : { contentType: attachment.contentType }),
              }),
            );
          }
          await deliver_to.call({ channel_id: message.channelId, text: message.content, files });
        })().catch((error) => {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      };
      const cleanup = () => connection.off(Events.MessageCreate, listener);
      connection.on(Events.MessageCreate, listener);
      // The runtime cancelled the call (run cancel / teardown): stop listening and settle.
      context.signal.addEventListener("abort", () => {
        cleanup();
        reject(new Error("discord watch cancelled"));
      });
    });
  },
);

function connectionOf(handle: string): Client {
  const connection = clients.get(handle);
  if (connection === undefined) {
    throw new Error(`unknown discord client handle: ${handle}`);
  }
  return connection;
}
