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

/**
 * Reasoning models (Qwen3, DeepSeek-R1) spend most of their time and token
 * budget thinking before they answer. Several switches are sent, because each
 * server reads a different one and ignores the rest:
 *
 *   - `reasoning_effort: "none"` -- Ollama's OpenAI-compatible endpoint, which
 *     is the one this app calls. Measured on Ollama 0.40.5 with qwen3:8b: it
 *     turns thinking off there, and `think: false` and `/no_think` in the
 *     system prompt do not -- the model thought and returned no content.
 *   - `think: false` -- Ollama's native API.
 *   - `chat_template_kwargs` -- vLLM and SGLang.
 *   - `/no_think` in the prompt -- Qwen3's own soft switch elsewhere.
 */
export function isReasoningModel(model: string): boolean {
  return /qwen3|deepseek-r1|\br1\b|reason|thinking/i.test(model);
}

/** Request fields that switch thinking off, or nothing for other models. */
export function noThinkingFields(model: string): Record<string, unknown> {
  return isReasoningModel(model)
    ? { think: false, reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } }
    : {};
}

/** The system prompt, with Qwen3's soft switch appended for reasoning models. */
export function noThinkingPrompt(model: string, systemPrompt: string): string {
  return isReasoningModel(model) ? `${systemPrompt}\n\n/no_think` : systemPrompt;
}

export const __testing = { stripReasoning, cleanCompletion };
