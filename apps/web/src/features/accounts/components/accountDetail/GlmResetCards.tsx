import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import type { ApiClientRequestScope } from '@/services/api/client';
import {
  listGlmResetCards,
  redeemGlmResetCard,
  getPendingGlmCards,
  isGlmCardPending,
  GlmResetError,
  type GlmResetCard,
  type GlmResetCardList,
} from '@/utils/quota/glmResetCards';
import styles from '../../AccountsPage.module.scss';

export function GlmResetCards({
  authIndex,
  scope,
  disabled,
  onReset,
  onBusyChange,
}: {
  authIndex: string;
  scope: ApiClientRequestScope;
  disabled: boolean;
  onReset: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const [refresh, setRefresh] = useState(0);
  const [list, setList] = useState<GlmResetCardList>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const [pending, setPending] = useState<GlmResetCard[]>([]);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const scopeKey = JSON.stringify([authIndex, scope.apiBase, scope.managementKey, refresh]);
  const requestScope = useMemo(() => scope, [scope]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      busyCallback.current(false);
    };
  }, []);
  const message = useCallback(
    (cause: unknown) =>
      cause instanceof GlmResetError
        ? t(`glm_reset.error_${cause.reason}`)
        : t('glm_reset.error_response'),
    [t]
  );
  useEffect(() => {
    let active = true;
    void listGlmResetCards(authIndex, requestScope)
      .then((data) => {
        if (!active) return;
        setList(data);
        setPending(getPendingGlmCards(authIndex, requestScope));
        setError('');
      })
      .catch((cause) => {
        if (active) {
          setError(message(cause));
          try {
            setPending(getPendingGlmCards(authIndex, requestScope));
          } catch {
            setPending([]);
          }
        }
      });
    return () => {
      active = false;
    };
  }, [scopeKey, authIndex, requestScope, message]);

  const redeem = async (card: GlmResetCard) => {
    if (inFlight.current || disabled) return;
    let retry = false;
    try {
      retry = isGlmCardPending(authIndex, card, scope);
    } catch (cause) {
      setError(message(cause));
      return;
    }
    const windowLabel = t(
      card.resetType === 'FIVE_HOUR' ? 'glm_quota.five_hour' : 'glm_quota.weekly'
    );
    if (
      !window.confirm(
        t(retry ? 'glm_reset.confirm_retry' : 'glm_reset.confirm', { window: windowLabel })
      )
    )
      return;
    inFlight.current = true;
    setBusy(true);
    busyCallback.current(true);
    setError('');
    setSuccess(false);
    try {
      await redeemGlmResetCard(authIndex, card, scope);
      if (!mounted.current) return;
      setList((current) =>
        current
          ? {
              ...current,
              cards: current.cards.filter(
                (item) => item.id !== card.id || item.resetType !== card.resetType
              ),
            }
          : undefined
      );
      setPending((current) =>
        current.filter((item) => item.id !== card.id || item.resetType !== card.resetType)
      );
      setSuccess(true);
      onReset();
      setRefresh((value) => value + 1);
    } catch (cause) {
      if (mounted.current) {
        setError(message(cause));
        try {
          setPending(getPendingGlmCards(authIndex, scope));
        } catch {
          setPending([]);
        }
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setBusy(false);
        busyCallback.current(false);
      }
    }
  };
  const cards = [
    ...pending,
    ...(list?.cards ?? []).filter(
      (card) => !pending.some((item) => item.id === card.id && item.resetType === card.resetType)
    ),
  ];
  return (
    <section className={styles.drawerSection} aria-label={t('glm_reset.title')}>
      <div className={styles.quotaTabHeader}>
        <h3>{t('glm_reset.title')}</h3>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setList(undefined);
            setRefresh((value) => value + 1);
          }}
        >
          {t('common.refresh')}
        </Button>
      </div>
      <p>{t('glm_reset.description')}</p>
      {success && <p role="status">{t('glm_reset.success')}</p>}
      {error && (
        <p role="alert" className={styles.errorBox}>
          {error}
        </p>
      )}
      {!list && !error && <p role="status">{t('common.loading')}</p>}
      {list && cards.length === 0 && <p>{t('glm_reset.empty')}</p>}
      {cards.map((card) => {
        const uncertain = pending.some(
          (item) => item.id === card.id && item.resetType === card.resetType
        );
        return (
          <div key={`${card.resetType}:${card.id}`} className={styles.drawerSection}>
            <strong>
              {t(card.resetType === 'FIVE_HOUR' ? 'glm_quota.five_hour' : 'glm_quota.weekly')}
            </strong>
            {card.title && <span>{card.title}</span>}
            <span>
              {card.expiresAtMs !== null
                ? t('glm_reset.expires', {
                    time: new Date(card.expiresAtMs).toLocaleString(i18n.language),
                  })
                : t('glm_reset.no_expiry')}
            </span>
            <Button
              size="sm"
              variant="danger"
              disabled={
                disabled ||
                busy ||
                (!uncertain && pending.length > 0) ||
                (!uncertain && card.expiresAtMs !== null && card.expiresAtMs <= Date.now())
              }
              loading={busy}
              onClick={() => void redeem(card)}
            >
              {t(uncertain ? 'glm_reset.retry' : 'glm_reset.use')}
            </Button>
          </div>
        );
      })}
      {list?.lastFiveHourResetAtMs && (
        <p>
          {t('glm_reset.last_five_hour', {
            time: new Date(list.lastFiveHourResetAtMs).toLocaleString(i18n.language),
          })}
        </p>
      )}
      {list?.lastWeekResetAtMs && (
        <p>
          {t('glm_reset.last_week', {
            time: new Date(list.lastWeekResetAtMs).toLocaleString(i18n.language),
          })}
        </p>
      )}
    </section>
  );
}
