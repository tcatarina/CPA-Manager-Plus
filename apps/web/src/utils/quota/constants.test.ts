import { describe, expect, it } from 'vitest';

import {
  XAI_GROK_CLIENT_VERSION,
  XAI_GROK_USER_AGENT,
  XAI_INFERENCE_USER_AGENT,
} from './constants';

const versionAtLeast = (version: string, floor: string): boolean => {
  const actual = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const required = floor.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(actual.length, required.length);

  for (let index = 0; index < length; index += 1) {
    const actualPart = actual[index] ?? 0;
    const requiredPart = required[index] ?? 0;
    if (actualPart !== requiredPart) return actualPart > requiredPart;
  }

  return true;
};

describe('xAI Grok client identity', () => {
  it('meets the known xAI chat-proxy minimum Grok CLI version', () => {
    expect(versionAtLeast(XAI_GROK_CLIENT_VERSION, '1.0.13')).toBe(true);
  });

  it('keeps Grok user agents synchronized with the client version', () => {
    expect(XAI_GROK_USER_AGENT).toContain(`grok-pager/${XAI_GROK_CLIENT_VERSION}`);
    expect(XAI_GROK_USER_AGENT).toContain(`grok-shell/${XAI_GROK_CLIENT_VERSION}`);
    expect(XAI_INFERENCE_USER_AGENT).toBe(`xai-grok-workspace/${XAI_GROK_CLIENT_VERSION}`);
  });
});
