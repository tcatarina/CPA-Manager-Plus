import { apiCallApi, type ApiCallResult } from '@/services/api/apiCall';
import { createScopedApiRequestConfig, type ApiClientRequestScope } from '@/services/api/client';
import { createCodexRedeemRequestId as createResetRequestId } from '@/services/api/codexQuota';
import { isRecord } from '@/utils/helpers';

const BASE = 'https://api.z.ai/api/biz/customer-package-reset';
export type GlmResetType = 'FIVE_HOUR' | 'WEEK';
export interface GlmResetCard {
  id: string;
  resetType: GlmResetType;
  expiresAtMs: number | null;
  title: string;
}
export interface GlmResetCardList {
  cards: GlmResetCard[];
  lastFiveHourResetAtMs: number | null;
  lastWeekResetAtMs: number | null;
}
export class GlmResetError extends Error {
  constructor(
    public readonly reason: 'auth' | 'response' | 'unavailable' | 'uncertain' | 'storage'
  ) {
    super(reason);
  }
}

export function parseGlmCardTimestamp(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = raw.trim();
  const naive = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  if (naive) {
    const [year, month, day, hour, minute, second] = naive.slice(1, 7).map(Number);
    const milliseconds = Number((naive[7] ?? '').padEnd(3, '0'));
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, milliseconds));
    return date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day &&
      date.getUTCHours() === hour &&
      date.getUTCMinutes() === minute &&
      date.getUTCSeconds() === second
      ? date.getTime()
      : null;
  }
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function validEnvelope(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.success === true && (value.code === 0 || value.code === 200);
}

function validateResponse(result: ApiCallResult): Record<string, unknown> {
  const payload = result.body;
  if (
    result.statusCode === 401 ||
    result.statusCode === 403 ||
    (isRecord(payload) && [401, 403, 1001].includes(Number(payload.code)))
  )
    throw new GlmResetError('auth');
  if (result.statusCode < 200 || result.statusCode >= 300 || !validEnvelope(payload)) {
    throw new GlmResetError('response');
  }
  return payload;
}

export function parseGlmResetCardList(value: unknown, now = Date.now()): GlmResetCardList {
  if (
    !validEnvelope(value) ||
    !isRecord(value.data) ||
    !Array.isArray(value.data.fiveHourResets) ||
    !Array.isArray(value.data.weekResets)
  ) {
    throw new GlmResetError('response');
  }
  const cards: GlmResetCard[] = [];
  const seen = new Set<string>();
  for (const [bucket, fallback] of [
    ['fiveHourResets', 'FIVE_HOUR'],
    ['weekResets', 'WEEK'],
  ] as const) {
    for (const item of value.data[bucket] as unknown[]) {
      if (!isRecord(item)) continue;
      const status = String(
        item.status ?? item.state ?? item.outcome ?? item.result ?? item.code ?? ''
      )
        .toLowerCase()
        .replace(/[^a-z]/g, '');
      if (
        ['consumed', 'redeeming', 'redeemed', 'used', 'expired', 'unavailable'].includes(status) ||
        item.available === false ||
        item.consumed === true ||
        item.redeemed === true
      )
        continue;
      const rawId = item.recordId ?? item.id ?? item.packageResetId ?? item.resetId;
      if (typeof rawId === 'number' && !Number.isSafeInteger(rawId)) continue;
      const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId).trim() : '';
      if (!id) continue;
      const rawType = item.resetType ?? item.type;
      const resetType = rawType === undefined ? fallback : String(rawType).toUpperCase();
      if (resetType !== 'FIVE_HOUR' && resetType !== 'WEEK') continue;
      const expiry = item.expireTime ?? item.expiredTime ?? item.expiresAt ?? item.endTime;
      const expiresAtMs = parseGlmCardTimestamp(expiry);
      if (expiry !== undefined && expiry !== null && expiry !== '' && expiresAtMs === null)
        continue;
      if (expiresAtMs !== null && expiresAtMs <= now) continue;
      const identity = `${resetType}:${id}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const title = item.packageName ?? item.name ?? item.title;
      cards.push({ id, resetType, expiresAtMs, title: typeof title === 'string' ? title : '' });
    }
  }
  cards.sort((a, b) => (a.expiresAtMs ?? Infinity) - (b.expiresAtMs ?? Infinity));
  return {
    cards,
    lastFiveHourResetAtMs: parseGlmCardTimestamp(value.data.lastFiveHourResetTime),
    lastWeekResetAtMs: parseGlmCardTimestamp(value.data.lastWeekResetTime),
  };
}

export async function listGlmResetCards(
  authIndex: string,
  scope: ApiClientRequestScope
): Promise<GlmResetCardList> {
  if (!authIndex.trim()) throw new GlmResetError('auth');
  const result = await apiCallApi.request(
    {
      authIndex,
      method: 'GET',
      url: `${BASE}/list?targetType=PERSONAL`,
      header: { Authorization: 'Bearer $TOKEN$', Accept: 'application/json' },
    },
    { ...createScopedApiRequestConfig(scope), timeout: 20000 }
  );
  return parseGlmResetCardList(validateResponse(result));
}

interface Attempt {
  requestId: string;
  committed: boolean;
  card: GlmResetCard;
  inFlight?: Promise<void>;
}
const attempts = new Map<string, Attempt>();
const operations = new Map<string, string>();
const storageKey = (scope: ApiClientRequestScope, authIndex: string, card: GlmResetCard) =>
  `cpamp-glm-reset:${JSON.stringify([scope.apiBase, authIndex, card.resetType, card.id])}`;

function restoreAttempt(key: string): Attempt | undefined {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (
      !isRecord(parsed) ||
      typeof parsed.requestId !== 'string' ||
      !parsed.requestId ||
      typeof parsed.committed !== 'boolean' ||
      !isRecord(parsed.card) ||
      typeof parsed.card.id !== 'string' ||
      !['FIVE_HOUR', 'WEEK'].includes(String(parsed.card.resetType))
    )
      throw new Error();
    return {
      requestId: parsed.requestId,
      committed: parsed.committed,
      card: parsed.card as unknown as GlmResetCard,
    };
  } catch {
    throw new GlmResetError('storage');
  }
}
function persistAttempt(key: string, attempt: Attempt) {
  try {
    sessionStorage.setItem(
      key,
      JSON.stringify({
        requestId: attempt.requestId,
        committed: attempt.committed,
        card: attempt.card,
      })
    );
  } catch {
    throw new GlmResetError('storage');
  }
}

export function getPendingGlmCards(
  authIndex: string,
  scope: ApiClientRequestScope
): GlmResetCard[] {
  const prefix = `cpamp-glm-reset:${JSON.stringify([scope.apiBase, authIndex]).slice(0, -1)},`;
  try {
    const result: GlmResetCard[] = [];
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const attempt = attempts.get(key) ?? restoreAttempt(key);
      if (attempt && !attempt.committed) result.push(attempt.card);
    }
    return result;
  } catch {
    throw new GlmResetError('storage');
  }
}

export function isGlmCardPending(
  authIndex: string,
  card: GlmResetCard,
  scope: ApiClientRequestScope
): boolean {
  const key = storageKey(scope, authIndex, card);
  const attempt = attempts.get(key) ?? restoreAttempt(key);
  return Boolean(attempt && !attempt.committed);
}

export async function redeemGlmResetCard(
  authIndex: string,
  card: GlmResetCard,
  scope: ApiClientRequestScope
): Promise<void> {
  if (!authIndex.trim()) throw new GlmResetError('auth');
  const key = storageKey(scope, authIndex, card);
  const accountKey = JSON.stringify([scope.apiBase, authIndex]);
  const current = attempts.get(key) ?? restoreAttempt(key);
  if (current?.committed) return;
  if (current?.inFlight) return current.inFlight;
  if (
    operations.has(accountKey) ||
    getPendingGlmCards(authIndex, scope).some(
      (item) => item.id !== card.id || item.resetType !== card.resetType
    )
  )
    throw new GlmResetError('uncertain');
  const attempt = current ?? { requestId: createResetRequestId(), committed: false, card };
  persistAttempt(key, attempt);
  attempts.set(key, attempt);
  operations.set(accountKey, key);
  const operation = (async () => {
    if (!current) {
      try {
        const list = await listGlmResetCards(authIndex, scope);
        if (!list.cards.some((item) => item.id === card.id && item.resetType === card.resetType)) {
          throw new GlmResetError('unavailable');
        }
      } catch (error) {
        attempts.delete(key);
        try {
          sessionStorage.removeItem(key);
        } catch {
          throw new GlmResetError('storage');
        }
        throw error;
      }
    }
    try {
      const numberId = Number(card.id);
      const result = await apiCallApi.request(
        {
          authIndex,
          method: 'POST',
          url: `${BASE}/use`,
          header: {
            Authorization: 'Bearer $TOKEN$',
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          data: JSON.stringify({
            targetType: 'PERSONAL',
            resetType: card.resetType,
            recordId:
              Number.isSafeInteger(numberId) && String(numberId) === card.id ? numberId : card.id,
            requestId: attempt.requestId,
          }),
        },
        { ...createScopedApiRequestConfig(scope), timeout: 20000 }
      );
      validateResponse(result);
      attempt.committed = true;
      try {
        persistAttempt(key, attempt);
      } catch {
        return;
      }
    } catch (error) {
      if (error instanceof GlmResetError && error.reason === 'auth') throw error;
      throw new GlmResetError('uncertain');
    }
  })();
  attempt.inFlight = operation;
  try {
    await operation;
  } finally {
    attempt.inFlight = undefined;
    operations.delete(accountKey);
  }
}
