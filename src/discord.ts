// The sidecar half of `discord.ktr` — the discord.js gateway client. Handlers register under this
// file's module path (`discord.*`). Clients live in a module-level map for the sidecar process's
// lifetime (one process per snapshot), keyed by the opaque handle Katari carries around.
//
// Files cross in both directions: an outgoing message's `file` values download over the blob side
// channel and attach to the Discord post; an incoming message's attachments download from Discord's
// CDN and upload over the same side channel, so the delivered message carries real `file` values.

import { katari, KatariData, type KatariAgent, type KatariFile } from "@katari-lang/port";
import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  Client,
  ComponentType,
  Events,
  GatewayIntentBits,
  type Message,
} from "discord.js";

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
  try {
    // Logging in is the connect: an invalid token / missing permission or a transient network fault
    // fails here. Raise it as the declared `prelude.throw[discord_error]`, classified auth vs api by
    // HTTP status (the credential is fixed at start, so a bad token cannot recover), so the provider's
    // caller can catch it instead of the run panicking. Nothing to close — the client never logged in.
    await client.login(token);
  } catch (error) {
    katari.throw(new KatariData(discordErrorConstructor(error), { message: discordErrorMessage(error) }));
  }
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

katari.agent<{ client: string; channel: string; text: string; files: KatariFile[] }>(
  "discord_send",
  async ({ client, channel, text, files }) => {
    // An unknown handle is a program defect (a `client` value the runtime never minted), so it stays a
    // bare throw = panic; only the Discord API calls below fail at execution and become a catchable
    // `discord_error`.
    const connection = connectionOf(client);
    try {
      const target = await connection.channels.fetch(channel);
      if (target === null || !target.isSendable()) {
        // Not a bug — a per-channel execution failure; the catch below tags it `api_error` (no HTTP
        // status).
        throw new Error(`channel ${channel} is not a sendable text channel`);
      }
      // Each file's bytes come over the blob side channel; Discord wants a Buffer + a filename. The
      // slim handle carries no metadata, so the MIME type rides in with the same download.
      const attachments = await Promise.all(
        files.map(async (file, index) => ({
          attachment: Buffer.from(await file.bytes()),
          name: attachmentName(await file.contentType(), index),
        })),
      );
      await target.send({
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

katari.agent<{ client: string; channel: string; prompt: string; options: string[] }>(
  "discord_ask",
  async ({ client, channel, prompt, options }, context) => {
    const connection = connectionOf(client);
    let posted: Message;
    try {
      const target = await connection.channels.fetch(channel);
      if (target === null || !target.isSendable()) {
        throw new Error(`channel ${channel} is not a sendable text channel`);
      }
      // One button per option; the customId is the option INDEX so the label itself (which Discord
      // caps at 80 characters) never has to round-trip as an identifier.
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        options.map((label, index) =>
          new ButtonBuilder().setCustomId(String(index)).setLabel(label).setStyle(ButtonStyle.Primary),
        ),
      );
      posted = await target.send({ content: prompt, components: [row] });
    } catch (error) {
      // Posting the prompt is the Discord API call that can fail; classify and raise it as the
      // declared `discord_error` exactly as discord_send does.
      katari.throw(new KatariData(discordErrorConstructor(error), { message: discordErrorMessage(error) }));
      // `katari.throw` never returns; the rethrow only satisfies definite assignment on `posted`.
      throw error;
    }
    // The wait: the FIRST button click on this message answers it. No time limit — the decision may
    // land hours later; a runtime restart interrupts the external call under the at-most-once rule.
    return new Promise<string>((resolve, reject) => {
      const collector = posted.createMessageComponentCollector({
        componentType: ComponentType.Button,
        max: 1,
      });
      collector.on("collect", (interaction: ButtonInteraction) => {
        void (async () => {
          const chosen = options[Number(interaction.customId)] ?? interaction.customId;
          // Strip the buttons and show the outcome, so the channel keeps a readable record and a
          // second click has nothing to press.
          await interaction.update({ content: `${prompt}\n→ ${chosen} (by ${interaction.user.tag})`, components: [] });
          resolve(chosen);
        })().catch((error) => reject(error instanceof Error ? error : new Error(String(error))));
      });
      // The runtime cancelled the call (run cancel / teardown): stop collecting and settle. The
      // stale buttons stay in the channel; clicking them later gets Discord's own "interaction
      // failed" notice.
      context.signal.addEventListener("abort", () => {
        collector.stop();
        reject(new Error("cancelled"));
      });
    });
  },
);

katari.agent<{ client: string; channel: string; deliver_to: KatariAgent }>(
  "discord_watch",
  ({ client, channel, deliver_to }, context) => {
    const connection = connectionOf(client);
    return new Promise<never>((_resolve, reject) => {
      const listener = (message: {
        author: { bot: boolean; id: string };
        channelId: string;
        content: string;
        attachments: Map<string, { url: string; contentType: string | null }>;
      }) => {
        if (message.author.bot || message.channelId !== channel) return;
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
          await deliver_to.call({
            channel: message.channelId,
            text: message.content,
            files,
            // The raw snowflake; the Katari side decides whether and how to hash it before it
            // leaves the program.
            author: message.author.id,
          });
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
