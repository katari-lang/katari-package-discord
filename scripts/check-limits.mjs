// Discord's caps are written down TWICE in this package, and this script is why that is allowed.
//
// `src/discord.ts` holds `LIMIT`, next to the render, because that is where a `@discordjs/builders`
// predicate refuses a string and where the clamping has to happen. `src/discord.ktr` holds
// `discord.limits()`, because a program that wants to check its own controls (`discord.check_controls`)
// or bound its own text (`string.fit(cap = discord.limits().message_text, …)`) must be able to do it
// PURELY — at the point the controls are built, with no gateway connection and no sidecar running.
// Publishing the numbers is what a platform package owes the prelude's general agents: `string.fit` can
// cut to any budget, but only this package knows what Discord's budget IS. Nothing in Katari can read a constant out of the TypeScript, so the numbers are
// duplicated; the alternative, an external agent that asks the sidecar, would turn reading a constant
// into an io call and make the check need the very connection it exists to run without.
//
// A duplicate is only honest if it cannot drift in silence. So: every key of the sidecar's `LIMIT` must
// appear in the map below, every field of the Katari `caps` value must appear in the map below or in
// `KATARI_ONLY`, and the paired numbers must be equal. Adding a cap on one side without the other fails
// here rather than months later, as a control that renders one way and checks another.
//
// Both files are read as TEXT rather than imported: importing the sidecar would pull in discord.js and
// register FFI handlers, and the Katari side is not JavaScript at all.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sidecarPath = join(packageRoot, "src", "discord.ts");
const katariPath = join(packageRoot, "src", "discord.ktr");

/** Katari `caps` field ← the sidecar expression that has to agree with it. A `LIMIT` key, or one of the
 *  two derived constants the sidecar computes rather than spells. */
const PAIRS = {
  button_label: "LIMIT.buttonLabel",
  select_label: "LIMIT.selectPlaceholder",
  select_option: "LIMIT.selectOption",
  form_title: "LIMIT.modalTitle",
  field_label: "LIMIT.fieldLabel",
  field_value: "LIMIT.textInputValue",
  control_id: "LIMIT.customId",
  form_id: "FORM_ID_LIMIT",
  buttons_per_row: "BUTTONS_PER_ROW",
};

/** Katari `caps` fields with no sidecar twin, and why each has none: these are limits DISCORD enforces on
 *  the assembled payload, which no local builder checks — the sidecar leaves them to the platform (see
 *  `renderRows`) and meets them as a 400. They are exactly what `check_controls` adds over what an `ask`
 *  can fail on locally, so they are listed rather than paired. */
const KATARI_ONLY = {
  message_text: "how many characters one message's content may carry — Discord's own cap on the ask's PROMPT and on a send's text, which no builder checks and `check_controls` cannot see (it is not a control). It is also the number a caller hands `string.fit` as its cap, now that the package's own `fit_message` has gone back to the prelude: publishing the number is what makes the prelude's general cut usable here",
  select_options: "how many options one dropdown may offer — Discord's own cap, checked by no builder",
  form_fields: "how many boxes one dialog may hold — Discord's own cap, checked by no builder",
  rows: "how many action rows one message may carry — Discord's own cap, checked by no builder",
};

const sidecar = readFileSync(sidecarPath, "utf8");
const katari = readFileSync(katariPath, "utf8");

const problems = [];

// ── the sidecar's numbers ────────────────────────────────────────────────────────────────────────

/** The body of `const LIMIT = { … };`, and every `key: number` in it. */
function sidecarLimits() {
  const block = sidecar.match(/const LIMIT = \{([\s\S]*?)\n\};/);
  if (block === null) {
    problems.push(`${sidecarPath}: no \`const LIMIT = { … };\` block — this script cannot check anything`);
    return {};
  }
  const values = {};
  for (const match of block[1].matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):\s*(\d+),/gm)) {
    values[`LIMIT.${match[1]}`] = Number(match[2]);
  }
  return values;
}

const sidecarValues = sidecarLimits();

/** `const BUTTONS_PER_ROW = 5;` and friends — a bare numeric module constant. */
function sidecarConstant(name) {
  const match = sidecar.match(new RegExp(`const ${name} = (\\d+);`));
  return match === null ? undefined : Number(match[1]);
}

const buttonsPerRow = sidecarConstant("BUTTONS_PER_ROW");
if (buttonsPerRow === undefined) {
  problems.push(`${sidecarPath}: no \`const BUTTONS_PER_ROW = <number>;\``);
} else {
  sidecarValues["BUTTONS_PER_ROW"] = buttonsPerRow;
}

// `FORM_ID_LIMIT` is DERIVED — `LIMIT.customId - MODAL_ID_PREFIX.length` — so it is recomputed here from
// its two parts rather than read, which also checks that the derivation still says what it says.
const modalPrefix = sidecar.match(/const MODAL_ID_PREFIX = "([^"]*)";/);
if (modalPrefix === null) {
  problems.push(`${sidecarPath}: no \`const MODAL_ID_PREFIX = "…";\``);
} else if (!/const FORM_ID_LIMIT = LIMIT\.customId - MODAL_ID_PREFIX\.length;/.test(sidecar)) {
  problems.push(
    `${sidecarPath}: FORM_ID_LIMIT is no longer \`LIMIT.customId - MODAL_ID_PREFIX.length\`;` +
      ` this script's arithmetic has to follow it`,
  );
} else if (sidecarValues["LIMIT.customId"] !== undefined) {
  sidecarValues["FORM_ID_LIMIT"] = sidecarValues["LIMIT.customId"] - modalPrefix[1].length;
}

// ── the Katari side's numbers ────────────────────────────────────────────────────────────────────

/** The body of `agent limits() -> caps { caps( … ) }`, and every `field = number,` in it. */
function katariLimits() {
  const block = katari.match(/agent limits\(\) -> caps \{\s*caps\(([\s\S]*?)\n\s*\)\n\}/);
  if (block === null) {
    problems.push(`${katariPath}: no \`agent limits() -> caps { caps( … ) }\` — this script cannot check anything`);
    return {};
  }
  const values = {};
  for (const match of block[1].matchAll(/^\s*([a-z][a-z0-9_]*) = (\d+),/gm)) {
    values[match[1]] = Number(match[2]);
  }
  return values;
}

const katariValues = katariLimits();

/** The `data caps( … )` declaration's field names — the published surface, which must be exactly what
 *  `limits()` fills in. A field declared and never assigned would not compile, but one assigned in a
 *  stale order or spelled differently in the two places would read as a missing pair below. */
function katariCapsFields() {
  const block = katari.match(/\ndata caps\(([\s\S]*?)\n\)\n/);
  if (block === null) {
    problems.push(`${katariPath}: no \`data caps( … )\` declaration`);
    return [];
  }
  return [...block[1].matchAll(/^\s*(?:@"[\s\S]*?"\s*)?([a-z][a-z0-9_]*): integer,/gm)].map((match) => match[1]);
}

const capsFields = katariCapsFields();

// ── the comparison ───────────────────────────────────────────────────────────────────────────────

for (const [field, expression] of Object.entries(PAIRS)) {
  const sidecarValue = sidecarValues[expression];
  const katariValue = katariValues[field];
  if (sidecarValue === undefined) {
    problems.push(`${sidecarPath}: \`${expression}\` is gone; \`caps.${field}\` is paired with it`);
  } else if (katariValue === undefined) {
    problems.push(`${katariPath}: \`limits()\` assigns no \`${field}\`; it is paired with \`${expression}\``);
  } else if (sidecarValue !== katariValue) {
    problems.push(
      `DRIFT: \`caps.${field}\` is ${katariValue} in ${katariPath}` +
        ` but \`${expression}\` is ${sidecarValue} in ${sidecarPath}`,
    );
  }
}

for (const expression of Object.keys(sidecarValues)) {
  if (!Object.values(PAIRS).includes(expression)) {
    problems.push(
      `${sidecarPath}: \`${expression}\` has no counterpart in \`discord.limits()\`.` +
        ` A cap the renderer enforces and Katari cannot read is a cap a program finds out about from a` +
        ` failed ask — publish it as a \`caps\` field, and pair it in this script's PAIRS.`,
    );
  }
}

for (const field of capsFields) {
  if (PAIRS[field] === undefined && KATARI_ONLY[field] === undefined) {
    problems.push(
      `${katariPath}: \`caps.${field}\` is neither paired with a sidecar constant nor listed in` +
        ` KATARI_ONLY. Decide which it is: a number the renderer also enforces (pair it) or one only the` +
        ` platform does (list it, with why).`,
    );
  }
}

for (const field of Object.keys(KATARI_ONLY)) {
  if (katariValues[field] === undefined) {
    problems.push(`${katariPath}: \`limits()\` assigns no \`${field}\`, which KATARI_ONLY still lists`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(
    `\n${problems.length} problem(s). Discord's caps are written down twice on purpose — once where the` +
      ` renderer enforces them, once where a program can read them — and this script is the only thing` +
      ` keeping the two copies the same number.`,
  );
  process.exit(1);
}

const paired = Object.keys(PAIRS).length;
const only = Object.keys(KATARI_ONLY).length;
console.log(
  `discord.limits() agrees with the sidecar: ${paired} paired cap(s), ${only} platform-only cap(s) published on top`,
);
