import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { DropdownMenu } from '@/components/ui/DropdownMenu';
import { IconKey, IconMoreVertical } from '@/components/ui/icons';
import { useAuthStore } from '@/stores/useAuthStore';
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
import { usePanelFeatureAvailability } from '@/hooks/usePanelFeatureAvailability';
import { fetchGlmQuota, type GlmQuotaData } from '@/utils/quota/providerRequests';
import { maskApiKey } from '@/utils/format';
import {
  normalizeRecentRequestUsageEntry,
  buildRecentRequestCompositeKey,
} from '@/utils/recentRequests';
import { apiClient, createScopedApiRequestConfig } from '@/services/api/client';
import { apiCallApi } from '@/services/api/apiCall';
import { providersApi } from '@/services/api/providers';
import { normalizeModelList } from '@/utils/models';
import { buildOpenAIModelsEndpoint } from '@/components/providers/utils';
import {
  monitoringAnalyticsApi,
  accountQuotaSnapshotApi,
  type MonitoringAccountHistoryItem,
  type MonitoringAnalyticsResponse,
  type MonitoringAccountWindowUsageItem,
  type AccountQuotaSnapshotWindow,
} from '@/services/api/usageService';
import type { ApiKeyEntry, ModelAlias, OpenAIProviderConfig } from '@/types';
import { useConfiguredCredentialEditor } from '../../hooks/useConfiguredCredentialEditor';
import {
  buildConfiguredGlmAccount,
  buildConfiguredGlmWindows,
} from '../../model/configuredGlmAccount';
import { buildAccountDetailViewModel } from '../../model/accountDetailViewModel';
import { buildAccountQuotaWindowDefinitions } from '../../model/accountQuotaWindowDefinitions';
import {
  buildAccountQuotaSnapshotWriteEntries,
  mergeAccountQuotaSnapshotWindows,
} from '../../model/accountQuotaSnapshots';
import {
  buildAccountWindowUsageTargetEntries,
  buildAccountWindowUsageByKey,
} from '../../model/accountWindowUsageRows';
import { AccountDetailDrawer, type AccountDetailTab } from './AccountDetailDrawer';
import { buildUsageValueRowFromMonitoringSummary } from '../../model/usageValueRows';
import { AccountOverviewTab } from './AccountOverviewTab';
import { AccountQuotaTab } from './AccountQuotaTab';
import { GlmResetCards } from './GlmResetCards';
import { AccountConfigurationTab } from './AccountConfigurationTab';
import { AccountModelsTab } from './AccountModelsTab';
import { AccountDiagnosticsTab } from './AccountDiagnosticsTab';
import styles from '../../AccountsPage.module.scss';

export function ConfiguredGlmDetail({
  provider,
  entry,
  onClose,
  onSaved,
  credentialPicker,
  initialTab = 'overview',
  onTabChanged,
  disableControls = false,
}: {
  provider: OpenAIProviderConfig;
  entry: ApiKeyEntry;
  onClose: () => void;
  onSaved: (provider: OpenAIProviderConfig) => void;
  credentialPicker?: (canSwitch: () => boolean) => React.ReactNode;
  initialTab?: AccountDetailTab;
  onTabChanged?: (tab: AccountDetailTab) => void;
  disableControls?: boolean;
}) {
  const { t } = useTranslation();
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const scope = useMemo(() => ({ apiBase, managementKey }), [apiBase, managementKey]);
  const availability = usePanelFeatureAvailability();
  const config = useConfiguredCredentialEditor(provider, entry, scope, onSaved);
  const [tab, setTab] = useState<AccountDetailTab>(initialTab);
  const [refresh, setRefresh] = useState(0);
  const [quota, setQuota] = useState<{
    key: string;
    data?: GlmQuotaData;
    error?: string;
    observedAtMs: number;
  }>();
  const [recent, setRecent] = useState<ReturnType<typeof normalizeRecentRequestUsageEntry>>();
  const [modelDraft, setModelDraft] = useState<ModelAlias[]>();
  const [discovered, setDiscovered] = useState<{ id: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelError, setModelError] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [modelSaving, setModelSaving] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [history, setHistory] = useState<MonitoringAccountHistoryItem>();
  const [analytics, setAnalytics] = useState<MonitoringAnalyticsResponse>();
  const [windowUsage, setWindowUsage] = useState<Map<string, MonitoringAccountWindowUsageItem>>(
    new Map()
  );
  const [snapshots, setSnapshots] = useState<AccountQuotaSnapshotWindow[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const [before, setBefore] = useState<{ ms: number | null; id: number | null }>();
  const drawerBody = useRef<HTMLDivElement>(null);
  const setActiveTab = (value: AccountDetailTab) => {
    setTab(value);
    onTabChanged?.(value);
    drawerBody.current?.scrollTo({ top: 0 });
  };
  const key = JSON.stringify([
    apiBase,
    managementKey,
    config.entry.authIndex,
    config.reloadGeneration,
    refresh,
  ]);
  const currentQuota = quota?.key === key ? quota : undefined;
  const row = useMemo(() => {
    const account = buildConfiguredGlmAccount(
      config.provider,
      config.entry,
      currentQuota?.data,
      currentQuota?.error,
      currentQuota?.observedAtMs
    );
    if (recent)
      account.usage = {
        success: recent.success,
        failure: recent.failed,
        successRate:
          recent.success + recent.failed
            ? (recent.success / (recent.success + recent.failed)) * 100
            : null,
        recentRequests: recent.recentRequests,
      };
    return account;
  }, [config.provider, config.entry, currentQuota, recent]);
  const windows = useMemo(
    () => buildConfiguredGlmWindows(currentQuota?.data, t, currentQuota?.observedAtMs),
    [currentQuota, t]
  );
  const configuredModels = modelDraft ?? config.provider.models ?? [];
  const dirtyModels =
    modelDraft !== undefined &&
    JSON.stringify(modelDraft) !== JSON.stringify(config.provider.models ?? []);
  const dirty = config.editor.dirty || dirtyModels;
  const busy = resetBusy || modelSaving || config.editor.state?.saving === true;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);
  useUnsavedChangesGuard({
    shouldBlock: dirty || busy,
    dialog: {
      title: t('accounts.config_unsaved'),
      message: t('glm_quota.discard'),
      confirmText: t('common.confirm'),
      cancelText: t('common.cancel'),
    },
    onConfirmNavigation: () => !busy,
  });
  const confirmDiscard = () =>
    !busy && (!dirty || (typeof window !== 'undefined' && window.confirm(t('glm_quota.discard'))));
  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value);
  };

  useEffect(() => {
    let active = true;
    fetchGlmQuota({ name: provider.name, authIndex: config.entry.authIndex }, t, scope)
      .then((data) => {
        if (active) setQuota({ key, data, observedAtMs: Date.now() });
      })
      .catch((cause) => {
        if (active)
          setQuota({
            key,
            error: cause instanceof Error ? cause.message : t('common.unknown_error'),
            observedAtMs: Date.now(),
          });
      });
    return () => {
      active = false;
    };
  }, [key, provider.name, config.entry.authIndex, scope, t]);

  useEffect(() => {
    if (!availability.requestMonitoringAvailable || !currentQuota?.data) return;
    const windows = buildConfiguredGlmWindows(currentQuota.data, t, currentQuota.observedAtMs);
    const definitions = buildAccountQuotaWindowDefinitions(windows);
    const records = buildAccountQuotaSnapshotWriteEntries(
      [row],
      new Map([[row.selectionKey, definitions]]),
      {
        getObservation: () => ({
          source: 'api_query',
          observed_at_ms: currentQuota.observedAtMs,
          inventory_scope_key: 'glm-allowance',
          inventory_mode: 'complete',
        }),
      }
    );
    let active = true;
    void accountQuotaSnapshotApi
      .write(availability.managerServiceBase, managementKey, records)
      .then(() =>
        accountQuotaSnapshotApi.query(availability.managerServiceBase, managementKey, [
          { row_key: row.selectionKey, provider: 'glm', account: { auth_index: row.authIndex } },
        ])
      )
      .then(async (response) => {
        const saved =
          response.items.find((item) => item.row_key === row.selectionKey)?.windows ?? [];
        const merged = mergeAccountQuotaSnapshotWindows(definitions, saved, { provider: 'glm' });
        const targets = buildAccountWindowUsageTargetEntries(
          [row],
          new Map([[row.selectionKey, merged]])
        ).map((item) => ({
          ...item,
          target: {
            ...item.target,
            auth_provider_snapshot: `openai-compatibility-${provider.name.toLowerCase()}`,
          },
        }));
        const usages = targets.length
          ? await monitoringAnalyticsApi.getAccountWindowUsage(
              availability.managerServiceBase,
              managementKey,
              { windows: targets.map((item) => item.target) }
            )
          : undefined;
        if (active) {
          setSnapshots(saved);
          setWindowUsage(usages ? buildAccountWindowUsageByKey(targets, usages.items) : new Map());
        }
      })
      .catch((cause) => {
        if (active)
          setHistoryError(cause instanceof Error ? cause.message : t('common.unknown_error'));
      });
    return () => {
      active = false;
    };
  }, [
    availability.requestMonitoringAvailable,
    availability.managerServiceBase,
    currentQuota,
    key,
    managementKey,
    row,
    provider.name,
    historyRefresh,
    t,
  ]);

  useEffect(() => {
    let active = true;
    void apiClient
      .get<Record<string, Record<string, unknown>>>(
        '/api-key-usage',
        createScopedApiRequestConfig(scope)
      )
      .then((response) => {
        const entries = response[config.provider.name];
        const usage =
          entries?.[config.entry.authIndex ?? ''] ??
          entries?.[buildRecentRequestCompositeKey(config.provider.baseUrl, config.entry.apiKey)];
        if (active) setRecent(normalizeRecentRequestUsageEntry(usage));
      })
      .catch(() => {
        return;
      });
    return () => {
      active = false;
    };
  }, [
    scope,
    config.provider.name,
    config.provider.baseUrl,
    config.entry.authIndex,
    config.entry.apiKey,
    refresh,
    historyRefresh,
  ]);

  const discoveryGeneration = useRef(0);
  useEffect(
    () => () => {
      discoveryGeneration.current += 1;
    },
    []
  );
  const discover = useCallback(async () => {
    const version = ++discoveryGeneration.current;
    setModelsLoading(true);
    setModelError(false);
    try {
      if (!config.entry.authIndex) throw new Error('Missing auth index');
      const response = await apiCallApi.request(
        {
          authIndex: config.entry.authIndex,
          method: 'GET',
          url: buildOpenAIModelsEndpoint(config.provider.baseUrl),
          header: { ...config.provider.headers, Authorization: 'Bearer $TOKEN$' },
        },
        createScopedApiRequestConfig(scope)
      );
      if (response.statusCode < 200 || response.statusCode >= 300)
        throw new Error(`HTTP ${response.statusCode}`);
      if (version === discoveryGeneration.current)
        setDiscovered(
          normalizeModelList(response.body ?? response.bodyText, { dedupe: true }).map((model) => ({
            id: model.name,
          }))
        );
    } catch {
      if (version === discoveryGeneration.current) setModelError(true);
    } finally {
      if (version === discoveryGeneration.current) setModelsLoading(false);
    }
  }, [config.entry.authIndex, config.provider.baseUrl, config.provider.headers, scope]);

  useEffect(() => {
    if (!availability.requestMonitoringAvailable || !config.entry.authIndex) return;
    let active = true;
    const target = { row_key: row.selectionKey, auth_index: config.entry.authIndex };
    const now = Date.now();
    Promise.all([
      monitoringAnalyticsApi.getAccountHistory(availability.managerServiceBase, managementKey, {
        accounts: [target],
      }),
      monitoringAnalyticsApi.getAnalytics(availability.managerServiceBase, managementKey, {
        from_ms: now - 7 * 86400000,
        to_ms: now,
        filters: { auth_indices: [config.entry.authIndex] },
        include: {
          summary: true,
          recent_failures: 1,
          events_page: { limit: 50, before_ms: before?.ms, before_id: before?.id },
        },
      }),
    ])
      .then(([records, events]) => {
        if (!active) return;
        setHistory(records.items.find((item) => item.row_key === target.row_key));
        setAnalytics((current) =>
          before && current?.events && events.events
            ? {
                ...events,
                events: {
                  ...events.events,
                  items: [...current.events.items, ...events.events.items],
                },
              }
            : events
        );
        setHistoryError('');
        setHistoryLoading(false);
      })
      .catch((cause) => {
        if (active) {
          setHistoryError(cause instanceof Error ? cause.message : t('common.unknown_error'));
          setHistoryLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [
    availability.requestMonitoringAvailable,
    availability.managerServiceBase,
    config.entry.authIndex,
    managementKey,
    row.selectionKey,
    historyRefresh,
    before,
    t,
  ]);

  const modelEditor = {
    ...config.editor,
    dirty,
    canSave: dirty && !busy && !disableControls && Object.keys(config.editor.errors).length === 0,
    state: config.editor.state ? { ...config.editor.state, saving: busy } : null,
    reset: () => {
      setModelDraft(undefined);
      config.editor.reset();
      setSaveError('');
    },
    save: async () => {
      if (!dirty || modelSaving || disableControls || !configuredModels.length) return;
      setModelSaving(true);
      setSaveError('');
      try {
        if (!window.confirm(t('glm_quota.models_save_confirm'))) return;
        if (await config.saveWithProviderPatch({ models: configuredModels }))
          setModelDraft(undefined);
      } catch (cause) {
        setSaveError(cause instanceof Error ? cause.message : t('common.unknown_error'));
      } finally {
        setModelSaving(false);
      }
    },
  };
  const settingsEditor = {
    ...config.editor,
    dirty,
    canSave: dirty && !busy && !disableControls && Object.keys(config.editor.errors).length === 0,
    reset: modelEditor.reset,
    save: async () => {
      if (dirtyModels) await modelEditor.save();
      else await config.editor.save();
    },
  };
  const view = buildAccountDetailViewModel(row, {
    t,
    quotaWindows: mergeAccountQuotaSnapshotWindows(
      buildAccountQuotaWindowDefinitions(windows),
      snapshots,
      { provider: 'glm' }
    ).map((definition) => ({
      ...definition.display,
      providerWindowId: definition.providerWindowId,
      currentCycle: definition.currentCycle,
      previousCycle: definition.previousCycle,
      boundaryAccuracy: definition.boundaryAccuracy,
    })),
    windowUsageByKey: windowUsage,
    history,
    valueRow: analytics?.summary
      ? buildUsageValueRowFromMonitoringSummary(
          row,
          analytics.summary,
          analytics.account_stats ?? []
        )
      : null,
    diagnosticsSummary: analytics?.summary,
    diagnosticsEvents: analytics?.events?.items,
    diagnosticsTotalCount: analytics?.events?.total_count,
  });
  const refreshHistory = () => {
    setBefore(undefined);
    setHistoryLoading(true);
    setHistoryRefresh((value) => value + 1);
  };
  const title = (
    <div className={styles.drawerTitleIdentity}>
      <span className={styles.drawerProviderIcon}>
        <IconKey size={24} />
      </span>
      <div className={styles.drawerTitleStack}>
        <strong className={styles.drawerTitlePrimary}>{provider.name}</strong>
        <span className={styles.drawerTitleMeta}>
          GLM · {currentQuota?.data?.plan ?? '-'} · {maskApiKey(entry.apiKey)}
        </span>
        {credentialPicker?.(confirmDiscard)}
      </div>
    </div>
  );
  return (
    <AccountDetailDrawer
      title={title}
      bodyRef={drawerBody}
      activeTab={tab}
      disabled={row.disabled}
      onClose={onClose}
      onBeforeClose={confirmDiscard}
      onTabChange={(value) => {
        if (busy) return;
        if (
          (tab === 'config' || tab === 'models') &&
          value !== 'config' &&
          value !== 'models' &&
          dirty
        ) {
          if (!confirmDiscard()) return;
          config.editor.reset();
          setModelDraft(undefined);
        }
        setActiveTab(value);
      }}
      footer={
        <div className={styles.drawerActions}>
          <Button
            variant="secondary"
            loading={!currentQuota}
            onClick={() => setRefresh((value) => value + 1)}
          >
            {t('accounts.refresh_quota')}
          </Button>
          <Button
            variant="secondary"
            disabled={disableControls || dirty || busy}
            onClick={() =>
              void providersApi
                .patchOpenAICredential(
                  config.provider,
                  config.entry,
                  { disabled: !config.provider.disabled },
                  {},
                  createScopedApiRequestConfig(scope)
                )
                .then(() => config.reload())
                .catch((cause) => setSaveError(String(cause)))
            }
          >
            {t(config.provider.disabled ? 'accounts.enable' : 'accounts.disable')}
          </Button>
          <DropdownMenu
            ariaLabel={t('accounts.drawer_more_actions')}
            triggerLabel={t('accounts.batch_more')}
            triggerIcon={<IconMoreVertical size={16} />}
            triggerClassName={styles.drawerMoreActions}
            items={[
              {
                key: 'models',
                label: t('auth_files.models_button'),
                onClick: () => setActiveTab('models'),
                disabled: busy,
              },
              {
                key: 'reload',
                label: t('common.refresh'),
                onClick: () => {
                  if (confirmDiscard()) void config.editor.reload();
                },
                disabled: busy,
              },
              {
                key: 'delete',
                label: t('glm_quota.delete_provider'),
                tone: 'danger',
                disabled: disableControls || busy || dirty,
                onClick: () => {
                  if (window.confirm(t('glm_quota.delete_provider_confirm')))
                    void providersApi
                      .deleteOpenAIProvider(
                        config.provider.name,
                        createScopedApiRequestConfig(scope)
                      )
                      .then(() => {
                        onSaved(config.provider);
                        onClose();
                      })
                      .catch((cause) => setSaveError(String(cause)));
                },
              },
            ]}
          />
        </div>
      }
    >
      {currentQuota?.error && (
        <div role="alert" className={styles.errorBox}>
          {currentQuota.error}
        </div>
      )}
      {(saveError || config.error) && (
        <div role="alert" className={styles.errorBox}>
          {saveError || config.error}
        </div>
      )}
      {tab === 'overview' && (
        <AccountOverviewTab
          detailView={view}
          getHealthStatusClass={(status) =>
            status === 'available'
              ? styles.badgeGood
              : status === 'disabled'
                ? styles.badgeMuted
                : status === 'exception' || status === 'reauth'
                  ? styles.badgeBad
                  : styles.badgeNeutral
          }
          onSelectTab={setActiveTab}
        />
      )}
      {tab === 'quota' && (
        <>
          <AccountQuotaTab
            detailView={view}
            windowUsageError={historyError}
            historyAvailable={availability.requestMonitoringAvailable}
            historyRefreshing={historyLoading}
            onRefreshHistory={refreshHistory}
            onResetQuota={() => {}}
            resetQuotaDisabled
          />
          <GlmResetCards
            key={`${scope.apiBase}:${config.entry.authIndex}`}
            authIndex={config.entry.authIndex ?? ''}
            scope={scope}
            disabled={disableControls || dirty}
            onBusyChange={setResetBusy}
            onReset={() => {
              setRefresh((value) => value + 1);
              refreshHistory();
            }}
          />
        </>
      )}
      {tab === 'config' && (
        <AccountConfigurationTab
          row={row}
          editor={settingsEditor}
          configurationSource="provider-config"
          disableControls={disableControls}
          onCopyText={copy}
        />
      )}
      {tab === 'models' && (
        <AccountModelsTab
          row={row}
          disableControls={disableControls}
          fileName={provider.name}
          fileType="glm"
          loading={false}
          refreshing={modelsLoading}
          error={modelError ? 'failed' : null}
          models={configuredModels.map((model) => ({ id: model.name }))}
          modelDefinitions={[
            ...discovered,
            ...(config.provider.models ?? []).map((model) => ({ id: model.name })),
          ]}
          modelDefinitionsLoading={modelsLoading}
          modelDefinitionsError={null}
          globalExcluded={{}}
          globalExcludedState="ready"
          aliases={{
            glm: configuredModels
              .filter((model) => model.alias)
              .map((model) => ({ name: model.name, alias: model.alias! })),
          }}
          editor={modelEditor}
          onRefresh={() => void discover()}
          onManageGlobalRules={() => {}}
          onOpenAdvancedRules={() => setActiveTab('config')}
          onCopyText={copy}
          configuredModels={configuredModels}
          onConfiguredModelsChange={setModelDraft}
        />
      )}
      {tab === 'diagnostics' && (
        <AccountDiagnosticsTab
          row={row}
          detailView={view}
          inspectionLoading={false}
          candidatesLoading={false}
          candidatesError=""
          events={analytics?.events?.items ?? []}
          eventsTotalCount={analytics?.events?.total_count ?? 0}
          eventsHasMore={analytics?.events?.has_more ?? false}
          eventsLoading={historyLoading}
          eventsRefreshing={historyLoading}
          eventsAppending={false}
          eventsError={historyError}
          eventsUnavailable={!availability.requestMonitoringAvailable}
          nextBeforeMs={analytics?.events?.next_before_ms ?? null}
          nextBeforeId={analytics?.events?.next_before_id ?? null}
          onRefreshEvents={refreshHistory}
          onLoadMoreEvents={(ms, id) => setBefore({ ms, id })}
        />
      )}
    </AccountDetailDrawer>
  );
}
