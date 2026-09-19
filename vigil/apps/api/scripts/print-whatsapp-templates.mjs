/**
 * Print the WhatsApp templates for submission to Meta.
 *
 * They have to be registered before anything can be sent, and the body here
 * must match the body registered there EXACTLY or sends fail with a generic
 * mismatch error, hours later, with nothing useful in it. This script is the
 * single source: copy each one into Meta > WhatsApp Manager > Message
 * templates, category Utility, language English.
 */
import { WHATSAPP_TEMPLATES } from '../src/adapters/notifiers/templates.ts';

const entries = Object.entries(WHATSAPP_TEMPLATES);
console.log(`\n${entries.length} templates to register — Utility, English (en)\n`);
for (const [kind, t] of entries) {
  const vars = new Set(t.body.match(/\{\{\d+\}\}/g) ?? []).size;
  console.log('─'.repeat(72));
  console.log(`  ${kind}`);
  console.log(`  name:     ${t.name}`);
  console.log(`  category: ${t.category}`);
  console.log(`  ${vars} variable${vars === 1 ? '' : 's'}\n`);
  console.log(`${t.body}\n`);
}
console.log('─'.repeat(72));
console.log(`
Meta usually approves Utility templates in minutes. They work on a TEST phone
number straight away — no business verification needed — so you can send real
WhatsApp messages to up to five verified numbers today.

Note what this shape costs you: on WhatsApp the owner's own wording can only
fill a variable, never replace the message. Email and SMS carry their script
verbatim; WhatsApp cannot. That is Meta's rule, not ours.
`);
