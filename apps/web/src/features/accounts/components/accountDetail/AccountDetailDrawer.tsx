import type { PropsWithChildren, ReactNode, Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Drawer } from '@/components/ui/Drawer';
import styles from '@/features/accounts/AccountsPage.module.scss';

export type AccountDetailTab = 'overview' | 'quota' | 'config' | 'models' | 'diagnostics';

export function AccountDetailDrawer({
  title,
  footer,
  activeTab,
  onTabChange,
  onClose,
  onBeforeClose,
  bodyRef,
  disabled,
  children,
}: PropsWithChildren<{
  title: ReactNode;
  footer: ReactNode;
  activeTab: AccountDetailTab;
  onTabChange: (tab: AccountDetailTab) => void;
  onClose: () => void;
  onBeforeClose?: () => boolean | Promise<boolean>;
  bodyRef?: Ref<HTMLDivElement>;
  disabled?: boolean;
}>) {
  const { t } = useTranslation();
  const tabs: AccountDetailTab[] = ['overview', 'quota', 'config', 'models', 'diagnostics'];
  return (
    <Drawer
      open
      onClose={onClose}
      onBeforeClose={onBeforeClose}
      width="clamp(540px, 45vw, 720px)"
      className={styles.accountDetailDrawer}
      bodyRef={bodyRef}
      title={title}
      footer={footer}
    >
      <div className={styles.drawerBodyShell} data-detail-tab={activeTab}>
        {disabled && (
          <div className={styles.drawerDisabledNotice} role="status">
            <span>{t('accounts.detail_disabled_notice_title')}</span>
            <p>{t('accounts.detail_disabled_notice_desc')}</p>
          </div>
        )}
        <div
          className={styles.drawerTabs}
          role="tablist"
          aria-label={t('accounts.detail_tablist_label')}
        >
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`accounts-detail-tab-${tab}`}
              aria-selected={activeTab === tab}
              aria-controls="accounts-detail-tab-panel"
              className={activeTab === tab ? styles.drawerTabActive : ''}
              onClick={() => onTabChange(tab)}
            >
              {t(`accounts.detail_tab_${tab}`)}
            </button>
          ))}
        </div>
        <div
          id="accounts-detail-tab-panel"
          className={styles.drawerTabPanel}
          role="tabpanel"
          aria-labelledby={`accounts-detail-tab-${activeTab}`}
        >
          {children}
        </div>
      </div>
    </Drawer>
  );
}
