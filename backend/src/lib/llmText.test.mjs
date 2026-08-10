import assert from 'node:assert/strict';
import test from 'node:test';
import { __testing } from './llmText.ts';

const { stripReasoning, cleanCompletion } = __testing;

/**
 * Qwen3 and other reasoning models answer with a <think> block first. Every
 * parser downstream (JSON object, JSON array, numbered list) reads the first
 * matching structure it finds, so a stray brace or numbered line inside the
 * reasoning silently becomes "the answer".
 */

test('removes a closed think block and keeps the answer', () => {
  const raw = '<think>Plan: emit {"a":1} maybe</think>{"overview":"Real answer"}';
  assert.equal(cleanCompletion(raw), '{"overview":"Real answer"}');
});

test('drops an unclosed think block left by hitting the token ceiling', () => {
  assert.equal(stripReasoning('<think>I should start by considering'), '');
});

test('numbered lines inside reasoning never reach the parser', () => {
  const raw = '<think>Maybe 1. Wrong Name</think>\n1. Anhui Museum\n2. People\'s Park';
  assert.equal(cleanCompletion(raw), "1. Anhui Museum\n2. People's Park");
});

test('strips markdown fences', () => {
  assert.equal(cleanCompletion('```json\n{"overview":"x"}\n```'), '{"overview":"x"}');
});

test('leaves ordinary output untouched', () => {
  const raw = '{"overview":"no reasoning at all"}';
  assert.equal(cleanCompletion(raw), raw);
});

test('handles a lone closing tag', () => {
  assert.equal(cleanCompletion('</think>{"a":1}'), '{"a":1}');
});

test('empty input is safe', () => {
  assert.equal(stripReasoning(''), '');
});
