import { useCallback, useState } from 'react';
import { useAuthStore } from '@/stores/useAuthStore';
import type { OpenAIProviderConfig } from '@/types';
import { maskApiKey } from '@/utils/format';
import type { AccountDetailTab } from '@/features/accounts/components/accountDetail/AccountDetailDrawer';
import { ConfiguredGlmDetail } from '@/features/accounts/components/accountDetail/ConfiguredGlmDetail';

export function GlmProviderDetails({
  provider,
  onClose,
  onSaved: notifySaved,
  disableControls = false,
}: {
  provider: OpenAIProviderConfig;
  onClose: () => void;
  onSaved?: () => void;
  disableControls?: boolean;
}) {
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const [selected, setSelected] = useState(0);
  const [activeTab, setActiveTab] = useState<AccountDetailTab>('overview');
  const [fresh, setFresh] = useState<OpenAIProviderConfig>();
  const current = fresh ?? provider;
  const entry = current.apiKeyEntries[selected];
  const onSaved = useCallback(
    (value: OpenAIProviderConfig) => {
      setFresh(value);
      notifySaved?.();
    },
    [notifySaved]
  );
  if (!entry) return null;
  return (
    <ConfiguredGlmDetail
      key={`${apiBase}:${managementKey}:${current.name}:${selected}:${entry.apiKey}:${entry.authIndex ?? ''}`}
      provider={current}
      entry={entry}
      onClose={onClose}
      disableControls={disableControls}
      onSaved={onSaved}
      initialTab={activeTab}
      onTabChanged={setActiveTab}
      credentialPicker={(canSwitch) =>
        current.apiKeyEntries.length > 1 ? (
          <select
            aria-label="Credential"
            value={selected}
            onChange={(event) => {
              if (canSwitch()) setSelected(Number(event.target.value));
            }}
          >
            {current.apiKeyEntries.map((key, index) => (
              <option key={index} value={index}>
                {index + 1}: {maskApiKey(key.apiKey)}
              </option>
            ))}
          </select>
        ) : undefined
      }
    />
  );
}
