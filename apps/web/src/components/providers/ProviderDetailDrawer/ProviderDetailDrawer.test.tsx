import type { ReactNode } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { OpenAIProviderConfig } from '@/types';
import type { ProviderRecentUsageMap } from '../utils';
import { CoolingPolicySelect } from '../CoolingPolicySelect';
import { buildProviderRows, type ProviderRow } from '../ProviderTable/rowData';
import { ProviderDetailDrawer } from './ProviderDetailDrawer';
import {
  AccountOverviewTab,
  AccountQuotaTab,
  AccountConfigurationTab,
  AccountModelsTab,
  AccountDiagnosticsTab,
} from '@/features/accounts/components/accountDetail';

const authState = vi.hoisted(() => ({
  serverVersion: 'v7.2.93' as string | null,
  serverCommit: null as string | null,
  apiBase: 'https://manager.example',
  managementKey: 'management-key',
}));
const quotaRequest = vi.hoisted(() => vi.fn());
vi.mock('@/services/api/apiCall', () => ({
  apiCallApi: { request: quotaRequest },
  getApiCallErrorMessage: () => 'Quota request failed',
}));

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: typeof authState) => unknown) => selector(authState),
}));

const translate = (key: string) =>
  ({
    'ai_providers.weight_label': 'Weight',
    'ai_providers.weight_default_label': 'default',
    'ai_providers.cooling_policy_label': 'Cooling policy',
    'ai_providers.cooling_policy_inherit': 'Inherit global',
    'ai_providers.cooling_policy_enabled': 'Enable cooling',
    'ai_providers.cooling_policy_disabled': 'Disable cooling',
    'ai_providers.cooling_policy_hint': 'Cooling policy hint',
  })[key] ?? key;

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: translate, i18n: { language: 'en' } }),
}));

vi.mock('@/hooks/useUnsavedChangesGuard', () => ({ useUnsavedChangesGuard: () => ({}) }));

vi.mock('@/hooks/usePanelFeatureAvailability', () => ({
  usePanelFeatureAvailability: () => ({
    requestMonitoringAvailable: false,
    managerServiceBase: '',
  }),
}));

vi.mock('@/components/ui/Drawer', () => ({
  Drawer: ({ open, title, children }: { open: boolean; title?: ReactNode; children: ReactNode }) =>
    open ? (
      <div>
        {title}
        {children}
      </div>
    ) : null,
}));

const getText = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === 'string' ? child : getText(child))).join('');

const renderDetailText = (row: ProviderRow, open = true): string => {
  let renderer!: ReactTestRenderer;

  act(() => {
    renderer = create(
      <ProviderDetailDrawer
        row={row}
        open={open}
        usageByProvider={new Map()}
        resolvedTheme="light"
        actionsDisabled={false}
        toggleDisabled={false}
        onClose={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onToggle={() => {}}
        onToggleWebsockets={() => {}}
        onToggleCloak={() => {}}
        onToggleDisableCooling={() => {}}
      />
    );
  });

  const text = getText(renderer.root);
  act(() => renderer.unmount());
  return text;
};

const buildOpenAIRow = (provider: OpenAIProviderConfig) =>
  buildProviderRows({
    gemini: [],
    codex: [],
    claude: [],
    vertex: [],
    openai: [provider],
    usageByProvider: new Map() as ProviderRecentUsageMap,
  })[0];

describe('ProviderDetailDrawer', () => {
  it('loads GLM quota for each key while keeping configured models and aliases visible', async () => {
    quotaRequest.mockReset();
    quotaRequest.mockResolvedValue({
      statusCode: 200,
      body: {
        success: true,
        data: {
          level: 'pro',
          limits: [{ unit: 3, usage: 100, currentValue: 25, remaining: 75, percentage: 25 }],
        },
      },
    });
    const row = buildOpenAIRow({
      name: 'Renamed provider',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      apiKeyEntries: [
        { apiKey: 'first-key', authIndex: 'first' },
        { apiKey: 'second-key', authIndex: 'second' },
      ],
      models: [{ name: 'glm-5', alias: 'my-glm' }],
    });
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ProviderDetailDrawer
          row={row}
          open
          usageByProvider={new Map()}
          resolvedTheme="light"
          actionsDisabled={false}
          toggleDisabled={false}
          onClose={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
          onToggle={() => {}}
          onToggleWebsockets={() => {}}
          onToggleCloak={() => {}}
          onToggleDisableCooling={() => {}}
        />
      );
    });
    expect(
      quotaRequest.mock.calls
        .filter(([request]) => request.url.includes('/usage/quota/limit'))
        .map(([request]) => request.authIndex)
    ).toEqual(['first']);
    expect(
      renderer.root.findAllByProps({ role: 'tab' }).map((tab) => tab.children.join(''))
    ).toEqual([
      'accounts.detail_tab_overview',
      'accounts.detail_tab_quota',
      'accounts.detail_tab_config',
      'accounts.detail_tab_models',
      'accounts.detail_tab_diagnostics',
    ]);
    expect(getText(renderer.root)).toContain('pro');
    expect(renderer.root.findAllByType(AccountOverviewTab)).toHaveLength(1);
    act(() => renderer.root.findByProps({ id: 'accounts-detail-tab-quota' }).props.onClick());
    expect(renderer.root.findAllByType(AccountQuotaTab)).toHaveLength(1);
    act(() => renderer.root.findByProps({ id: 'accounts-detail-tab-config' }).props.onClick());
    expect(renderer.root.findAllByType(AccountConfigurationTab)).toHaveLength(1);
    act(() => renderer.root.findByProps({ id: 'accounts-detail-tab-diagnostics' }).props.onClick());
    expect(renderer.root.findAllByType(AccountDiagnosticsTab)).toHaveLength(1);
    act(() => renderer.root.findByProps({ id: 'accounts-detail-tab-models' }).props.onClick());
    expect(renderer.root.findAllByType(AccountModelsTab)).toHaveLength(1);
    expect(getText(renderer.root)).toContain('glm-5');
    expect(getText(renderer.root)).toContain('my-glm');
    await act(async () =>
      renderer.root.findByType('select').props.onChange({ target: { value: '1' } })
    );
    expect(
      quotaRequest.mock.calls
        .filter(([request]) => request.url.includes('/usage/quota/limit'))
        .map(([request]) => request.authIndex)
    ).toEqual(['first', 'second']);
    expect(
      renderer.root.findByProps({ id: 'accounts-detail-tab-models' }).props['aria-selected']
    ).toBe(true);
    act(() => renderer.unmount());
    quotaRequest.mockClear();
    renderDetailText(row, false);
    for (const baseUrl of [
      'https://other.example/v1',
      'https://api.z.ai.evil.example/v1',
      'http://api.z.ai/v1',
      'invalid',
    ]) {
      renderDetailText(
        buildOpenAIRow({
          name: 'glm',
          baseUrl,
          apiKeyEntries: [{ apiKey: 'key', authIndex: 'third' }],
        })
      );
    }
    expect(quotaRequest).not.toHaveBeenCalled();
  });

  it('shows effective OpenAI key weights, including the default and explicit zero', () => {
    const row = buildOpenAIRow({
      name: 'Weighted OpenAI',
      baseUrl: 'https://openai.example/v1',
      apiKeyEntries: [
        { apiKey: 'default-key' },
        { apiKey: 'weighted-key', weight: 3 },
        { apiKey: 'excluded-key', weight: 0 },
      ],
    });
    const text = renderDetailText(row);
    expect(text).toContain('Weight: 1 (default)');
    expect(text).toContain('Weight: 3');
    expect(text).toContain('Weight: 0');
    expect(text.match(/\(default\)/g)).toHaveLength(1);
  });

  it('shows effective weights for every single-key provider kind', () => {
    const rows = buildProviderRows({
      gemini: [{ apiKey: 'gemini-default' }],
      interactions: [{ apiKey: 'interactions-weighted', weight: 2 }],
      codex: [{ apiKey: 'codex-zero', weight: 0 }],
      xai: [{ apiKey: 'xai-default' }],
      claude: [{ apiKey: 'claude-weighted', weight: 4 }],
      vertex: [{ apiKey: 'vertex-weighted', weight: 5 }],
      openai: [],
      usageByProvider: new Map() as ProviderRecentUsageMap,
    });
    const expectedWeights = new Map<ProviderRow['kind'], string>([
      ['gemini', 'Weight1 (default)'],
      ['interactions', 'Weight2'],
      ['codex', 'Weight0'],
      ['xai', 'Weight1 (default)'],
      ['claude', 'Weight4'],
      ['vertex', 'Weight5'],
    ]);

    expect(rows).toHaveLength(expectedWeights.size);
    rows.forEach((row) => {
      expect(renderDetailText(row)).toContain(expectedWeights.get(row.kind));
    });
  });

  it.each([
    [true, 'Disable cooling'],
    [false, 'Enable cooling'],
    [null, 'Inherit global'],
    [undefined, 'Inherit global'],
  ] as const)('renders the %j provider cooling override as %s', (override, expected) => {
    authState.serverVersion = 'v7.2.93';
    const row = buildProviderRows({
      gemini: [{ apiKey: 'gemini-key', disableCooling: override }],
      codex: [],
      claude: [],
      vertex: [],
      openai: [],
      usageByProvider: new Map() as ProviderRecentUsageMap,
    })[0];

    expect(renderDetailText(row)).toContain(expected);
  });

  it.each([
    [undefined, 'disabled'],
    [undefined, 'enabled'],
    [true, 'inherit'],
    [false, 'inherit'],
    [true, 'enabled'],
    [false, 'disabled'],
  ] as const)('forwards the %j -> %s cooling policy transition', (override, nextPolicy) => {
    authState.serverVersion = 'v7.2.93';
    const row = buildProviderRows({
      gemini: [{ apiKey: 'gemini-key', disableCooling: override }],
      codex: [],
      claude: [],
      vertex: [],
      openai: [],
      usageByProvider: new Map() as ProviderRecentUsageMap,
    })[0];
    const onToggleDisableCooling = vi.fn();
    let renderer!: ReactTestRenderer;

    act(() => {
      renderer = create(
        <ProviderDetailDrawer
          row={row}
          open
          usageByProvider={new Map()}
          resolvedTheme="light"
          actionsDisabled={false}
          toggleDisabled={false}
          onClose={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
          onToggle={() => {}}
          onToggleWebsockets={() => {}}
          onToggleCloak={() => {}}
          onToggleDisableCooling={onToggleDisableCooling}
        />
      );
    });

    act(() => renderer.root.findByType(CoolingPolicySelect).props.onChange(nextPolicy));
    expect(onToggleDisableCooling).toHaveBeenCalledWith(row, nextPolicy);

    act(() => renderer.unmount());
  });
});
