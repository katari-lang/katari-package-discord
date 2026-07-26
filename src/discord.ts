// The sidecar half of `discord.ktr` — the discord.js gateway client. Handlers register under this
// file's module path (`discord.*`). Clients live in a module-level map for the sidecar process's
// lifetime (one process per snapshot), keyed by the opaque handle Katari carries around.
//
// Files cross in both directions: an outgoing message's `file` values download over the blob side
// channel and attach to the Discord post; an incoming message's attachments download from Discord's
// CDN and upload over the same side channel, so the delivered message carries real `file` values.
//
// `discord_ask` is where Discord's physics show through: a message may carry buttons and dropdowns but
// NO text input, and text input exists only in a modal dialog, which the platform opens only in reply
// to a click. So a katari `form` control renders as a button that opens the dialog — two Discord steps
// behind one katari answer.

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
  type Message,
  type MessageActionRowComponentBuilder,
  type MessageComponentInteraction,
  ModalBuilder,
  type ModalSubmitInteraction,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

const clients = new Map<string, Client>();
let nextHandle = 1;

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
 *  (a transport fault, an unsendable-channel guard) defaults to `api_error`. */
function discordErrorConstructor(error: unknown): string {
  const status = property(error, "status");
  return status === 401 || status === 403 ? "discord.auth_error" : "discord.api_error";
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
  // The dialog routing table dies with the client it routed for; its listener goes with `destroy`.
  modalWaiters.delete(connection);
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
      const posted = await target.send({
        // Discord rejects an empty content string; with attachments the text is optional.
        ...(text === "" ? {} : { content: text }),
        ...(attachments.length > 0 ? { files: attachments } : {}),
      });
      // The posted message's id — the seam a later edit / reaction / thread reply addresses.
      return posted.id;
    } catch (error) {
      // Raise the execution failure as the declared `prelude.throw[discord_error]`, classified auth vs
      // api by HTTP status (qualified constructor name — the boundary checks the tag against the schema
      // const), so the caller can catch it instead of the run panicking.
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
 *  throw (a panic), like an unknown client handle. */
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

/** What `@discordjs/builders` refuses, read off the predicates in its `dist/index.js` (1.14.1) rather
 *  than recalled: every string this package renders goes through an `s.string()` with a maximum, and all
 *  but the two noted below also demand at least ONE character — so a BLANK string is as fatal as a long
 *  one. The numbers live here, next to the render, because a builder that refuses throws where the throw
 *  can leave the interaction handler entirely, and nothing about a caption should be able to decide
 *  whether a run survives. */
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

/** Take the controls away and leave @outcome@ in their place, so the channel keeps a readable record and
 *  a late click has nothing to press. EVERY way a question ends comes through here — an answer, and a
 *  cancel — because a question that has stopped mattering must stop looking answerable: live controls on
 *  a dead ask offer nothing but the platform's bare "interaction failed".
 *
 *  Edited with the BOT token rather than through the interaction, because an interaction's token expires
 *  fifteen minutes after it was issued while a bot's edit never does — and a dialog may be submitted long
 *  after the click that opened it, while a cancel arrives with no interaction in hand at all.
 *
 *  Best effort, for the same reason `acknowledge` is: on the answer path a decision must not be lost to a
 *  cosmetic edit, and on the cancel path a cosmetic edit must not break the cancel. */
async function stripControls(posted: Message, prompt: string, outcome: string): Promise<void> {
  try {
    await posted.edit({ content: `${prompt}\n→ ${outcome}`, components: [] });
  } catch {
    // The stale controls stay; clicking one gets Discord's own "interaction failed" notice.
  }
}

/** Called with each dialog submit that arrived for one open question. */
type ModalWaiter = (interaction: ModalSubmitInteraction) => void;

/** The open questions waiting on a dialog submit, per client, keyed by the id of the message whose
 *  button opened the dialog.
 *
 *  A submit is a FRESH interaction with its own token — which is why waiting for it is unbounded — and
 *  it arrives on the CLIENT rather than on the message's component collector, so it has to be routed.
 *  Routing by the submit's originating message id is exact: two questions open in the same channel, even
 *  offering the same form id, cannot cross. One shared listener per client does the fan-out, so a bot
 *  holding dozens of open questions still installs exactly one (Node warns past ten on an emitter). */
const modalWaiters = new Map<Client, Map<string, ModalWaiter>>();

function modalWaitersOf(client: Client): Map<string, ModalWaiter> {
  const existing = modalWaiters.get(client);
  if (existing !== undefined) return existing;
  const waiters = new Map<string, ModalWaiter>();
  modalWaiters.set(client, waiters);
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isModalSubmit()) return;
    const originating = interaction.message?.id;
    if (originating === undefined) return;
    waiters.get(originating)?.(interaction);
  });
  return waiters;
}

katari.agent<{ client: string; channel: string; prompt: string; controls: unknown[] }>(
  "discord_ask",
  async ({ client, channel, prompt, controls }, context) => {
    const connection = connectionOf(client);
    const rendered = controls.map(readControl);
    let posted: Message;
    try {
      const target = await connection.channels.fetch(channel);
      if (target === null || !target.isSendable()) {
        throw new Error(`channel ${channel} is not a sendable text channel`);
      }
      posted = await target.send({ content: prompt, components: renderRows(rendered) });
    } catch (error) {
      // Rendering AND posting the question both sit inside this try, so neither a builder that refuses a
      // control (a load-bearing string out of range) nor the platform rejecting the payload (a 26th
      // dropdown option, a sixth row) can escape as anything but the declared `discord_error`, classified
      // and raised exactly as discord_send does. `renderRows` belongs in here rather than above it for
      // that reason: a builder's refusal is synchronous.
      katari.throw(new KatariData(discordErrorConstructor(error), { message: discordErrorMessage(error) }));
      // `katari.throw` never returns; the rethrow only satisfies definite assignment on `posted`.
      throw error;
    }
    // The wait: the FIRST COMPLETED interaction is the answer. No time limit — a decision may land hours
    // later; a runtime restart interrupts the external call under the at-most-once rule. The collector
    // deliberately takes no `max`, because clicking is not answering: opening a form's dialog and closing
    // it again completes nothing, so the question has to stay open for the next attempt.
    return new Promise<KatariData<Record<string, unknown>>>((resolve, reject) => {
      const byId = new Map(rendered.map((control) => [control.id, control]));
      const waiters = modalWaitersOf(connection);
      const collector = posted.createMessageComponentCollector();
      let settled = false;
      const cleanup = () => {
        collector.stop();
        waiters.delete(posted.id);
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
        void stripControls(posted, prompt, "(failed)");
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
        await stripControls(posted, prompt, `${completed} (by <@${interaction.user.id}>)`);
        resolve(answer);
      };
      waiters.set(posted.id, (interaction) => {
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
      });
      collector.on("collect", (interaction: MessageComponentInteraction) => {
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
          // BUILDING the dialog runs `@discordjs/builders`' validators, and a builder that refuses throws
          // SYNCHRONOUSLY — so the build must not sit as the argument of `showModal`, where no `.catch` is
          // attached yet: the throw would leave this collector callback, and a throw that escapes an event
          // handler settles nothing (the click does nothing, the controls stay live, the ask hangs) and on
          // a sidecar without the port's process guard kills the process, failing every in-flight call as
          // an uncatchable panic. Built here instead, a refusal is `fail`ed as the typed `api_error` a
          // broken question is documented to become — including the refusals this package does not
          // enumerate, a future discord.js check or a component count past a platform limit.
          let dialog: ModalBuilder;
          try {
            dialog = renderModal(control);
          } catch (error) {
            fail(error);
            return;
          }
          // Opening the dialog IS this click's acknowledgement, and it has to land within three seconds
          // — the collector fires as the click arrives, so there is time. A dialog Discord itself refuses
          // is the platform rejecting the payload: fail the ask as `api_error` rather than leave it
          // waiting on an answer that this control can no longer deliver.
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
      // The runtime cancelled the call — a `time.with_deadline` expiry, a `region.cancel_by_id`, a run
      // teardown. Since `ask` carries no timeout of its own, a deadline around it is the RECOMMENDED
      // composition, which makes this the ordinary way a question ends: not a failure, so it settles as a
      // plain cancellation and never as a typed `discord_error` — there is nothing here for the program to
      // catch. The controls still come off, because a question nobody is waiting on any more must stop
      // looking answerable.
      context.signal.addEventListener("abort", () => {
        if (settled) return;
        settled = true;
        cleanup();
        // Launched, not awaited: this listener is synchronous, and a cancel must not wait on a cosmetic
        // edit (nor break on one — `stripControls` swallows its own failure). The cancel settles now and
        // the edit lands when Discord answers it.
        void stripControls(posted, prompt, "(expired)");
        // `KatariCancelledError` is the rejection the port expects from a handler unwinding on abort, and
        // it confirms the cancel QUIETLY. A plain `Error` is confirmed too, but reported as "handler threw
        // during cancellation" — which, since a deadline around `ask` is the recommended composition,
        // would print a phantom diagnostic every time a question simply expired.
        reject(new KatariCancelledError());
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
        author: { bot: boolean; id: string; globalName: string | null; username: string };
        // `Message.member` is the guild member the author is in the channel's server, and null in a DM
        // — where there is no server to hold a nickname. The chain below is total without it.
        member: { nickname: string | null } | null;
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
          // One `message` data value, bound to the callback's single parameter: the delivered shape is
          // named on both sides, so growing it later adds a field rather than shifting an argument.
          await deliver_to.call({
            message: new KatariData("discord.message", {
              channel: message.channelId,
              // The raw snowflake; the Katari side decides whether and how to hash it before it
              // leaves the program.
              author: message.author.id,
              // The name beside the id, so an app CAN address a sender rather than only correlate
              // them. Carried, never judged: whether a self-chosen name may cross to an AI provider
              // is the app's call, and the type's doc is where it is told the name identifies nobody.
              display_name: displayNameOf(message.member?.nickname ?? null, message.author),
              text: message.content,
              files,
            }),
          });
        })().catch((error) => {
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      };
      const cleanup = () => connection.off(Events.MessageCreate, listener);
      connection.on(Events.MessageCreate, listener);
      // The runtime cancelled the call (run cancel / teardown): stop listening and settle. Rejected with
      // the port's own `KatariCancelledError`, the type it expects from a handler unwinding on abort, so
      // the cancel is confirmed quietly instead of being reported as "handler threw during cancellation".
      // A delivery failure above stays an ordinary `Error` — that one IS a failure.
      context.signal.addEventListener("abort", () => {
        cleanup();
        reject(new KatariCancelledError());
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
