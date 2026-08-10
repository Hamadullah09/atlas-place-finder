/**
 * Normalises raw chat-completion text before anything tries to parse it.
 *
 * Reasoning models (Qwen3, DeepSeek-R1, and anything else with a thinking
 * mode) prepend a `<think>…</think>` block to their answer. Left in place it
 * defeats JSON extraction — the first `{` found belongs to the model musing
 * about the schema, not to the answer — and it poisons line-oriented parsing
 * such as the numbered list used for name translation.
 */

const THINK_BLOCK = /<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi;
/** A block left unclosed because generation hit the token ceiling mid-thought. */
const UNCLOSED_THINK = /<(think|thinking|reasoning)>[\s\S]*$/i;

export function stripReasoning(raw: string): string {
  if (!raw) return '';

  let text = raw.replace(THINK_BLOCK, ' ');

  // An unclosed block means everything after it is reasoning, never an answer.
  if (UNCLOSED_THINK.test(text)) text = text.replace(UNCLOSED_THINK, ' ');

  // Some builds emit the closing tag alone when thinking is disabled server-side.
  text = text.replace(/<\/?(think|thinking|reasoning)>/gi, ' ');

  return text.trim();
}

/** Convenience: reasoning stripped and markdown fences removed. */
export function cleanCompletion(raw: string): string {
  return stripReasoning(raw).replace(/```(?:json|jsonc)?/gi, '').trim();
}

export const __testing = { stripReasoning, cleanCompletion };
