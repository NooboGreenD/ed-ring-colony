'use client';

import { useCallback, useEffect, useState } from 'react';
import { IconCalendar, IconClock, IconHistory } from '@/components/Icons';
import { useI18n } from '@/lib/i18n/I18nContext';
import { CarrierJumpBoard } from '@/components/Carriers/CarrierJumpBoard';
import { CarrierJumpCalendar } from '@/components/Carriers/CarrierJumpCalendar';
import { CarrierJumpHistory } from '@/components/Carriers/CarrierJumpHistory';
import { parseHistoryPeriod, type HistoryPeriod } from '@/lib/carrierJumpHistory';

type Tab = 'board' | 'calendar' | 'history';

interface Prefill {
  carrierId: string;
  callsign: string | null;
  name: string | null;
  from: string;
  to: string;
  departureAt: string;
}

/**
 * Адрес вкладки: `?tab=calendar&schedule=<id>` и `?tab=history&period=1m` —
 * ссылкой делятся: расписание копируется как ссылка, история запоминает период.
 */
function readLocation(): { tab: Tab; schedule: string | null; period: HistoryPeriod } {
  if (typeof window === 'undefined') return { tab: 'board', schedule: null, period: '1d' };
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('tab');
  const tab: Tab = raw === 'calendar' || raw === 'history' ? raw : 'board';
  return {
    tab,
    schedule: params.get('schedule'),
    period: parseHistoryPeriod(params.get('period')),
  };
}

/**
 * Страница «Авианосцы перед прыжком» целиком: вкладка «Прыжки» (живые заказы),
 * «Расписание» (календарь планов) и «История» (что уже случилось).
 *
 * Все вкладки держим смонтированными: у таблицы свой поиск и подписки, у
 * календаря — выбранное расписание и месяц, у истории — поиск. Переключение
 * вкладки не должно сбрасывать введённое. Запросы это не размножает: таблица
 * обновляется раз в минуту, календарь — по действиям, история грузится только
 * когда её открыли.
 *
 * Вкладка и открытое расписание записываются в адрес: публичное расписание
 * копируется ссылкой, а после перезагрузки открывается то же самое.
 */
export function CarrierJumpsPage() {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('board');
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const [period, setPeriod] = useState<HistoryPeriod>('1d');
  const [prefill, setPrefill] = useState<Prefill | null>(null);

  useEffect(() => {
    const initial = readLocation();
    setTab(initial.tab);
    setScheduleId(initial.schedule);
    setPeriod(initial.period);
  }, []);

  const writeLocation = useCallback((nextTab: Tab, nextSchedule: string | null, nextPeriod: HistoryPeriod | null) => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (nextTab === 'board') params.delete('tab');
    else params.set('tab', nextTab);
    if (nextTab === 'calendar' && nextSchedule) params.set('schedule', nextSchedule);
    else params.delete('schedule');
    if (nextTab === 'history' && nextPeriod) params.set('period', nextPeriod);
    else params.delete('period');
    const query = params.toString();
    const url = `${window.location.pathname}${query ? `?${query}` : ''}`;
    window.history.replaceState(null, '', url);
  }, []);

  const selectTab = useCallback((next: Tab) => {
    setTab(next);
    writeLocation(
      next,
      next === 'calendar' ? scheduleId : null,
      next === 'history' ? period : null,
    );
  }, [period, scheduleId, writeLocation]);

  const selectPeriod = useCallback((next: HistoryPeriod) => {
    setPeriod(next);
    writeLocation('history', null, next);
  }, [writeLocation]);

  const selectSchedule = useCallback((id: string | null) => {
    setScheduleId(id);
    writeLocation('calendar', id, null);
  }, [writeLocation]);

  /** Строка живой таблицы → форма расписания на вкладке «Расписание». */
  const scheduleJump = useCallback((row: {
    id: string;
    callsign: string | null;
    from: string;
    to: string;
    departureAt: string | null;
    carrier: { name: string | null };
  }) => {
    if (!row.departureAt) return;
    setPrefill({
      carrierId: row.id,
      callsign: row.callsign,
      name: row.carrier.name ?? null,
      from: row.from,
      to: row.to,
      departureAt: row.departureAt,
    });
    setTab('calendar');
    writeLocation('calendar', scheduleId, null);
  }, [scheduleId, writeLocation]);

  return (
    <>
      <div className="cj-tabs" role="tablist" aria-label={t('cj.title')}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'board'}
          className={`cj-tab${tab === 'board' ? ' active' : ''}`}
          onClick={() => selectTab('board')}
        >
          <IconClock size={14} />
          {t('cjc.tabBoard')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'calendar'}
          className={`cj-tab${tab === 'calendar' ? ' active' : ''}`}
          onClick={() => selectTab('calendar')}
        >
          <IconCalendar size={14} />
          {t('cjc.tabCalendar')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'history'}
          className={`cj-tab${tab === 'history' ? ' active' : ''}`}
          onClick={() => selectTab('history')}
        >
          <IconHistory size={14} />
          {t('cjh.tab')}
        </button>
      </div>

      <div hidden={tab !== 'board'} role="tabpanel">
        <CarrierJumpBoard onScheduleJump={scheduleJump} />
      </div>
      <div hidden={tab !== 'calendar'} role="tabpanel">
        <CarrierJumpCalendar
          initialScheduleId={scheduleId}
          prefill={prefill}
          onPrefillUsed={() => setPrefill(null)}
          onSelectSchedule={selectSchedule}
        />
      </div>
      <div hidden={tab !== 'history'} role="tabpanel">
        <CarrierJumpHistory
          active={tab === 'history'}
          period={period}
          onPeriodChange={selectPeriod}
        />
      </div>
    </>
  );
}

export default CarrierJumpsPage;
