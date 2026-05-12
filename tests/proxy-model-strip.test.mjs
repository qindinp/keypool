/**
 * Tests for proxy model prefix stripping
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { stripModelPrefix } from '../src/gateway/proxy.mjs';

describe('stripModelPrefix', () => {
  it('strips xiaomi/ prefix', () => {
    assert.equal(stripModelPrefix('xiaomi/mimo-v2.5-pro'), 'mimo-v2.5-pro');
  });

  it('strips openai/ prefix', () => {
    assert.equal(stripModelPrefix('openai/gpt-4'), 'gpt-4');
  });

  it('strips microsoft/ prefix', () => {
    assert.equal(stripModelPrefix('microsoft/phi-4'), 'phi-4');
  });

  it('strips google/ prefix', () => {
    assert.equal(stripModelPrefix('google/gemini-pro'), 'gemini-pro');
  });

  it('strips anthropic/ prefix', () => {
    assert.equal(stripModelPrefix('anthropic/claude-3'), 'claude-3');
  });

  it('leaves unprefixed model unchanged', () => {
    assert.equal(stripModelPrefix('mimo-v2.5-pro'), 'mimo-v2.5-pro');
  });

  it('leaves mimo-v2-flash unchanged', () => {
    assert.equal(stripModelPrefix('mimo-v2-flash'), 'mimo-v2-flash');
  });

  it('returns null for null', () => {
    assert.equal(stripModelPrefix(null), null);
  });

  it('returns undefined for undefined', () => {
    assert.equal(stripModelPrefix(undefined), undefined);
  });

  it('does not strip unknown prefix', () => {
    assert.equal(stripModelPrefix('custom/my-model'), 'custom/my-model');
  });
});
