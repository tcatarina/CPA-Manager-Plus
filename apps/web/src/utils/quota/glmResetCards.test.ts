import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/services/api/apiCall', () => ({ apiCallApi: { request: mocks.request } }));
vi.mock('@/services/api/codexQuota', () => ({
  createCodexRedeemRequestId: () => 'stable-request-id',
}));
import {
  getPendingGlmCards,
  listGlmResetCards,
  parseGlmCardTimestamp,
  parseGlmResetCardList,
  redeemGlmResetCard,
} from './glmResetCards';
const scope = { apiBase: 'http://local.example', managementKey: 'management' };
const envelope = (cards: unknown[] = [], weekly: unknown[] = []) => ({
  code: 200,
  success: true,
  data: { fiveHourResets: cards, weekResets: weekly },
});
const result = (body: unknown, statusCode = 200) => ({ statusCode, body });
let sequence = 0;
const account = () => `glm-${++sequence}`;
const card = { id: '123', resetType: 'FIVE_HOUR' as const, expiresAtMs: null, title: '' };
beforeEach(() => {
  mocks.request.mockReset();
  const data = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
    get length() {
      return data.size;
    },
    key: (index: number) => [...data.keys()][index] ?? null,
  });
});
describe('GLM reset cards', () => {
  it('requires complete successful envelopes; HTTP 200 is not enough', () => {
    for (const raw of [
      null,
      {},
      { code: 200 },
      { success: true, code: '200' },
      { success: true, code: 200, data: {} },
    ]) {
      expect(() => parseGlmResetCardList(raw)).toThrow('response');
    }
    expect(parseGlmResetCardList(envelope()).cards).toEqual([]);
  });
  it('filters used, expired and invalid-expiry cards, deduplicates and sorts by expiry', () => {
    const list = parseGlmResetCardList(
      envelope(
        [
          { recordId: 1, status: 'used' },
          { recordId: 2, available: false },
          { recordId: 3, expireTime: '2000-01-01 00:00:00' },
          { recordId: 4, expireTime: 'invalid' },
          { recordId: 5, expireTime: '2099-03-01 00:00:00' },
          { recordId: 5, expireTime: '2099-03-01 00:00:00' },
          { recordId: 6 },
        ],
        [{ recordId: 7, expireTime: '2099-02-01T00:00:00Z' }]
      )
    );
    expect(list.cards.map((item) => item.id)).toEqual(['7', '5', '6']);
    expect(list.cards[0].resetType).toBe('WEEK');
    expect(parseGlmCardTimestamp('2099-02-30 00:00:00')).toBeNull();
    expect(parseGlmCardTimestamp('2099-02-01 12:00:00')).toBe(Date.UTC(2099, 1, 1, 12));
  });
  it('lists using the selected auth index and server-side token substitution', async () => {
    mocks.request.mockResolvedValue(result(envelope()));
    await listGlmResetCards('chosen-key', scope);
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        authIndex: 'chosen-key',
        method: 'GET',
        header: expect.objectContaining({ Authorization: 'Bearer $TOKEN$' }),
      }),
      expect.objectContaining({ cpampScopedRequest: true })
    );
  });
  it('revalidates selected card then consumes exactly once with correct wire payload', async () => {
    const index = account();
    mocks.request
      .mockResolvedValueOnce(result(envelope([{ recordId: 123 }])))
      .mockResolvedValueOnce(result({ success: true, code: 200 }));
    await Promise.all([
      redeemGlmResetCard(index, card, scope),
      redeemGlmResetCard(index, card, scope),
    ]);
    await redeemGlmResetCard(index, card, scope);
    const writes = mocks.request.mock.calls.filter(([request]) => request.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0][0].data)).toEqual({
      targetType: 'PERSONAL',
      resetType: 'FIVE_HOUR',
      recordId: 123,
      requestId: 'stable-request-id',
    });
    expect(getPendingGlmCards(index, scope)).toEqual([]);
  });
  it('keeps exact same request ID and card after ambiguous transport failure', async () => {
    const index = account();
    mocks.request
      .mockResolvedValueOnce(result(envelope([{ recordId: 123 }])))
      .mockRejectedValueOnce(new Error('timeout'));
    await expect(redeemGlmResetCard(index, card, scope)).rejects.toThrow('uncertain');
    expect(getPendingGlmCards(index, scope)).toEqual([card]);
    await expect(redeemGlmResetCard(index, { ...card, id: '456' }, scope)).rejects.toThrow(
      'uncertain'
    );
    mocks.request.mockResolvedValueOnce(result({ success: true, code: 200 }));
    await redeemGlmResetCard(index, card, scope);
    const writes = mocks.request.mock.calls.filter(([request]) => request.method === 'POST');
    expect(writes).toHaveLength(2);
    expect(writes[0][0].data).toBe(writes[1][0].data);
  });
  it('does not consume unavailable cards or accept authentication errors as success', async () => {
    mocks.request.mockResolvedValue(result(envelope()));
    await expect(redeemGlmResetCard(account(), card, scope)).rejects.toThrow('unavailable');
    expect(mocks.request.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
    mocks.request.mockResolvedValue(result({ code: 1001, success: false }));
    await expect(listGlmResetCards(account(), scope)).rejects.toThrow('auth');
  });
  it('fails closed when session storage cannot persist idempotency binding', async () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('blocked');
      },
      get length() {
        return 0;
      },
    });
    await expect(redeemGlmResetCard(account(), card, scope)).rejects.toThrow('storage');
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('restores pending binding after module reload even if upstream no longer lists the card', async () => {
    const index = account();
    mocks.request
      .mockResolvedValueOnce(result(envelope([{ recordId: 123 }])))
      .mockRejectedValueOnce(new Error('timeout'));
    await expect(redeemGlmResetCard(index, card, scope)).rejects.toThrow('uncertain');
    vi.resetModules();
    const reloaded = await import('./glmResetCards');
    expect(reloaded.getPendingGlmCards(index, scope)).toEqual([card]);
    mocks.request.mockResolvedValueOnce(result({ code: 200, success: true }));
    await reloaded.redeemGlmResetCard(index, card, scope);
    expect(mocks.request.mock.calls.filter(([request]) => request.method === 'GET')).toHaveLength(
      1
    );
    expect(
      mocks.request.mock.calls
        .filter(([request]) => request.method === 'POST')
        .map(([request]) => JSON.parse(request.data).requestId)
    ).toEqual(['stable-request-id', 'stable-request-id']);
  });
});
