import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  apiClient,
  createScopedApiRequestConfig,
  type ApiClientRequestScope,
} from '@/services/api/client';
import { providersApi } from '@/services/api/providers';
import type { ApiKeyEntry, OpenAIProviderConfig } from '@/types';
import { normalizeOpenAIProvider } from '@/services/api/transformers';
import {
  buildAuthFileConfigurationDraft,
  buildAuthFileConfigurationPatch,
  buildRedactedAuthFileConfigurationText,
  type AuthFileConfigurationDraft,
} from '@/features/authFiles/model/authFileConfiguration';
import type {
  UseAuthFileConfigurationEditorResult,
  AuthFileConfigurationEditorState,
} from '@/features/authFiles/hooks/useAuthFileConfigurationEditor';

export function useConfiguredCredentialEditor(
  provider: OpenAIProviderConfig,
  entry: ApiKeyEntry,
  scope: ApiClientRequestScope,
  onSaved: (provider: OpenAIProviderConfig) => void
) {
  const { t } = useTranslation();
  const [fresh, setFresh] = useState<{ provider: OpenAIProviderConfig; entry: ApiKeyEntry }>();
  const effectiveProvider = fresh?.provider ?? provider;
  const effectiveEntry = fresh?.entry ?? entry;
  const initial = useMemo(() => {
    const record = {
      type: 'glm',
      base_url: effectiveProvider.baseUrl,
      prefix: effectiveProvider.prefix,
      priority: effectiveProvider.priority,
      proxy_url: effectiveEntry.proxyUrl,
      weight: effectiveEntry.weight,
      headers: effectiveProvider.headers,
      disable_cooling: effectiveProvider.disableCooling,
      request_retry: effectiveProvider.requestRetry ?? effectiveProvider['request-retry'],
    };
    const draft = buildAuthFileConfigurationDraft(record, 'glm');
    return { record, draft };
  }, [effectiveProvider, effectiveEntry]);
  const [changes, setChanges] = useState<Partial<AuthFileConfigurationDraft>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [load, setLoad] = useState(0);
  const generation = useRef(0);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current += 1;
    };
  }, []);
  const draft = { ...initial.draft, ...changes };
  const validation = buildAuthFileConfigurationPatch(initial.record, 'glm', initial.draft, draft);
  if (draft.baseUrl !== initial.draft.baseUrl) {
    try {
      const url = new URL(draft.baseUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    } catch {
      validation.errors.baseUrl = 'accounts.config_error_xai_base_url';
    }
  }
  const dirty = Object.keys(changes).some(
    (key) =>
      changes[key as keyof AuthFileConfigurationDraft] !==
      initial.draft[key as keyof AuthFileConfigurationDraft]
  );
  const requestConfig = createScopedApiRequestConfig(scope);
  const saveInFlight = useRef(false);
  const savedCallback = useRef(onSaved);
  savedCallback.current = onSaved;
  const reload = useCallback(
    async (expectedProxy?: string) => {
      const version = ++generation.current;
      try {
        const response = await apiClient.get<{ 'openai-compatibility': unknown[] }>(
          '/openai-compatibility',
          createScopedApiRequestConfig(scope)
        );
        const matches = response['openai-compatibility']
          .map(normalizeOpenAIProvider)
          .filter((item): item is OpenAIProviderConfig =>
            Boolean(item && item.name === effectiveProvider.name)
          );
        if (matches.length !== 1) throw new Error(t('accounts.config_error_target_not_found'));
        const keys = matches[0].apiKeyEntries.filter(
          (key) =>
            key.apiKey === effectiveEntry.apiKey &&
            (key.proxyUrl ?? '') === (expectedProxy ?? effectiveEntry.proxyUrl ?? '')
        );
        if (keys.length !== 1) throw new Error(t('accounts.config_error_target_not_found'));
        if (active.current && generation.current === version) {
          setFresh({ provider: matches[0], entry: keys[0] });
          savedCallback.current(matches[0]);
          setChanges({});
          setError('');
          setLoad((value) => value + 1);
        }
      } catch (cause) {
        if (active.current && generation.current === version)
          setError(cause instanceof Error ? cause.message : t('common.unknown_error'));
        throw cause;
      }
    },
    [scope, effectiveProvider.name, effectiveEntry.apiKey, effectiveEntry.proxyUrl, t]
  );
  const save = async (extraProviderPatch: Record<string, unknown> = {}): Promise<boolean> => {
    if (
      saveInFlight.current ||
      (!dirty && !Object.keys(extraProviderPatch).length) ||
      Object.keys(validation.errors).length
    )
      return false;
    saveInFlight.current = true;
    setSaving(true);
    setError('');
    try {
      const providerPatch: Record<string, unknown> = { ...extraProviderPatch };
      const entryPatch: Record<string, unknown> = {};
      for (const field of [
        'baseUrl',
        'prefix',
        'priority',
        'headersText',
        'disableCooling',
        'requestRetry',
      ] as const) {
        if (draft[field] === initial.draft[field]) continue;
        if (field === 'baseUrl') providerPatch['base-url'] = draft.baseUrl.trim();
        if (field === 'prefix') providerPatch.prefix = draft.prefix.trim();
        if (field === 'priority')
          providerPatch.priority = draft.priority.trim() ? Number(draft.priority) : 0;
        if (field === 'headersText')
          providerPatch.headers = draft.headersText.trim() ? JSON.parse(draft.headersText) : {};
        if (field === 'disableCooling')
          providerPatch['disable-cooling'] =
            draft.disableCooling === 'inherit' ? null : draft.disableCooling === 'disabled';
        if (field === 'requestRetry')
          providerPatch['request-retry'] = draft.requestRetry.trim()
            ? Number(draft.requestRetry)
            : null;
      }
      if (draft.weight !== initial.draft.weight)
        entryPatch.weight = draft.weight.trim() ? Number(draft.weight) : 1;
      if (draft.proxyUrl !== initial.draft.proxyUrl)
        entryPatch['proxy-url'] = draft.proxyUrl.trim();
      await providersApi.patchOpenAICredential(
        effectiveProvider,
        effectiveEntry,
        providerPatch,
        entryPatch,
        requestConfig
      );
      await reload(draft.proxyUrl.trim());
      return true;
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : t('common.unknown_error'));
      return false;
    } finally {
      saveInFlight.current = false;
      if (active.current) setSaving(false);
    }
  };
  const state: AuthFileConfigurationEditorState = {
    authFile: { name: provider.name, provider: 'glm', authIndex: entry.authIndex },
    fileName: 'config.yaml',
    providerKey: 'glm',
    loading: false,
    saving,
    error: '',
    record: initial.record,
    recordIndex: null,
    originalDraft: initial.draft,
    draft,
  };
  const editor: UseAuthFileConfigurationEditorResult = {
    state,
    draft,
    errors: validation.errors,
    dirty,
    canSave: dirty && !saving && Object.keys(validation.errors).length === 0,
    rawDataText: buildRedactedAuthFileConfigurationText({
      ...effectiveProvider,
      apiKeyEntries: [effectiveEntry],
    }),
    sourceMemberCount: 1,
    sharedSourceReadOnly: false,
    updateField: (field, value) => setChanges((current) => ({ ...current, [field]: value })),
    reset: () => {
      setChanges({});
      setError('');
    },
    reload: async () => {
      try {
        await reload();
      } catch {
        return;
      }
    },
    save: async () => {
      await save();
    },
  };
  return {
    saveWithProviderPatch: save,
    editor,
    error,
    reload,
    reloadGeneration: load,
    provider: effectiveProvider,
    entry: effectiveEntry,
  };
}
