import { describe, expect, it } from 'vitest';
import {
  buildConfiguredGlmAccount,
  buildConfiguredGlmWindows,
} from '@/features/accounts/model/configuredGlmAccount';
import { parseGlmQuotaPayload } from '@/utils/quota/providerRequests';

describe('configured GLM account', () => {
  it('uses selected runtime credential without pretending it is an auth file', () => {
    const provider = {
      name: 'glm',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      apiKeyEntries: [{ apiKey: 'test', authIndex: 'first' }],
    };
    const data = {
      plan: 'pro',
      quotaInventoryObserved: true,
      rows: [{ id: '5h', unit: 3, used: 25, remaining: 75, limit: 100, resetAtMs: 1790725385323 }],
    };
    const first = buildConfiguredGlmAccount(provider, provider.apiKeyEntries[0], data);
    const second = buildConfiguredGlmAccount(
      provider,
      { apiKey: 'other', authIndex: 'second' },
      data
    );
    expect(first.selectionKey).not.toBe(second.selectionKey);
    expect(first.planType).toBe('pro');
    expect(first.raw).not.toHaveProperty('apiKey');
    expect(first.raw.credential_source).toBe('provider-config');
    const windows = buildConfiguredGlmWindows(data, (key) => key);
    expect(windows[0].remainingPercent).toBe(75);
    expect(windows[0].cycleStartMs).toBeUndefined();
    expect(windows[0].kind).toBe('five_hour');
    expect(windows[0].modelScope).toEqual({ kind: 'all', complete: true });
    expect(buildConfiguredGlmWindows(data, (key) => key, 1790725300000)[0].quotaProgressObservedAtMs).toBe(1790725300000);
  });
  it('rejects fake zero quota and normalizes reset strings', () => {
    expect(parseGlmQuotaPayload({ success: true, data: { limits: [{}] } })).toBeNull();
    const payload = parseGlmQuotaPayload({
      success: true,
      data: {
        limits: [{ usage: 100, currentValue: 0, remaining: 100, nextResetTime: '1790725385323' }],
      },
    });
    expect(payload?.rows[0].resetAtMs).toBe(1790725385323);
  });
});
