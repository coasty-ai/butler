/**
 * Addresses, links, numbers, handles and amounts: never invented. A host is
 * any dotted name with a letters-only last label, whatever its TLD (the same
 * shape speakable.ts reads out): a false match only turns a run into an
 * offer, or a tool call into a question, which is the safe direction. Shared
 * by the dialog's grounding (src/assistant/arbitrate.ts) and the tool
 * policy's (src/core/tool-policy.ts), so both read an entity the same way.
 */
export const ENTITY =
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+|https?:\/\/\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b\S*|(?<![\w@])@[a-z0-9_.]{2,}|[$€£¥]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:dollars|euros|pounds|usd|eur|gbp|bucks)\b|\b\d[\d\s().-]{6,}\d\b|\b\d{3,}\b/gi;
export function entityTokens(text: string): string[] {
  return [...text.matchAll(ENTITY)].map((m) => normalizeEntity(m[0]));
}
/** Phone numbers compare by their digits; everything else as written. */
const normalizeEntity = (value: string) => {
  const bare = value
    .toLowerCase()
    .trim()
    .replace(/[.,;:!?)]+$/, "");
  return /^[\d\s().+-]+$/.test(bare) ? bare.replace(/\D/g, "") : bare;
};
