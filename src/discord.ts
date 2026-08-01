// The sidecar half of `discord.ktr`: a discord.js REST client for what Discord can be told, and a
// gateway socket for what it has to be listened to for. Handlers register under this file's module
// path (`discord.*`).
//
// Every handler takes the bot token and no Katari value names anything in this process, so both caches
// below are keyed by the token and pointed at by nothing. `discord_watch` / `discord_ask` lease one
// gateway per token, refcounted and closed when the last of them ends; a restart comes up with an empty
// cache and the calls that held it were already dead.
//
// A message may carry buttons and dropdowns but no text input, and text input exists only in a modal
// dialog that Discord opens only in reply to a click — so a katari `form` renders as a button that
// opens the dialog: two Discord steps behind one katari answer.

import {
  katari,
  KatariCancelledError,
  KatariData,
  type KatariAgent,
  type KatariFile,
  KatariThrowError,
} from "@katari-lang/port";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ComponentType,
  Events,
  GatewayIntentBits,
  GuildMember,
  LabelBuilder,
  type MessageActionRowComponentBuilder,
  type MessageComponentInteraction,
  ModalBuilder,
  type ModalSubmitInteraction,
  type RawFile,
  REST,
  Routes,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

/** How many buttons Discord fits on one action row. */
const BUTTONS_PER_ROW = 5;

/** The prefix on a dialog's own custom id, so a submit is recognisable as one this package opened. */
const MODAL_ID_PREFIX = "modal:";

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
 *  (a transport fault, a malformed reply) defaults to `api_error`. */
function discordErrorConstructor(error: unknown): string {
  const status = property(error, "status");
  return status === 401 || status === 403 ? "discord.auth_error" : "discord.api_error";
}

// ─── the two caches: a token's REST client, and a token's gateway socket ───────────────────────────

/** The REST client for a bot token. Cached to reuse the connection pool and the route rate-limit
 *  buckets, and for no other reason: a fresh one behaves identically. */
const restClients = new Map<string, REST>();

function restFor(token: string): REST {
  const cached = restClients.get(token);
  if (cached !== undefined) return cached;
  const rest = new REST({ version: "10" }).setToken(token);
  restClients.set(token, rest);
  return rest;
}

/** The part of a message this package reads, named so the fan-out below has a type to hand each
 *  watcher — and so the gateway path and the REST history path cannot drift on what a
 *  `discord.message` is made of. A gateway MESSAGE_CREATE satisfies it as delivered; a history page's
 *  raw JSON is normalised into it by `historyMessages`. */
interface IncomingMessage {
  id: string;
  author: { bot: boolean; id: string; globalName: string | null; username: string };
  // The guild member the author is in the channel's server, and null in a DM — where there is no server
  // to hold a nickname. The display-name chain is total without it.
  member: { nickname: string | null } | null;
  channelId: string;
  content: string;
  attachments: Map<string, { url: string; contentType: string | null }>;
}

/** One live `discord_watch`, called with every message the socket receives; it filters by its own
 *  channel. */
type MessageWatcher = (message: IncomingMessage) => void;

/** One open `discord_ask`, called with each interaction that arrived for its question. */
type QuestionRouter = (interaction: MessageComponentInteraction | ModalSubmitInteraction) => void;

/** One gateway socket, shared by every live `discord_watch` / `discord_ask` on the same token. The
 *  sharing is invisible: no Katari value names it, so a restart just starts with none. */
interface Gateway {
  client: Client;
  /** Resolves when the socket is IDENTIFIED and receiving; rejects with the login failure. A question
   *  waits for it before posting, because Discord delivers an interaction only to a session that is
   *  connected at the moment the human clicks — a click that lands on nobody is a click nobody repeats. */
  ready: Promise<void>;
  /** How many live calls hold this socket. The last one out closes it. */
  leases: number;
  /** The live watches, and the open questions keyed by the id of the message their controls are on.
   *  ONE emitter listener fans out to each set, so a bot holding a dozen watches or questions still
   *  installs exactly one (Node warns past ten on an emitter). */
  watchers: Set<MessageWatcher>;
  questions: Map<string, QuestionRouter>;
}

const gateways = new Map<string, Gateway>();

/** Lease the gateway socket for `token`, opening one if this is the first caller.
 *
 *  Synchronous on purpose: the caller registers itself on the returned gateway before awaiting `ready`,
 *  so there is no window in which this package is connected and receiving events nobody is listening
 *  for. A login failure evicts the entry, so the next call opens a fresh socket rather than inheriting
 *  a cached rejection. */
function acquireGateway(token: string): Gateway {
  const existing = gateways.get(token);
  if (existing !== undefined) {
    existing.leases += 1;
    return existing;
  }
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  const watchers = new Set<MessageWatcher>();
  const questions = new Map<string, QuestionRouter>();
  // The routers go on BEFORE the login, so the socket has somewhere to deliver its first event.
  client.on(Events.MessageCreate, (message) => {
    for (const watcher of watchers) watcher(message);
  });
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isMessageComponent() && !interaction.isModalSubmit()) return;
    // Both a component press and a dialog submit carry the message their controls are on, and that is
    // the question's identity here: two questions open in the same channel, even offering the same
    // control id, cannot cross. A submit is a FRESH interaction with its own token, which is why it
    // arrives on the client rather than on the message that opened it.
    const originating = interaction.message?.id;
    if (originating === undefined) return;
    questions.get(originating)?.(interaction);
  });
  const ready = new Promise<void>((resolve, reject) => {
    client.once(Events.ClientReady, () => resolve());
    // Logging in is the connect: an invalid token (Discord answers the gateway fetch 401), a disallowed
    // intent or a transient network fault fails here, and the caller classifies it as `discord_error`.
    client.login(token).catch((error: unknown) => {
      // A failed open is not cached — the next call opens a fresh socket, as e2b's provider retries an
      // open it could not complete. Identity-checked, so a later call's own gateway is never evicted.
      // discord.js destroys the client itself before rejecting, so there is nothing left to close here.
      const current = gateways.get(token);
      if (current?.client === client) gateways.delete(token);
      reject(error);
    });
  });
  const gateway: Gateway = { client, ready, leases: 1, watchers, questions };
  gateways.set(token, gateway);
  return gateway;
}

/** Give up one lease, closing the socket when the last holder leaves: a gateway kept alive past the
 *  calls that wanted it is a bot still logged in with nobody listening. Lingering instead — holding the
 *  socket a while in case another call wants it — would be a timer bought with a connection nobody is
 *  using, so the close is immediate and a re-fork pays a fresh login.
 *
 *  Identity-checked rather than keyed: a gateway whose login failed was already evicted and may have
 *  been replaced by a later call's own socket, which this lease never held. */
async function releaseGateway(token: string, gateway: Gateway): Promise<void> {
  if (gateways.get(token) !== gateway) return;
  gateway.leases -= 1;
  if (gateway.leases > 0) return;
  gateways.delete(token);
  try {
    await gateway.client.destroy();
  } catch {
    // The socket is going either way, and a failed teardown must not replace the call's own outcome.
  }
}

/** The name Discord's own client shows for a person, resolved the way that client resolves it: the
 *  per-server nickname where they set one, else the account's global display name, else the username.
 *  The chain is TOTAL because its last link is `username`, which every account has — so a DM, where
 *  there is no guild member and therefore no nickname at all, still names its sender.
 *
 *  What the name is NOT is decided at the katari boundary rather than here: it is self-chosen and
 *  non-unique, so the id travels beside it and stays the identity. This function only resolves; the
 *  program decides what a name may be used for. */
function displayNameOf(
  nickname: string | null,
  user: { globalName: string | null; username: string },
): string {
  return nickname ?? user.globalName ?? user.username;
}

/** The per-server nickname on an interaction's member, or null when there is none — a DM carries no
 *  member at all, and a member may simply not have set one.
 *
 *  Both member shapes are read because discord.js hands over EITHER its own `GuildMember` (when the
 *  guild is cached) or the raw `APIInteractionGuildMember` the gateway sent (when it is not), and the
 *  two spell the same field differently: `nickname` on the class, `nick` on the wire payload. Reading
 *  only the cached spelling would silently fall back to the global name for anyone in an uncached
 *  guild, which reads as "they have no nickname" rather than as the miss it is. */
function interactionNickname(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
): string | null {
  const member = interaction.member;
  if (member === null) return null;
  return member instanceof GuildMember ? member.nickname : (member.nick ?? null);
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

/** Whether `bytes` carries `signature` at `offset` — the one comparison every magic number below is
 *  made of. */
function matchesSignature(bytes: Uint8Array, offset: number, signature: number[]): boolean {
  return (
    bytes.length >= offset + signature.length &&
    signature.every((byte, index) => bytes[offset + index] === byte)
  );
}

/** The content type the bytes prove, or undefined when they prove nothing. Discord types an attachment
 *  by its filename extension and never reads the bytes, so a PNG saved as `photo.webp` arrives declared
 *  `image/webp` — and an AI provider downstream byte-checks the declared media type and rejects the
 *  whole request on a mismatch. The signatures covered are exactly that byte-checked set: the four
 *  inlined image types plus PDF. Anything else keeps Discord's word. */
function sniffedContentType(bytes: Uint8Array): string | undefined {
  if (matchesSignature(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (matchesSignature(bytes, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (matchesSignature(bytes, 0, [0x47, 0x49, 0x46, 0x38])) return "image/gif"; // "GIF8"
  // "RIFF" alone is a container family (WAV shares it); the "WEBP" tag at offset 8 is the image.
  if (
    matchesSignature(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
    matchesSignature(bytes, 8, [0x57, 0x45, 0x42, 0x50])
  ) {
    return "image/webp";
  }
  if (matchesSignature(bytes, 0, [0x25, 0x50, 0x44, 0x46])) return "application/pdf"; // "%PDF"
  return undefined;
}

/** The message id off a Discord reply to a post. A 2xx that names no message is a malformed reply, and
 *  calling it a success would hand the program back an id nothing can address — the same shape filter
 *  `e2b_put_file` applies to the path a write reports. */
function postedMessageId(reply: unknown, what: string): string {
  const id = property(reply, "id");
  if (typeof id !== "string" || id === "") {
    throw new Error(`Discord confirmed ${what} with no message id`);
  }
  return id;
}

/** Every attachment of one message, downloaded from Discord's CDN and lifted into `file` values — the
 *  half of a delivered message that costs bandwidth, shared by the gateway path and the history read so
 *  a reconciled message carries exactly what a watched one carries. One attachment that fails to
 *  download is DROPPED rather than failing the whole message: a message minus one image is still worth
 *  handling, and the alternative (tearing the read down) loses the text as well. */
async function downloadAttachments(
  message: IncomingMessage,
  context: { file: (bytes: Uint8Array, options: { contentType?: string }) => Promise<KatariFile> },
): Promise<KatariFile[]> {
  const files: KatariFile[] = [];
  for (const attachment of message.attachments.values()) {
    const response = await fetch(attachment.url);
    if (!response.ok) continue;
    const bytes = new Uint8Array(await response.arrayBuffer());
    // The bytes' own word beats Discord's extension-derived claim; the claim stands only where the
    // bytes prove nothing. A sniffed type also fills a NULL claim, so a proxied upload Discord never
    // typed classifies as the image it is instead of as opaque bytes.
    const contentType = sniffedContentType(bytes) ?? attachment.contentType ?? undefined;
    files.push(
      await context.file(bytes, {
        ...(contentType === undefined ? {} : { contentType }),
      }),
    );
  }
  return files;
}

/** One `discord.message` data value. THE one place the delivered shape is spelled, so the gateway and
 *  the history read cannot grow apart — a field added here reaches both paths or neither. */
function messageValue(message: IncomingMessage, files: KatariFile[]): KatariData {
  return new KatariData("discord.message", {
    // The message's own id: what a caller keeps as a cursor and hands back to `list_messages`.
    id: message.id,
    channel: message.channelId,
    // The raw snowflake; the Katari side decides whether and how to hash it before it leaves the
    // program.
    author: message.author.id,
    // The name beside the id, so an app CAN address a sender rather than only correlate them. Carried,
    // never judged: whether a self-chosen name may cross to an AI provider is the app's call, and the
    // type's doc is where it is told the name identifies nobody.
    display_name: displayNameOf(message.member?.nickname ?? null, message.author),
    text: message.content,
    files,
  });
}

/** One history page's raw JSON, normalised into the shape the gateway path already delivers. The REST
 *  payload is snake_case where the gateway object is camelCase, and its partial member calls the
 *  nickname `nick`, so every field is read defensively: an entry this cannot read as a message is
 *  dropped rather than delivered half-built. Discord answers NEWEST FIRST, so the caller reverses. */
function historyMessages(payload: unknown): IncomingMessage[] {
  if (!Array.isArray(payload)) return [];
  const messages: IncomingMessage[] = [];
  for (const entry of payload) {
    const id = property(entry, "id");
    const channelId = property(entry, "channel_id");
    const author = property(entry, "author");
    const authorId = property(author, "id");
    if (typeof id !== "string" || typeof channelId !== "string" || typeof authorId !== "string") {
      continue;
    }
    const globalName = property(author, "global_name");
    const username = property(author, "username");
    const nickname = property(property(entry, "member"), "nick");
    const content = property(entry, "content");
    const attachments = new Map<string, { url: string; contentType: string | null }>();
    const rawAttachments = property(entry, "attachments");
    if (Array.isArray(rawAttachments)) {
      for (const attachment of rawAttachments) {
        const url = property(attachment, "url");
        if (typeof url !== "string") continue;
        const contentType = property(attachment, "content_type");
        const key = property(attachment, "id");
        attachments.set(typeof key === "string" ? key : url, {
          url,
          contentType: typeof contentType === "string" ? contentType : null,
        });
      }
    }
    messages.push({
      id,
      author: {
        bot: property(author, "bot") === true,
        id: authorId,
        globalName: typeof globalName === "string" ? globalName : null,
        username: typeof username === "string" ? username : "",
      },
      member: typeof nickname === "string" ? { nickname } : null,
      channelId,
      content: typeof content === "string" ? content : "",
      attachments,
    });
  }
  return messages;
}

/** Discord's own cap on one `GET /channels/{id}/messages`, and the ONE place it is written: the Katari
 *  side documents the clamp in prose and passes the caller's number through, so there is no second
 *  copy to drift. */
const HISTORY_PAGE_MAX = 100;

katari.agent<{ token: string; channel: string; after: string; limit: number }>(
  "discord_history",
  async ({ token, channel, after, limit }, context) => {
    try {
      const asked = Number.isFinite(limit) ? Math.trunc(limit) : 1;
      const query = new URLSearchParams({
        limit: String(Math.min(Math.max(asked, 1), HISTORY_PAGE_MAX)),
      });
      // `after` is exclusive and Discord rejects an empty one, so an absent cursor simply omits it —
      // which is the newest page, the shape a first run with nothing kept yet asks for.
      if (after !== "") query.set("after", after);
      const payload = await restFor(token).get(Routes.channelMessages(channel), { query });
      // Newest first out of Discord, posted order out of here — a caller replaying a gap runs the
      // messages through the same handling in the order they were written.
      const page = historyMessages(payload).reverse();
      const values: KatariData[] = [];
      for (const message of page) {
        // Bot posts are dropped exactly as the watch drops them, so one handler serves both paths.
        if (message.author.bot) continue;
        values.push(messageValue(message, await downloadAttachments(message, context)));
      }
      return values;
    } catch (error) {
      // Classified auth vs api by HTTP status, exactly as a send is: a token Discord rejects and a
      // channel the bot cannot read are the operator's to fix, everything else is this call's bad luck.
      katari.throw(new KatariData(discordErrorConstructor(error), { message: discordErrorMessage(error) }));
      // `katari.throw` never returns; the rethrow only satisfies the declared return type.
      throw error;
    }
  },
);

/** The multipart parts for a katari `file` list. Each file's bytes come over the blob side channel; the
 *  slim handle carries no metadata, so the MIME type rides in with the same download. */
async function attachmentParts(files: KatariFile[]): Promise<RawFile[]> {
  return Promise.all(
    files.map(async (file, index) => {
      const contentType = await file.contentType();
      return {
        data: Buffer.from(await file.bytes()),
        name: attachmentName(contentType, index),
        ...(contentType === undefined ? {} : { contentType }),
      };
    }),
  );
}

/** The `attachments` entries that pair a post's uploaded parts with its payload, by index — the shape
 *  discord.js's own message payload sends; the filename travels on the multipart part itself. */
function attachmentDescriptors(parts: RawFile[]): { id: string }[] {
  return parts.map((_part, index) => ({ id: index.toString() }));
}

katari.agent<{ token: string; channel: string; text: string; files: KatariFile[] }>(
  "discord_send",
  async ({ token, channel, text, files }) => {
    try {
      const parts = await attachmentParts(files);
      const posted = await restFor(token).post(Routes.channelMessages(channel), {
        body: {
          // Discord rejects an empty content string; with attachments the text is optional.
          ...(text === "" ? {} : { content: text }),
          ...(parts.length > 0 ? { attachments: attachmentDescriptors(parts) } : {}),
        },
        ...(parts.length > 0 ? { files: parts } : {}),
      });
      // The posted message's id — the seam a later edit / reaction / thread reply addresses.
      return postedMessageId(posted, "the post");
    } catch (error) {
      // Raise the execution failure as the declared `prelude.throw[discord_error]`, classified auth vs
      // api by HTTP status (qualified constructor name — the boundary checks the tag against the schema
      // const), so the caller can catch it instead of the run panicking. A channel that is not a
      // sendable text channel, a channel id that names nothing and a payload past a platform cap are
      // all Discord's own refusals now, and all `api_error`.
      katari.throw(new KatariData(discordErrorConstructor(error), { message: discordErrorMessage(error) }));
      // `katari.throw` never returns; the rethrow only satisfies the declared return type.
      throw error;
    }
  },
);

// ─── the interaction plane: controls in, one answer out ───────────────────────────────────────────

/** One text box of a form, as the katari `field` data value declared it. */
interface FormField {
  id: string;
  label: string;
  value: string;
  multiline: boolean;
}

/** A katari `control` value, narrowed to what rendering and correlation need. The `id` is the whole
 *  correlation key: it becomes the rendered component's Discord custom id and comes back verbatim on
 *  the answer, so the katari program branches on the identifier it wrote rather than on a label a human
 *  reads or an index that shifts when the control list changes. */
type Control =
  | { kind: "button"; id: string; label: string }
  | { kind: "select"; id: string; label: string; options: string[] }
  | { kind: "form"; id: string; label: string; title: string; fields: FormField[] };

/** Read a string field off a decoded data value's fields. The katari call site was checked against the
 *  declared schema, so a non-string cannot arrive; the fallback only keeps the reader total. */
function stringField(fields: unknown, key: string): string {
  const value = property(fields, key);
  return typeof value === "string" ? value : "";
}

function booleanField(fields: unknown, key: string): boolean {
  return property(fields, key) === true;
}

function stringArrayField(fields: unknown, key: string): string[] {
  const value = property(fields, key);
  return Array.isArray(value) ? value.map((element) => (typeof element === "string" ? element : "")) : [];
}

function formFields(fields: unknown, key: string): FormField[] {
  const value = property(fields, key);
  if (!Array.isArray(value)) return [];
  return value.map((element) => {
    const box = element instanceof KatariData ? element.value : undefined;
    return {
      id: stringField(box, "id"),
      label: stringField(box, "label"),
      value: stringField(box, "value"),
      multiline: booleanField(box, "multiline"),
    };
  });
}

/** Read one decoded `control` value. An unrecognised constructor means the wire disagrees with the
 *  schema the compiler checked, which is a defect rather than an execution failure — so it stays a bare
 *  throw (a panic). */
function readControl(value: unknown): Control {
  const fields = value instanceof KatariData ? value.value : undefined;
  const name = value instanceof KatariData ? value.name : "";
  switch (name) {
    case "discord.button":
      return { kind: "button", id: stringField(fields, "id"), label: stringField(fields, "label") };
    case "discord.select":
      return {
        kind: "select",
        id: stringField(fields, "id"),
        label: stringField(fields, "label"),
        options: stringArrayField(fields, "options"),
      };
    case "discord.form":
      return {
        kind: "form",
        id: stringField(fields, "id"),
        label: stringField(fields, "label"),
        title: stringField(fields, "title"),
        fields: formFields(fields, "fields"),
      };
    default:
      throw new Error(`unknown discord control constructor: ${name}`);
  }
}

// ─── the caps the builders enforce, and what this package does with each ──────────────────────────

/** What `@discordjs/builders` refuses, read off the predicates in its `dist/index.js` (1.14.1): every
 *  string this package renders goes through an `s.string()` with a maximum, and all but the two noted
 *  below also demand at least one character, so a blank string is as fatal as a long one.
 *
 *  Every number here is also published from Katari by `discord.limits()`. Nothing in Katari can read a
 *  constant out of this file, so `scripts/check-limits.mjs` fails when the two copies disagree. */
const LIMIT = {
  /** `buttonLabelValidator`: 1–80. A `form`'s opening button reads through here too. */
  buttonLabel: 80,
  /** `placeholderValidator`: at most 150, and the one string with NO minimum. */
  selectPlaceholder: 150,
  /** `labelValueDescriptionValidator`, applied to a select option's label AND its value: 1–100. */
  selectOption: 100,
  /** `titleValidator` on a modal: 1–45. */
  modalTitle: 45,
  /** `labelPredicate.label` on a `LabelBuilder`: 1–45 — the cap a 67-character field label broke. */
  fieldLabel: 45,
  /** `customIdValidator`, on every component's custom id: 1–100. */
  customId: 100,
  /** `valueValidator` on a text input's prefill: at most 4000, no minimum. */
  textInputValue: 4000,
};

/** A `form`'s id has to fit its DIALOG's custom id as well, which carries `MODAL_ID_PREFIX` — so its own
 *  bound is that much shorter than a plain control's. */
const FORM_ID_LIMIT = LIMIT.customId - MODAL_ID_PREFIX.length;

/** A COSMETIC string, made renderable. A caption, a title or a field label is presentation: a shortened
 *  one still does its job, so it is clamped (with an ellipsis, so a developer looking at the rendered
 *  control can see that it happened) rather than allowed to fail the question. A BLANK one is substituted
 *  with @fallback@ — the builders' predicates demand a character and an unlabelled control is unusable
 *  anyway — and the control's own id is both non-empty and a name the program's author will recognise. */
function presentation(text: string, limit: number, fallback: string): string {
  const shown = text === "" ? fallback : text;
  return shown.length <= limit ? shown : `${shown.slice(0, limit - 1)}…`;
}

/** A LOAD-BEARING string, CHECKED rather than clamped, because shortening it would change what the
 *  question means rather than how it looks: a custom id is how Discord routes the interaction back (two
 *  clamped ids could collide and answer the wrong control), a select option's text is the very value
 *  `chose` carries, and a prefill is the draft a human submits as approved — a silently docked draft
 *  would let someone approve a document they never saw whole. An out-of-range one fails the question
 *  instead: every call site below renders inside a `try` that raises this as the typed `api_error` a
 *  broken question is supposed to become, so it is catchable at the katari call site and never a panic. */
function checked(what: string, value: string, minimum: number, limit: number): string {
  if (value.length < minimum) {
    throw new Error(`discord ${what} is empty, and it names the value it carries`);
  }
  if (value.length > limit) {
    throw new Error(`discord ${what} is ${value.length} characters; Discord allows at most ${limit}`);
  }
  return value;
}

/** Lay the controls out in declaration order: buttons pack into rows of five, and a dropdown takes a row
 *  of its own (Discord allows no other component beside one). A `form` contributes the BUTTON that opens
 *  its dialog, so it packs like any other button. COUNTS are left to the platform — a sixth row, a 26th
 *  option: an overflowing payload is rejected by Discord and surfaces as `api_error`. Only the STRINGS are
 *  handled here, because those are what a builder refuses synchronously. */
function renderRows(controls: Control[]): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  let buttons: ButtonBuilder[] = [];
  const flushButtons = () => {
    if (buttons.length === 0) return;
    rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(buttons));
    buttons = [];
  };
  for (const control of controls) {
    if (control.kind === "select") {
      flushButtons();
      const menu = new StringSelectMenuBuilder()
        .setCustomId(checked("select id", control.id, 1, LIMIT.customId))
        // The option's text is both what the human reads and what comes back as `chose.option`: the answer
        // is the option itself, so there is no second identifier to keep in step — and therefore nothing
        // here is presentation. Clamping an option would report a choice the program never offered.
        .addOptions(
          control.options.map((option) => {
            const text = checked("select option", option, 1, LIMIT.selectOption);
            return { label: text, value: text };
          }),
        );
      // A blank placeholder is the absence of one: Discord's own default line reads better than a
      // substituted identifier, and this is the one string whose predicate accepts no character at all.
      if (control.label !== "") {
        menu.setPlaceholder(presentation(control.label, LIMIT.selectPlaceholder, control.id));
      }
      rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu));
      continue;
    }
    if (buttons.length === BUTTONS_PER_ROW) flushButtons();
    // A `form`'s id also names its DIALOG, so it is held to the shorter bound HERE, where the question
    // posts — rather than leaving a human to press a button whose dialog then cannot be routed back.
    const idLimit = control.kind === "form" ? FORM_ID_LIMIT : LIMIT.customId;
    buttons.push(
      new ButtonBuilder()
        .setCustomId(checked("control id", control.id, 1, idLimit))
        .setLabel(presentation(control.label, LIMIT.buttonLabel, control.id))
        .setStyle(ButtonStyle.Primary),
    );
  }
  flushButtons();
  return rows;
}

/** The dialog a `form`'s button opens: one labelled box per field, prefilled where the program supplied
 *  a draft. */
function renderModal(form: Control & { kind: "form" }): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`${MODAL_ID_PREFIX}${checked("form id", form.id, 1, FORM_ID_LIMIT)}`)
    .setTitle(presentation(form.title, LIMIT.modalTitle, form.id))
    .addLabelComponents(
      form.fields.map((field) => {
        const id = checked("field id", field.id, 1, LIMIT.customId);
        const input = new TextInputBuilder()
          .setCustomId(id)
          .setStyle(field.multiline ? TextInputStyle.Paragraph : TextInputStyle.Short)
          // Never required: a box left blank must still submit, so `submitted.values` reports what the
          // human actually left instead of the platform forcing text into every field.
          .setRequired(false);
        // An empty prefill is the absence of one; Discord rejects an empty `value`.
        if (field.value !== "") {
          // Checked, never clamped: a submit means "approved AT THESE VALUES", so a draft quietly docked
          // to fit would be approved as though it were whole.
          input.setValue(checked("field prefill", field.value, 0, LIMIT.textInputValue));
        }
        return new LabelBuilder()
          .setLabel(presentation(field.label, LIMIT.fieldLabel, id))
          .setTextInputComponent(input);
      }),
    );
}

/** Every declared field's text, keyed by field id. Read from the FORM's declaration rather than from
 *  what came back, so the record is total over the fields the program asked for — a blank box is the
 *  empty string, never a missing key. */
function submittedValues(
  interaction: ModalSubmitInteraction,
  form: Control & { kind: "form" },
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of form.fields) {
    const submitted = interaction.fields.fields.get(field.id);
    const value = submitted?.type === ComponentType.TextInput ? submitted.value : undefined;
    // A box Discord sends back with nothing in it — a blank optional input — still has to appear, so
    // the record stays total over the fields the form declared.
    values[field.id] = typeof value === "string" ? value : "";
  }
  return values;
}

/** Acknowledge an interaction without changing anything, inside Discord's three-second window. Failing
 *  to ack only shows the clicker Discord's own "interaction failed" notice: by the time this runs the
 *  human has already answered, and an answer must never be lost to a cosmetic call (the at-most-once
 *  rule means nobody would learn it a second time). */
async function acknowledge(
  interaction: MessageComponentInteraction | ModalSubmitInteraction,
): Promise<void> {
  try {
    await interaction.deferUpdate();
  } catch {
    // Swallowed on purpose — see above.
  }
}

/** Take the controls away and leave @outcome@ in their place, so a late click has nothing to press.
 *  Every way a question ends comes through here — an answer, a failure, a cancel.
 *
 *  Edited over REST with the bot token rather than through the interaction: an interaction's token
 *  expires fifteen minutes after it was issued while a bot's edit never does, and a REST call outlives
 *  the gateway lease the ask is giving up. Best effort, so a cosmetic edit can neither lose a decision
 *  nor break a cancel. */
async function stripControls(
  rest: REST,
  channel: string,
  posted: string,
  prompt: string,
  outcome: string,
): Promise<void> {
  try {
    await rest.patch(Routes.channelMessage(channel, posted), {
      body: { content: `${prompt}\n→ ${outcome}`, components: [] },
    });
  } catch {
    // The stale controls stay; clicking one gets Discord's own "interaction failed" notice.
  }
}

/** The controls of one question, keyed by the id an interaction comes back carrying. Two controls
 *  sharing an id cannot be told apart on the way back — Discord returns the custom id and nothing else
 *  — so the first wins (matching declaration order) and the repeat is warned about rather than lost
 *  silently. It cannot be fixed here; `discord.check_controls` refuses the same list as a value, where
 *  the controls are built. */
function controlsById(controls: Control[]): Map<string, Control> {
  const byId = new Map<string, Control>();
  for (const control of controls) {
    if (byId.has(control.id)) {
      console.warn(
        `discord_ask: two controls share the id ${JSON.stringify(control.id)} — Discord carries back` +
          ` only the id, so the FIRST one keeps it and completing the later one would answer as the` +
          ` first. Check the controls with discord.check_controls where they are built.`,
      );
      continue;
    }
    byId.set(control.id, control);
  }
  return byId;
}

katari.agent<{ token: string; channel: string; prompt: string; controls: unknown[] }>(
  "discord_ask",
  async ({ token, channel, prompt, controls }, context) => {
    const rendered = controls.map(readControl);
    const rest = restFor(token);
    // The socket comes up BEFORE the question posts: Discord delivers an interaction only to a session
    // connected at the moment of the click, so a gateway opened after the post would miss an answer
    // nobody would give twice. It is released in the `finally` below, however this ends.
    const gateway = acquireGateway(token);
    try {
      let posted: string;
      try {
        await gateway.ready;
        posted = postedMessageId(
          await rest.post(Routes.channelMessages(channel), {
            body: { content: prompt, components: renderRows(rendered).map((row) => row.toJSON()) },
          }),
          "the question",
        );
      } catch (error) {
        // Rendering AND posting the question both sit inside this try, so neither a builder that refuses a
        // control (a load-bearing string out of range) nor the platform rejecting the payload (a 26th
        // dropdown option, a sixth row) can escape as anything but the declared `discord_error`, classified
        // and raised exactly as discord_send does. `renderRows` belongs in here rather than above it for
        // that reason: a builder's refusal is synchronous. A gateway that would not open is the same kind
        // of failure — a bad token is `auth_error` — and lands here for the same reason.
        katari.throw(new KatariData(discordErrorConstructor(error), { message: discordErrorMessage(error) }));
        // `katari.throw` never returns; the rethrow only satisfies definite assignment on `posted`.
        throw error;
      }
      // The wait: the FIRST COMPLETED interaction is the answer. No time limit — a decision may land hours
      // later; a runtime restart interrupts the external call under the at-most-once rule. Clicking is not
      // answering: opening a form's dialog and closing it again completes nothing, so the question stays
      // open for the next attempt.
      return await new Promise<KatariData<Record<string, unknown>>>((resolve, reject) => {
        const byId = controlsById(rendered);
        let settled = false;
        const cleanup = () => {
          gateway.questions.delete(posted);
        };
        /** Fail the ask with the declared `discord_error` (a `KatariThrowError` rejection becomes a typed
         *  `throw` reply, not a panic), so a Discord call that breaks the question is catchable at the call
         *  site rather than leaving it hanging on an answer that can no longer be given. */
        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          // The question is over either way, so its controls come off here too — same reason as the cancel
          // path: nothing is waiting behind them.
          void stripControls(rest, channel, posted, prompt, "(failed)");
          reject(
            new KatariThrowError(
              new KatariData(discordErrorConstructor(error), { message: discordErrorMessage(error) }),
            ),
          );
        };
        /** Settle the ask with the answer this interaction completed. Never rejects: everything after the
         *  answer is best effort, so `void`-ing a call cannot drop a failure. */
        const answerWith = async (
          interaction: MessageComponentInteraction | ModalSubmitInteraction,
          answer: KatariData<Record<string, unknown>>,
          completed: string,
        ): Promise<void> => {
          // A second interaction that lands in the same tick as the winner: acknowledge it so its clicker
          // is not left staring at a failure notice, and let the first answer stand.
          if (settled) {
            await acknowledge(interaction);
            return;
          }
          settled = true;
          cleanup();
          await acknowledge(interaction);
          // The answerer is rendered as a mention, not a raw snowflake: the channel's members are exactly
          // who may answer, so the channel is where a name is the readable form.
          await stripControls(rest, channel, posted, prompt, `${completed} (by <@${interaction.user.id}>)`);
          resolve(answer);
        };
        // One router per open question, fed by the gateway's single `InteractionCreate` listener: a
        // component press and the dialog submit that follows one both arrive here, so the two halves of a
        // `form` answer are read in one place.
        gateway.questions.set(posted, (interaction) => {
          if (interaction.isModalSubmit()) {
            if (!interaction.customId.startsWith(MODAL_ID_PREFIX)) return;
            const control = byId.get(interaction.customId.slice(MODAL_ID_PREFIX.length));
            if (control?.kind !== "form") return;
            void answerWith(
              interaction,
              new KatariData("discord.submitted", {
                id: control.id,
                values: submittedValues(interaction, control),
                by: interaction.user.id,
                display_name: displayNameOf(interactionNickname(interaction), interaction.user),
              }),
              control.label,
            );
            return;
          }
          const control = byId.get(interaction.customId);
          if (control === undefined) return;
          if (interaction.isStringSelectMenu()) {
            const option = interaction.values[0] ?? "";
            void answerWith(
              interaction,
              new KatariData("discord.chose", {
                id: control.id,
                option,
                by: interaction.user.id,
                display_name: displayNameOf(interactionNickname(interaction), interaction.user),
              }),
              option,
            );
            return;
          }
          if (!interaction.isButton()) return;
          if (control.kind === "form") {
            // The builders' validators throw synchronously, so the build must not sit as the argument of
            // `showModal` where no `.catch` is attached yet: a throw escaping this router callback settles
            // nothing and leaves the ask hanging. Built here, a refusal is `fail`ed as a typed `api_error`.
            let dialog: ModalBuilder;
            try {
              dialog = renderModal(control);
            } catch (error) {
              fail(error);
              return;
            }
            // Opening the dialog is this click's acknowledgement and has to land within three seconds.
            // A dialog Discord refuses fails the ask as `api_error`.
            void interaction.showModal(dialog).catch(fail);
            return;
          }
          void answerWith(
            interaction,
            new KatariData("discord.clicked", {
              id: control.id,
              by: interaction.user.id,
              display_name: displayNameOf(interactionNickname(interaction), interaction.user),
            }),
            control.label,
          );
        });
        // The runtime cancelled the call (a `time.with_deadline` expiry, a `region.cancel_by_id`, a
        // teardown). Since a deadline around `ask` is the recommended composition this is an ordinary
        // ending, so it settles as a plain cancellation and never as a typed `discord_error`.
        context.signal.addEventListener("abort", () => {
          if (settled) return;
          settled = true;
          cleanup();
          // Launched, not awaited: this listener is synchronous and a cancel must not wait on a cosmetic
          // edit. It rides the token's REST client rather than the gateway this call is about to release.
          void stripControls(rest, channel, posted, prompt, "(expired)");
          // The rejection the port expects from a handler unwinding on abort; a plain `Error` is reported
          // as "handler threw during cancellation" instead.
          reject(new KatariCancelledError());
        });
      });
    } finally {
      await releaseGateway(token, gateway);
    }
  },
);

katari.agent<{ token: string; channel: string; deliver_to: KatariAgent }>(
  "discord_watch",
  async ({ token, channel, deliver_to }, context) => {
    // Leased and registered in the same tick, before anything is awaited: the socket cannot deliver a
    // message this watch was not yet listening for.
    const gateway = acquireGateway(token);
    try {
      return await new Promise<never>((_resolve, reject) => {
        const watcher = (message: IncomingMessage) => {
          if (message.author.bot || message.channelId !== channel) return;
          // Deliver back into the runtime as an inner delegation; the callback's effects escalate
          // through this call to the app's handlers. Attachments download from the CDN and lift into
          // `file` values first (one that fails to download is dropped rather than failing the whole
          // message). A delivery failure tears the watch down (the app's panic clause reports it).
          void (async () => {
            // One `message` data value, bound to the callback's single parameter: the delivered shape is
            // named on both sides, so growing it later adds a field rather than shifting an argument —
            // and it is built by the same two helpers `discord_history` uses, so the stream and the gap
            // read deliver the same thing.
            await deliver_to.call({
              value: messageValue(message, await downloadAttachments(message, context)),
            });
          })().catch((error) => {
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        };
        const cleanup = () => gateway.watchers.delete(watcher);
        gateway.watchers.add(watcher);
        // A socket that never opens (a bad token, an unreachable API) fails the watch as the declared
        // `discord_error`, classified auth vs api exactly as a send is.
        gateway.ready.catch((error: unknown) => {
          cleanup();
          reject(
            new KatariThrowError(
              new KatariData(discordErrorConstructor(error), { message: discordErrorMessage(error) }),
            ),
          );
        });
        // The runtime cancelled the call (run cancel / teardown): stop listening and settle. Rejected with
        // the port's own `KatariCancelledError`, the type it expects from a handler unwinding on abort, so
        // the cancel is confirmed quietly instead of being reported as "handler threw during cancellation".
        // A delivery failure above stays an ordinary `Error` — that one IS a failure.
        context.signal.addEventListener("abort", () => {
          cleanup();
          reject(new KatariCancelledError());
        });
      });
    } finally {
      await releaseGateway(token, gateway);
    }
  },
);
