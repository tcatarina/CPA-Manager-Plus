import type { ApiKeyEntry, OpenAIProviderConfig } from '@/types';
import type { GlmQuotaData } from '@/utils/quota/providerRequests';
import type { AccountRow } from './accountRows';
import type { AccountQuotaDisplayWindow } from './accountQuotaDisplayWindows';

export function buildConfiguredGlmAccount(
  provider: OpenAIProviderConfig,
  entry: ApiKeyEntry,
  quota?: GlmQuotaData,
  error?: string,
  observedAtMs?: number
): AccountRow {
  const percentages =
    quota?.rows
      .filter((window) => window.limit > 0)
      .map((window) => Math.max(0, Math.min(100, (window.remaining / window.limit) * 100))) ?? [];
  const remaining = percentages.length ? Math.min(...percentages) : null;
  const key = `config:${provider.name}:${entry.authIndex ?? ''}`;
  return {
    key,
    selectionKey: key,
    fileName: 'config.yaml',
    accountLabel: provider.name,
    provider: 'glm',
    planType: quota?.plan || null,
    disabled: provider.disabled === true,
    runtimeOnly: false,
    statusMessage: '',
    authIndex: entry.authIndex ?? '',
    projectId: '',
    priority: provider.priority ?? 0,
    createdAtMs: null,
    updatedAtMs: null,
    subscriptionUntilMs: null,
    authenticationAtMs: 0,
    rawCredentialStatusSuperseded: false,
    quota: {
      status: error
        ? 'error'
        : remaining === null
          ? 'unknown'
          : remaining === 0
            ? 'exhausted'
            : remaining < 20
              ? 'low'
              : 'ok',
      remainingPercent: remaining,
      usedPercent: remaining === null ? null : 100 - remaining,
      resetLabel: '-',
      resetAtMs: quota?.rows[0]?.resetAtMs ?? null,
      resetAccuracy: quota?.rows[0]?.resetAtMs ? 'exact' : 'unknown',
      planType: quota?.plan || null,
      source: quota ? 'cache' : 'none',
      error,
      fetchedAtMs: observedAtMs,
    },
    usage: { success: 0, failure: 0, successRate: null, recentRequests: [] },
    inspection: null,
    raw: {
      name: 'config.yaml',
      provider: 'glm',
      authIndex: entry.authIndex,
      disabled: provider.disabled,
      label: provider.name,
      credential_source: 'provider-config',
    },
  };
}

export function buildConfiguredGlmWindows(
  quota: GlmQuotaData | undefined,
  translate: (key: string) => string,
  observedAtMs?: number
): AccountQuotaDisplayWindow[] {
  return (
    quota?.rows.map((window, index) => ({
      key: `${window.id}-${index}`,
      label: window.labelKey ? translate(window.labelKey) : (window.label ?? window.id),
      kind: window.unit === 3 ? 'five_hour' : window.unit === 6 ? 'weekly' : 'unknown',
      remainingPercent:
        window.limit > 0
          ? Math.max(0, Math.min(100, (window.remaining / window.limit) * 100))
          : null,
      usedPercent:
        window.usedPercent ?? (window.limit > 0 ? (window.used / window.limit) * 100 : null),
      amountLabel: `${window.remaining.toLocaleString()} / ${window.limit.toLocaleString()}`,
      description: `${translate('glm_quota.used')}: ${window.used.toLocaleString()} / ${window.limit.toLocaleString()} · ${translate('accounts.detail_quota_remaining_label')}: ${window.remaining.toLocaleString()}`,
      resetLabel: '-',
      resetAtMs: window.resetAtMs ?? null,
      resetAccuracy: window.resetAtMs ? 'exact' : 'unknown',
      limitWindowSeconds: null,
      fromMs: null,
      toMs: null,
      windowMode: 'unknown',
      cycleEndMs: window.resetAtMs ?? null,
      source: 'glm',
      modelScope: { kind: 'all', complete: true },
      observationSource: 'api_query',
      observedAtMs: observedAtMs ?? null,
      quotaProgressObservedAtMs: observedAtMs ?? null,
    })) ?? []
  );
}
