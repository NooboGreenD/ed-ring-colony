'use client';

import { useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import {
  ACHIEVEMENT_TRACKS,
  HERO_BADGES,
  pilotAchievements,
  tierColor,
  tierBg,
  tierBorder,
} from '@/lib/achievements';
import {
  AllegianceIcon,
  IconPower,
  IconActivity,
  IconHomeSystem,
  IconLanguage,
  IconTimezone,
  IconOpenRecruit,
  IconDiscord,
  IconWebsite,
  IconCheck,
  IconError,
  IconAnchor,
  IconRadio,
  IconAtlas,
  IconRoute,
  IconBuilding,
  IconInfo,
  AchievementIcon,
} from '@/components/Icons';
import { useFriends } from '@/hooks/useFriends';
import { useI18n } from '@/lib/i18n/I18nContext';
import {
  achievementRankDesc,
  achievementRankName,
  achievementTrackSubtitle,
  achievementTrackTitle,
  heroBadgeDesc,
  heroBadgeName,
} from '@/lib/i18n/achievementLabels';

/**
 * Название ранга по его номеру. `null`/`undefined` — «нет данных» и показывается
 * как «—»: прежний `?? 0` превращал отсутствующий ранг в настоящий нулевой
 * («Harmless», «Defenceless»), что выглядело как реальный результат.
 */
function rankName(list: string[], value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return list[value] ?? '—';
}

const RANK_NAMES = ['Harmless','Mostly Harmless','Novice','Competent','Expert','Master','Dangerous','Deadly','Elite'];
const EMPIRE_RANKS = ['None','Outsider','Serf','Master','Squire','Knight','Lord','Baron','Viscount','Count','Earl','Marquis','Duke','Prince','King'];
const FED_RANKS = ['None','Recruit','Cadet','Midshipman','Petty Officer','Chief Petty Officer','Warrant Officer','Ensign','Lieutenant','Lt. Commander','Post Commander','Post Captain','Rear Admiral','Vice Admiral','Admiral'];
const MERCENARY_RANKS = ['Defenceless', 'Mostly Defenceless', 'Rookie', 'Soldier', 'Gunslinger', 'Warrior', 'Gladiator', 'Deadeye', 'Elite', 'Elite I', 'Elite II', 'Elite III', 'Elite IV', 'Elite V'];

/**
 * Подписи и цвета видов сдачи груза (`delivery_kind`). Ключи — те же, что в
 * `src/lib/cargoScope.ts::DeliveryKind`; неизвестный вид показывается как есть,
 * поэтому новая колонка журнала не сломает досье.
 */
const CARGO_KIND_META: Record<string, { label: string; hint: string; color: string }> = {
  construction_site: { label: 'dossier.kindSiteLabel', hint: 'dossier.kindSiteHint', color: '#f39c12' },
  colonisation_ship: { label: 'dossier.kindShipLabel', hint: 'dossier.kindShipHint', color: '#fbbf24' },
  legacy_site: { label: 'dossier.kindLegacyLabel', hint: 'dossier.kindLegacyHint', color: '#a3a3a3' },
  fleet_carrier: { label: 'dossier.kindCarrierLabel', hint: 'dossier.kindCarrierHint', color: '#60a5fa' },
  mission_delivery: { label: 'dossier.kindMissionLabel', hint: 'dossier.kindMissionHint', color: '#22c55e' },
  market_sale: { label: 'dossier.kindMarketLabel', hint: 'dossier.kindMarketHint', color: '#e67e22' },
  powerplay_delivery: { label: 'dossier.kindPowerplayLabel', hint: 'dossier.kindPowerplayHint', color: '#a855f7' },
  rescue_delivery: { label: 'dossier.kindRescueLabel', hint: 'dossier.kindRescueHint', color: '#ef4444' },
};
const EXOBIOLOGIST_RANKS = ['Directionless', 'Mostly Directionless', 'Compiler', 'Collector', 'Explorer', 'Surveyor', 'Taxonomist', 'Geneticist', 'Elite', 'Elite I', 'Elite II', 'Elite III', 'Elite IV', 'Elite V'];

type Delivery = {
  system_name: string;
  commodity: string;
  amount: number;
  delivered_at: string;
};

type AllDelivery = {
  system_name: string;
  commodity: string;
  amount: number;
};

type Props = {
  displayName: string;
  avatarUrl: string | null;
  createdAt: string | null;
  rank: number | null;
  /** Весь перевозимый груз за всё время (все строки deliveries, любой источник). */
  totalTons: number;
  /** Тоннаж, реально сданный на стройплощадки колонизационных проектов. */
  siteTons: number;
  /** Число поставок на стройплощадки (для подписи к блоку строительства). */
  siteOpsCount: number;
  /** Тоннаж по системам, посчитанный только по строительным поставкам. */
  siteSystems: [string, number][];
  /** Доля строительных поставок в общем тоннаже, 0…100. */
  siteSharePercent: number;
  /** Тоннаж перевозок, не относящихся к проектам (авианосцы, миссии, рынки). */
  transportTons: number;
  /** Число таких перевозок. */
  transportOpsCount: number;
  /** Тоннаж перевозок по системам. */
  transportSystems: [string, number][];
  /** Топ товаров, сданных на стройплощадки. */
  siteCommodities: [string, number][];
  /**
   * Разбивка тоннажа по получателю груза (`delivery_kind`): стройплощадки,
   * колонизационные корабли, авианосцы, грузовые миссии, рынки, Powerplay, SAR.
   */
  cargoKinds: { kind: string; tons: number; ops: number }[];
  /**
   * Что командир разрешил показывать другим. Скрытые блоки сервер не присылает
   * вовсе — здесь остаётся только подпись-заглушка, чтобы зритель понимал,
   * что данные есть, но закрыты настройками приватности.
   */
  privacy?: {
    balance?: boolean;
    ranks?: boolean;
    cargo?: boolean;
    deliveries?: boolean;
    location?: boolean;
  };
  /** Текущий зритель — владелец досье (ему видны все блоки). */
  isOwnProfile?: boolean;
  hubsCount: number;
  routeCount: number;
  routeSystemsVisited: number;
  opsCount: number;
  lastDelivery: string | null;
  systems: [string, number][];
  commodities: [string, number][];
  recent: Delivery[];
  allDeliveries: AllDelivery[];
  trackTons: Record<string, number>;
  architectCount: number;
  architectSystems: string[];
  squadron?: {
    id: number;
    name: string;
    tag: string | null;
    description: string | null;
    color: string;
    status: string;
    allegiance: string | null;
    power: string | null;
    language: string | null;
    timezone: string | null;
    member_limit: number | null;
    member_count?: number;
    project_count?: number;
    activity_type: string | null;
    home_system: string | null;
    discord_url: string | null;
    website_url: string | null;
    is_open_recruitment: boolean;
  } | null;
  currentUserId?: string | null;
  profileUserId?: string | null;
  capiProfile?: {
    cmdr_name: string | null;
    credits: number | null;
    loan?: number | null;
    cqc_rank?: number | null;
    frontier_id?: string | null;
    combat_rank: number | null;
    trade_rank: number | null;
    explore_rank: number | null;
    empire_rank: number | null;
    federation_rank: number | null;
    current_ship: string | null;
    current_system: string | null;
    current_station: string | null;
    ships?: { shipType?: string; shipName?: string; shipIdent?: string }[] | null;
    last_updated: string | null;
  } | null;
  pilotStats?: {
    credits?: number | null;
    arx?: number | null;
    mercenary_coins?: number | null;
    mercenary_rank?: number | null;
    exobiologist_rank?: number | null;
    combat_rank?: number | null;
    trade_rank?: number | null;
    explore_rank?: number | null;
    empire_rank?: number | null;
    federation_rank?: number | null;
    current_ship?: string | null;
    current_system?: string | null;
    current_station?: string | null;
    first_discoveries_count?: number | null;
    first_mapped_count?: number | null;
    first_footfalls_count?: number | null;
    bio_samples_count?: number | null;
    bio_species_count?: number | null;
    bio_value_cr?: number | null;
    exploration_stats?: Record<string, any> | null;
    last_updated?: string | null;
  } | null;
};

/* ── Inara-style stat card ── */
function StatCard({
  label,
  value,
  color,
  sub,
  icon,
}: {
  label: string;
  value: string | number;
  color: string;
  sub?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: `1px solid ${color}33`,
        background: `${color}0D`,
        borderRadius: 4,
        padding: '14px 16px',
        minWidth: 0,
        transition: 'border-color 0.2s, background 0.2s',
      }}
    >
      <div
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          fontSize: 11,
          letterSpacing: 2,
          textTransform: 'uppercase',
          color: '#9ca3af',
          marginBottom: 6,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {icon}
        {label}
      </div>
      <div
        style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          fontSize: 26,
          fontWeight: 700,
          color,
          lineHeight: 1.1,
          wordBreak: 'break-word',
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            fontSize: 11,
            color: '#9ca3af',
            marginTop: 4,
            fontFamily: 'ui-monospace, monospace',
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

/* ── Inara-style progress bar ── */
function InaraProgress({
  value,
  max,
  color,
  label,
  sub,
}: {
  value: number;
  max: number;
  color: string;
  label: string;
  sub?: string;
}) {
  const { locale } = useI18n();
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontSize: 12,
            color: '#eeeeee',
            fontWeight: 500,
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: 'ui-monospace, monospace',
            fontSize: 11,
            color: '#9ca3af',
          }}
        >
          {value.toLocaleString(locale)} / {max.toLocaleString(locale)}
        </span>
      </div>
      <div
        style={{
          height: 4,
          background: '#25282b',
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: color,
            transition: 'width 0.6s ease',
          }}
        />
      </div>
      {sub && (
        <div
          style={{
            fontSize: 11,
            color: '#9ca3af',
            marginTop: 2,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

/* ── Section header (Inara style) ── */
function SectionHeader({ title, count }: { title: string; count?: number }) {
  const { locale } = useI18n();
  return (
    <h3
      style={{
        margin: '24px 0 12px',
        fontSize: 13,
        letterSpacing: 3,
        textTransform: 'uppercase',
        color: '#eeeeee',
        fontWeight: 600,
        borderBottom: '1px solid #323538',
        paddingBottom: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      {title}
      {count !== undefined && (
        <span
          style={{
            fontFamily: 'ui-monospace, monospace',
            fontSize: 11,
            color: '#e67e22',
            letterSpacing: 1,
          }}
        >
          ({count.toLocaleString(locale)})
        </span>
      )}
    </h3>
  );
}

/* ── Tier badge square (Inara style) ── */
function TierSquare({
  rank,
  name,
  desc,
  achieved,
  isCurrent,
}: {
  rank: number;
  name: string;
  desc: string;
  achieved: boolean;
  isCurrent: boolean;
}) {
  const color = achieved ? tierColor(rank) : '#475569';
  const bg = achieved ? tierBg(rank) : '#1a1c1e';
  const border = achieved ? tierBorder(rank) : '#323538';
  return (
    <div
      title={`${name} — ${desc}`}
      style={{
        width: 32,
        height: 32,
        borderRadius: 3,
        border: `1px solid ${isCurrent ? '#eeeeee' : border}`,
        background: bg,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'ui-monospace, monospace',
        fontSize: 9,
        color,
        fontWeight: 700,
        lineHeight: 1,
        opacity: achieved ? 1 : 0.4,
        transition: 'all 0.2s',
        cursor: 'help',
      }}
    >
      <span style={{ fontSize: 10 }}>T{rank}</span>
    </div>
  );
}

/* ── Achievement track card (Inara style) ── */
function AchievementTrackCard({
  p,
}: {
  p: {
    track: { id: string; title: string; subtitle: string; icon: string; color: string; ranks: { rank: number; name: string; threshold: number; desc: string }[] };
    earned: number;
    current: { rank: number; name: string; threshold: number } | null;
    next: { rank: number; name: string; threshold: number } | null;
    into: number;
    total: number;
  };
}) {
  const { t, locale } = useI18n();
  const track = p.track;
  const isLocked = p.earned === 0;
  const currentColor = p.earned > 0 ? tierColor(p.earned) : '#475569';
  const prevThreshold = p.earned > 0 ? track.ranks[p.earned - 1].threshold : 0;
  const nextThreshold = p.next?.threshold ?? (p.current?.threshold ?? 1);
  const span = nextThreshold - prevThreshold;
  const intoPct = span > 0 ? Math.min(100, ((p.total - prevThreshold) / span) * 100) : 100;

  const allTiersTooltip = track.ranks
    .map((r) => `T${r.rank}: ${achievementRankName(track.id, r.rank, r.name, t)} — ${achievementRankDesc(track.id, r.threshold, r.desc, t, locale)}`)
    .join('\n');

  return (
    <div
      style={{
        border: `1px solid ${isLocked ? '#323538' : tierBorder(p.earned)}`,
        background: isLocked ? '#0f1113' : tierBg(p.earned),
        borderRadius: 4,
        padding: 14,
        opacity: isLocked ? 0.55 : 1,
        transition: 'opacity 0.2s',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 22, filter: isLocked ? 'grayscale(1)' : 'none', display: 'flex', alignItems: 'center' }}><AchievementIcon icon={track.icon} size={22} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: isLocked ? '#9ca3af' : '#eeeeee' }}>
              {achievementTrackTitle(track.id, track.title, t)}
            </span>
            <span
              title={allTiersTooltip}
              style={{
                fontSize: 12,
                color: '#9ca3af',
                cursor: 'help',
                userSelect: 'none',
              }}
            >
              <IconInfo size={12} color="#9ca3af" />
            </span>
            {p.earned > 0 && (
              <span
                style={{
                  background: tierBg(p.earned),
                  color: tierColor(p.earned),
                  border: `1px solid ${tierBorder(p.earned)}`,
                  padding: '1px 6px',
                  borderRadius: 3,
                  fontSize: 10,
                  fontWeight: 700,
                  fontFamily: 'ui-monospace, monospace',
                }}
              >
                {t('dossier.tierBadge', { tier: p.earned })}
              </span>
            )}
          </div>
          <p style={{ margin: '2px 0 0', fontSize: 11, color: '#9ca3af' }}>{achievementTrackSubtitle(track.id, track.subtitle, t)}</p>
        </div>
        <div style={{ textAlign: 'right', minWidth: 80 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: isLocked ? '#475569' : currentColor, fontFamily: 'ui-monospace, monospace' }}>
            {p.total.toLocaleString(locale)}
          </div>
          <div style={{ fontSize: 10, color: '#9ca3af' }}>
            {p.next
              ? t('dossier.tierNext', { rank: p.next.rank, left: (p.next.threshold - p.total).toLocaleString(locale) })
              : p.earned > 0
                ? t('dossier.max')
                : t('dossier.tierOne', { value: track.ranks[0].threshold.toLocaleString(locale) })}
          </div>
        </div>
      </div>

      {/* Progress bar between current and next tier */}
      {!isLocked && (
        <div style={{ height: 4, background: '#25282b', borderRadius: 2, overflow: 'hidden', marginBottom: 10 }}>
          <div
            style={{
              width: `${intoPct}%`,
              height: '100%',
              background: currentColor,
              transition: 'width 0.5s ease',
            }}
          />
        </div>
      )}

      {/* Tier squares T1-T10 */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {track.ranks.map((r) => {
          const achieved = p.earned >= r.rank;
          const isCurrent = p.earned === r.rank;
          return (
            <TierSquare
              key={r.rank}
              rank={r.rank}
              name={achievementRankName(track.id, r.rank, r.name, t)}
              desc={achievementRankDesc(track.id, r.threshold, r.desc, t, locale)}
              achieved={achieved}
              isCurrent={isCurrent}
            />
          );
        })}
      </div>
    </div>
  );
}

export default function CmdrDossier(props: Props) {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<'overview' | 'transport' | 'architect' | 'achievements' | 'squadron'>('overview');
  const [sending, setSending] = useState(false);
  const [optimisticSent, setOptimisticSent] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' } | null>(null);

  // Конфиденциальность досье: скрытые блоки сервер не присылает вовсе, поэтому
  // здесь остаётся только решить, показать раздел или заглушку. Владелец
  // всегда видит свои данные целиком.
  const privacy = props.privacy ?? {};
  const own = props.isOwnProfile === true;
  const showBalance = own || privacy.balance !== false;
  const showRanks = own || privacy.ranks !== false;
  const showCargo = own || privacy.cargo !== false;
  const showDeliveries = own || privacy.deliveries !== false;
  const showLocation = own || privacy.location !== false;
  const hiddenBlocks = [
    !showCargo && t('dossier.hiddenCargo'),
    !showDeliveries && t('dossier.hiddenDeliveries'),
    !showBalance && t('dossier.hiddenBalance'),
    !showRanks && t('dossier.hiddenRanks'),
    !showLocation && t('dossier.hiddenLocation'),
  ].filter((item): item is string => Boolean(item));

  const {
    isFriend, hasPending, isPendingIncoming, sendRequest, acceptRequest, rejectRequest, refresh
  } = useFriends(props.currentUserId || null);

  const friendStatus = props.profileUserId && props.currentUserId && props.profileUserId !== props.currentUserId
    ? isFriend(props.profileUserId)
      ? 'friend'
      : isPendingIncoming(props.profileUserId)
      ? 'pending_incoming'
      : hasPending(props.profileUserId) || optimisticSent
      ? 'pending_outgoing'
      : 'none'
    : 'self';

  const showToast = (msg: string, type: 'ok' | 'err') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleSendRequest = async () => {
    if (!props.profileUserId || sending) return;
    setSending(true);
    const { ok, status } = await sendRequest(props.profileUserId);
    setSending(false);
    if (ok) {
      setOptimisticSent(true);
      showToast(t('dossier.toastRequestSent'), 'ok');
    } else if (status === 409) {
      showToast(t('dossier.toastAlreadyFriends'), 'ok');
      refresh();
    } else {
      showToast(t('dossier.toastRequestFailed'), 'err');
    }
  };

  const handleAccept = async () => {
    if (!props.profileUserId || !props.currentUserId) return;
    const ok = await acceptRequest({ requester_id: props.profileUserId, addressee_id: props.currentUserId });
    if (ok) {
      showToast(t('dossier.toastAccepted'), 'ok');
      refresh();
    } else {
      showToast(t('dossier.toastAcceptFailed'), 'err');
    }
  };

  const handleReject = async () => {
    if (!props.profileUserId || !props.currentUserId) return;
    const ok = await rejectRequest({ requester_id: props.profileUserId, addressee_id: props.currentUserId });
    if (ok) {
      showToast(t('dossier.toastRejected'), 'ok');
      refresh();
    } else {
      showToast(t('dossier.toastRejectFailed'), 'err');
    }
  };

  const handleCancel = async () => {
    if (!props.profileUserId || !props.currentUserId) return;
    const ok = await rejectRequest({ requester_id: props.currentUserId, addressee_id: props.profileUserId });
    if (ok) {
      setOptimisticSent(false);
      showToast(t('dossier.toastCancelled'), 'ok');
      refresh();
    } else {
      showToast(t('dossier.toastCancelFailed'), 'err');
    }
  };

  // Используем ВСЕ доставки для точного подсчёта достижений
  const { progress, heroes, totalTiers } = pilotAchievements(
    props.allDeliveries,
    props.architectCount,
    props.hubsCount,
    props.opsCount,
  );

  // Находим ключевые треки для прогресс-баров в Обзоре
  const cargoTrack = progress.find((p) => p.track.id === 'cargo');
  const steelTrack = progress.find((p) => p.track.id === 'steel');
  const titaniumTrack = progress.find((p) => p.track.id === 'titanium');
  const cmmTrack = progress.find((p) => p.track.id === 'cmm');
  const architectTrack = progress.find((p) => p.track.id === 'architect');
  const hubsTrack = progress.find((p) => p.track.id === 'hubs');
  const opsTrack = progress.find((p) => p.track.id === 'ops');

  const maxCommodity = props.commodities[0]?.[1] || 1;

  return (
    <div>
      {/* ── Toast notification ── */}
      {toast && (
        <div style={{
          position: 'fixed', top: 20, right: 20, zIndex: 9999,
          padding: '12px 18px', borderRadius: 6, fontSize: 13, fontWeight: 500,
          background: toast.type === 'ok' ? 'rgba(34,197,94,0.15)' : 'rgba(231,76,60,0.15)',
          border: `1px solid ${toast.type === 'ok' ? '#22c55e' : '#e74c3c'}`,
          color: toast.type === 'ok' ? '#22c55e' : '#e74c3c',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          {toast.type === 'ok' ? <IconCheck size={14} /> : <IconError size={14} />}
          {toast.msg}
        </div>
      )}

      {/* ── Friend action bar ── */}
      {friendStatus !== 'self' && props.profileUserId && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, padding: '10px 14px', background: '#1a1c1e', border: '1px solid #2d3033', borderRadius: 6 }}>
          {friendStatus === 'friend' && (
            <>
              <span style={{ color: '#22c55e', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                <IconCheck size={14} color="#22c55e" /> {t('dossier.youFriends')}
              </span>
              <span style={{ color: '#9ca3af', fontSize: 12 }}>{t('dossier.friendsGoWrite')}</span>
            </>
          )}
          {friendStatus === 'pending_incoming' && (
            <>
              <span style={{ color: '#e67e22', fontSize: 13, fontWeight: 600 }}>{t('dossier.incomingRequest')}</span>
              <button onClick={handleAccept} className="btn btn-cyan" style={{ fontSize: 12, padding: '5px 12px' }}>
                <IconCheck size={12} /> {t('dossier.accept')}
              </button>
              <button onClick={handleReject} className="btn" style={{ fontSize: 12, padding: '5px 12px', borderColor: '#e74c3c', color: '#e74c3c' }}>
                <IconError size={12} /> {t('dossier.reject')}
              </button>
            </>
          )}
          {friendStatus === 'pending_outgoing' && (
            <>
              <span style={{ color: '#9ca3af', fontSize: 13 }}>{t('dossier.requestSentLabel')}</span>
              <button onClick={handleCancel} className="btn" style={{ fontSize: 12, padding: '5px 12px', borderColor: '#e74c3c', color: '#e74c3c' }}>
                {t('dossier.cancel')}
              </button>
            </>
          )}
          {friendStatus === 'none' && (
            <button onClick={handleSendRequest} disabled={sending} className="btn btn-cyan" style={{ fontSize: 13, padding: '6px 16px', opacity: sending ? 0.6 : 1 }}>
              {sending ? t('dossier.sending') : t('dossier.addFriend')}
            </button>
          )}
        </div>
      )}

      <div className="tabs" style={{ marginBottom: 18 }}>
        <button
          type="button"
          className={tab === 'overview' ? 'tab tab-active' : 'tab'}
          onClick={() => setTab('overview')}
        >
          {t('sq.tabOverview')}
        </button>
        <button
          type="button"
          className={tab === 'transport' ? 'tab tab-active' : 'tab'}
          onClick={() => setTab('transport')}
        >
          {t('dossier.tabTransport')}{props.opsCount ? ` (${props.opsCount})` : ''}
        </button>
        <button
          type="button"
          className={tab === 'architect' ? 'tab tab-active' : 'tab'}
          onClick={() => setTab('architect')}
        >
          {t('dossier.tabArchitect')}{props.architectSystems.length ? ` (${props.architectSystems.length})` : ''}
        </button>
        <button
          type="button"
          className={tab === 'achievements' ? 'tab tab-active' : 'tab'}
          onClick={() => setTab('achievements')}
        >
          {t('dossier.tabAchievements')}{totalTiers > 0 ? ` (${totalTiers})` : ''}
        </button>
        <button
          type="button"
          className={tab === 'squadron' ? 'tab tab-active' : 'tab'}
          onClick={() => setTab('squadron')}
        >
          {t('sq.squadron')}
        </button>
      </div>

      {tab === 'overview' && (
        <div>
          {/* ── Stat Grid (Inara style) ── */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
              gap: 12,
              marginBottom: 24,
            }}
          >
            <StatCard
              label={t('sys.colTons')}
              value={props.totalTons.toLocaleString(locale)}
              color="#e67e22"
              icon={<IconAnchor size={14} color="#e67e22" />}
              sub={
                cargoTrack?.next
                  ? t('dossier.tierNext', { rank: cargoTrack.next.rank, left: (cargoTrack.next.threshold - props.totalTons).toLocaleString(locale) })
                  : cargoTrack && cargoTrack.earned > 0
                    ? t('dossier.max')
                    : undefined
              }
            />
            <StatCard
              label={t('dossier.statToSites')}
              value={props.siteTons.toLocaleString(locale)}
              color="#f39c12"
              icon={<IconBuilding size={14} color="#f39c12" />}
              sub={props.totalTons > 0 ? t('dossier.percentOfTotal', { percent: props.siteSharePercent.toFixed(0) }) : undefined}
            />
            <StatCard
              label={t('dossier.statOperations')}
              value={props.opsCount.toLocaleString(locale)}
              color="#f472b6"
              icon={<IconRadio size={14} color="#f472b6" />}
              sub={
                opsTrack?.next
                  ? t('dossier.tierNext', { rank: opsTrack.next.rank, left: (opsTrack.next.threshold - props.opsCount).toLocaleString(locale) })
                  : opsTrack && opsTrack.earned > 0
                    ? t('dossier.max')
                    : undefined
              }
            />
            <StatCard
              label={t('lb.colHubs')}
              value={props.hubsCount}
              color="#22c55e"
              icon={<IconAtlas size={14} color="#22c55e" />}
              sub={
                hubsTrack?.next
                  ? t('dossier.tierNext', { rank: hubsTrack.next.rank, left: String(hubsTrack.next.threshold - props.hubsCount) })
                  : hubsTrack && hubsTrack.earned > 0
                    ? t('dossier.max')
                    : undefined
              }
            />
            <StatCard
              label={t('atlas.tabRoute')}
              value={props.routeCount}
              color="#60a5fa"
              icon={<IconRoute size={14} color="#60a5fa" />}
            />
            <StatCard
              label={t('dossier.statRouteSystems')}
              value={props.routeSystemsVisited}
              color="#60a5fa"
              icon={<IconRoute size={14} color="#60a5fa" />}
              sub={t('dossier.statRouteSystemsSub')}
            />
            <StatCard
              label={t('dossier.statSystemsTotal')}
              value={props.systems.length}
              color="#c4b5fd"
              icon={<IconAtlas size={14} color="#c4b5fd" />}
            />
            <StatCard
              label={t('nav.architect')}
              value={props.architectCount}
              color="#f39c12"
              icon={<IconBuilding size={14} color="#f39c12" />}
              sub={
                architectTrack?.next
                  ? t('dossier.tierNext', { rank: architectTrack.next.rank, left: String(architectTrack.next.threshold - props.architectCount) })
                  : architectTrack && architectTrack.earned > 0
                    ? t('dossier.max')
                    : undefined
              }
            />
          </div>

          {hiddenBlocks.length > 0 && (
            <div
              style={{
                border: '1px solid #323538',
                background: '#17191b',
                borderRadius: 4,
                padding: '10px 14px',
                marginBottom: 24,
                fontSize: 12,
                color: '#9ca3af',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <IconInfo size={14} color="#9ca3af" />
              {t('dossier.hiddenTitle', { blocks: hiddenBlocks.join(', ') })}
            </div>
          )}

          {/* ── Строительный тоннаж: только поставки на площадки проектов ── */}
          {showCargo && (
          <div style={{ marginBottom: 24 }}>
            <SectionHeader title={t('dossier.siteSection')} count={props.siteOpsCount} />
            <div
              style={{
                border: '1px solid #f39c1233',
                background: '#1a1c1e',
                borderRadius: 4,
                padding: '16px 18px',
              }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                  gap: 12,
                  marginBottom: 16,
                }}
              >
                <StatCard
                  label={t('dossier.siteTons')}
                  value={props.siteTons.toLocaleString(locale)}
                  color="#f39c12"
                  icon={<IconBuilding size={14} color="#f39c12" />}
                  sub={t('dossier.siteTonsSub')}
                />
                <StatCard
                  label={t('dossier.totalCargo')}
                  value={props.totalTons.toLocaleString(locale)}
                  color="#e67e22"
                  icon={<IconAnchor size={14} color="#e67e22" />}
                  sub={t('dossier.totalCargoSub')}
                />
                <StatCard
                  label={t('dossier.siteOps')}
                  value={props.siteOpsCount.toLocaleString(locale)}
                  color="#7dd3fc"
                  icon={<IconRadio size={14} color="#7dd3fc" />}
                />
                <StatCard
                  label={t('dossier.siteSystems')}
                  value={props.siteSystems.length}
                  color="#22c55e"
                  icon={<IconAtlas size={14} color="#22c55e" />}
                />
              </div>
              {props.totalTons > 0 && (
                <InaraProgress
                  value={props.siteTons}
                  max={props.totalTons}
                  color="#f39c12"
                  label={t('dossier.siteShare')}
                  sub={t('dossier.siteShareSub', { percent: props.siteSharePercent.toFixed(1), rest: Math.max(0, props.totalTons - props.siteTons).toLocaleString(locale) })}
                />
              )}
              {props.siteSystems.length > 0 && (
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 8,
                    marginTop: props.totalTons > 0 ? 2 : 0,
                  }}
                >
                  {props.siteSystems.slice(0, 8).map(([systemName, tons]) => (
                    <span
                      key={systemName}
                      style={{
                        border: '1px solid #323538',
                        borderRadius: 4,
                        padding: '4px 8px',
                        fontSize: 12,
                        color: '#eeeeee',
                        fontFamily: 'ui-monospace, monospace',
                      }}
                    >
                      {systemName}{' '}
                      <span style={{ color: '#f39c12', fontWeight: 600 }}>{tons.toLocaleString(locale)} {t('dossier.tonsUnit')}</span>
                    </span>
                  ))}
                </div>
              )}
              {props.siteCommodities.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6, letterSpacing: 0.4 }}>
                    {t('dossier.topSiteCommodities')}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {props.siteCommodities.slice(0, 6).map(([commodity, tons]) => (
                      <span
                        key={commodity}
                        style={{
                          border: '1px solid #323538',
                          borderRadius: 4,
                          padding: '4px 8px',
                          fontSize: 12,
                          color: '#eeeeee',
                          fontFamily: 'ui-monospace, monospace',
                        }}
                      >
                        {commodity}{' '}
                        <span style={{ color: '#f39c12', fontWeight: 600 }}>{tons.toLocaleString(locale)} {t('dossier.tonsUnit')}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {props.siteTons === 0 && (
                <div style={{ fontSize: 12, color: '#9ca3af' }}>
                  {t('dossier.siteEmpty')}
                </div>
              )}
            </div>
          </div>
          )}

          {/* ── Frontier CAPI Profile (Inara style) ── */}
          {props.capiProfile && (
            <div style={{ marginBottom: 24 }}>
              <SectionHeader title="Frontier CAPI" />
              <div
                style={{
                  border: '1px solid #e67e2233',
                  background: '#1a1c1e',
                  borderRadius: 4,
                  padding: '16px 18px',
                }}
              >
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                    gap: 12,
                    marginBottom: 16,
                  }}
                >
                  <StatCard
                    label="Combat"
                    value={rankName(RANK_NAMES, props.capiProfile.combat_rank)}
                    color="#e74c3c"
                  />
                  <StatCard
                    label="Trade"
                    value={rankName(RANK_NAMES, props.capiProfile.trade_rank)}
                    color="#f39c12"
                  />
                  <StatCard
                    label="Explore"
                    value={rankName(RANK_NAMES, props.capiProfile.explore_rank)}
                    color="#3b82f6"
                  />
                  <StatCard
                    label="Empire"
                    value={rankName(EMPIRE_RANKS, props.capiProfile.empire_rank)}
                    color="#a855f7"
                  />
                  <StatCard
                    label="Federation"
                    value={rankName(FED_RANKS, props.capiProfile.federation_rank)}
                    color="#3b82f6"
                  />
                  <StatCard
                    label="CQC"
                    value={rankName(RANK_NAMES, props.capiProfile.cqc_rank)}
                    color="#06b6d4"
                  />
                  <StatCard
                    label="CR"
                    value={props.capiProfile.credits?.toLocaleString(locale) ?? '—'}
                    color="#22c55e"
                  />
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '8px 18px',
                    fontSize: 12,
                    color: '#9ca3af',
                    fontFamily: 'ui-monospace, monospace',
                  }}
                >
                  <span>
                    {t('dossier.capiShip')}{' '}
                    <span style={{ color: '#eeeeee' }}>
                      {showLocation ? (props.capiProfile.current_ship ?? '—') : t('dossier.capiHidden')}
                    </span>
                  </span>
                  <span>
                    {t('dossier.capiSystem')}{' '}
                    <span style={{ color: '#eeeeee' }}>
                      {showLocation ? (props.capiProfile.current_system ?? '—') : t('dossier.capiHidden')}
                    </span>
                  </span>
                  <span>
                    {t('dossier.capiStation')}{' '}
                    <span style={{ color: '#eeeeee' }}>
                      {showLocation ? (props.capiProfile.current_station ?? '—') : t('dossier.capiHidden')}
                    </span>
                  </span>
                  {showBalance && props.capiProfile.loan != null && <span>{t('dossier.capiLoan')} <span style={{ color: '#eeeeee' }}>{props.capiProfile.loan.toLocaleString(locale)} CR</span></span>}
                  {showLocation && props.capiProfile.ships && <span>{t('dossier.capiFleet')} <span style={{ color: '#eeeeee' }}>{props.capiProfile.ships.length} {t('dossier.shipsCount', { count: props.capiProfile.ships.length })}</span></span>}
                  {props.capiProfile.last_updated && (
                    <span style={{ marginLeft: 'auto' }}>
                      {t('dossier.capiUpdated')}{' '}
                      <span style={{ color: '#e67e22' }}>
                        {new Date(props.capiProfile.last_updated).toLocaleString(locale)}
                      </span>
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── Exploration, First Discoveries & Pilot Balances ── */}
          {(props.pilotStats || props.capiProfile) && (
            <div style={{ marginBottom: 24 }}>
              <SectionHeader title={t('dossier.secResearch')} />
              <div
                style={{
                  border: '1px solid #3b82f633',
                  background: '#1a1c1e',
                  borderRadius: 4,
                  padding: '16px 18px',
                }}
              >
                {/* 1. Баланс пилота */}
                <div style={{ marginBottom: 16 }}>
                  <div
                    style={{
                      fontFamily: 'ui-monospace, monospace',
                      fontSize: 11,
                      letterSpacing: 1.5,
                      textTransform: 'uppercase',
                      color: '#9ca3af',
                      marginBottom: 10,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <span>{t('dossier.balanceTitle')}</span>
                  </div>
                  {showBalance ? (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                        gap: 12,
                      }}
                    >
                      <StatCard
                        label={t('dossier.balanceCredits')}
                        value={((props.pilotStats?.credits ?? props.capiProfile?.credits ?? 0)).toLocaleString(locale) + ' CR'}
                        color="#22c55e"
                        sub={t('dossier.balanceCreditsSub')}
                      />
                      <StatCard
                        label={t('dossier.balanceArx')}
                        value={((props.pilotStats?.arx ?? 0)).toLocaleString(locale) + ' ARX'}
                        color="#a855f7"
                        sub={t('dossier.balanceArxSub')}
                      />
                      <StatCard
                        label={t('dossier.balanceMerc')}
                        value={((props.pilotStats?.mercenary_coins ?? 0)).toLocaleString(locale)}
                        color="#f59e0b"
                        sub={t('dossier.balanceMercSub')}
                      />
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: '#9ca3af' }}>
                      {t('dossier.balanceHidden')}
                    </div>
                  )}
                </div>

                {/* 2. Первооткрывательство */}
                <div style={{ marginBottom: 16 }}>
                  <div
                    style={{
                      fontFamily: 'ui-monospace, monospace',
                      fontSize: 11,
                      letterSpacing: 1.5,
                      textTransform: 'uppercase',
                      color: '#9ca3af',
                      marginBottom: 10,
                    }}
                  >
                    {t('dossier.discoveriesTitle')}
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                      gap: 12,
                    }}
                  >
                    <StatCard
                      label={t('dossier.statSystemsFirst')}
                      value={((props.pilotStats?.first_discoveries_count ?? 0)).toLocaleString(locale)}
                      color="#3b82f6"
                      sub="First Discovered"
                    />
                    <StatCard
                      label={t('dossier.statPlanetsFirst')}
                      value={((props.pilotStats?.first_mapped_count ?? 0)).toLocaleString(locale)}
                      color="#06b6d4"
                      sub="First Mapped"
                    />
                    <StatCard
                      label={t('dossier.statFootfalls')}
                      value={((props.pilotStats?.first_footfalls_count ?? 0)).toLocaleString(locale)}
                      color="#10b981"
                      sub="First Footfalls"
                    />
                  </div>
                </div>

                {/* 3. Экзобиология и образцы */}
                <div>
                  <div
                    style={{
                      fontFamily: 'ui-monospace, monospace',
                      fontSize: 11,
                      letterSpacing: 1.5,
                      textTransform: 'uppercase',
                      color: '#9ca3af',
                      marginBottom: 10,
                    }}
                  >
                    {t('dossier.exoTitle')}
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                      gap: 12,
                    }}
                  >
                    <StatCard
                      label={t('dossier.statBioSamples')}
                      value={((props.pilotStats?.bio_samples_count ?? 0)).toLocaleString(locale)}
                      color="#10b981"
                      sub="Genuses / Samples"
                    />
                    <StatCard
                      label={t('dossier.statBioSpecies')}
                      value={((props.pilotStats?.bio_species_count ?? 0)).toLocaleString(locale)}
                      color="#84cc16"
                      sub={t('dossier.statBioSpeciesSub')}
                    />
                    <StatCard
                      label={t('dossier.statBioValue')}
                      value={((props.pilotStats?.bio_value_cr ?? 0)).toLocaleString(locale) + ' CR'}
                      color="#eab308"
                      sub={t('dossier.statBioValueSub')}
                    />
                    <StatCard
                      label={t('dossier.statExoRank')}
                      value={EXOBIOLOGIST_RANKS[props.pilotStats?.exobiologist_rank ?? 0] ?? '—'}
                      color="#10b981"
                      sub="Vista Genomics"
                    />
                    <StatCard
                      label={t('dossier.statMercRank')}
                      value={MERCENARY_RANKS[props.pilotStats?.mercenary_rank ?? 0] ?? '—'}
                      color="#ef4444"
                      sub="Odyssey Mercenary"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Quick Progress (Inara style) ── */}
          {totalTiers > 0 && (
            <div
              style={{
                border: '1px solid #323538',
                background: '#1a1c1e',
                borderRadius: 4,
                padding: '16px 18px',
                marginBottom: 24,
              }}
            >
              <div
                style={{
                  fontFamily: 'ui-monospace, monospace',
                  fontSize: 11,
                  letterSpacing: 2,
                  textTransform: 'uppercase',
                  color: '#9ca3af',
                  marginBottom: 14,
                }}
              >
                {t('dossier.tierProgress', { count: totalTiers })}
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                  gap: '0 24px',
                }}
              >
                {cargoTrack && cargoTrack.earned > 0 && (
                  <InaraProgress
                    value={props.totalTons}
                    max={cargoTrack.next?.threshold ?? cargoTrack.current?.threshold ?? 1}
                    color="#e67e22"
                    label={t('dossier.trackExpeditioner')}
                    sub={cargoTrack.next ? t('dossier.tierSub', { tier: cargoTrack.earned, next: cargoTrack.next.rank }) : t('dossier.tierSubMax', { tier: cargoTrack.earned })}
                  />
                )}
                {steelTrack && steelTrack.earned > 0 && (
                  <InaraProgress
                    value={steelTrack.total}
                    max={steelTrack.next?.threshold ?? steelTrack.current?.threshold ?? 1}
                    color="#eeeeee"
                    label={t('dossier.trackSteel')}
                    sub={steelTrack.next ? t('dossier.tierSub', { tier: steelTrack.earned, next: steelTrack.next.rank }) : t('dossier.tierSubMax', { tier: steelTrack.earned })}
                  />
                )}
                {titaniumTrack && titaniumTrack.earned > 0 && (
                  <InaraProgress
                    value={titaniumTrack.total}
                    max={titaniumTrack.next?.threshold ?? titaniumTrack.current?.threshold ?? 1}
                    color="#7dd3fc"
                    label={t('dossier.trackTitanium')}
                    sub={titaniumTrack.next ? t('dossier.tierSub', { tier: titaniumTrack.earned, next: titaniumTrack.next.rank }) : t('dossier.tierSubMax', { tier: titaniumTrack.earned })}
                  />
                )}
                {cmmTrack && cmmTrack.earned > 0 && (
                  <InaraProgress
                    value={cmmTrack.total}
                    max={cmmTrack.next?.threshold ?? cmmTrack.current?.threshold ?? 1}
                    color="#c4b5fd"
                    label={t('dossier.trackComposites')}
                    sub={cmmTrack.next ? t('dossier.tierSub', { tier: cmmTrack.earned, next: cmmTrack.next.rank }) : t('dossier.tierSubMax', { tier: cmmTrack.earned })}
                  />
                )}
                {architectTrack && (architectTrack.earned > 0 || props.architectCount > 0) && (
                  <InaraProgress
                    value={props.architectCount}
                    max={architectTrack.next?.threshold ?? architectTrack.current?.threshold ?? 1}
                    color="#f39c12"
                    label={t('dossier.trackArchitect')}
                    sub={architectTrack.next ? t('dossier.tierSub', { tier: architectTrack.earned, next: architectTrack.next.rank }) : t('dossier.tierSubMax', { tier: architectTrack.earned })}
                  />
                )}
                {hubsTrack && hubsTrack.earned > 0 && (
                  <InaraProgress
                    value={props.hubsCount}
                    max={hubsTrack.next?.threshold ?? hubsTrack.current?.threshold ?? 1}
                    color="#22c55e"
                    label={t('dossier.trackDiscoverer')}
                    sub={hubsTrack.next ? t('dossier.tierSub', { tier: hubsTrack.earned, next: hubsTrack.next.rank }) : t('dossier.tierSubMax', { tier: hubsTrack.earned })}
                  />
                )}
                {opsTrack && opsTrack.earned > 0 && (
                  <InaraProgress
                    value={props.opsCount}
                    max={opsTrack.next?.threshold ?? opsTrack.current?.threshold ?? 1}
                    color="#f472b6"
                    label={t('dossier.trackOperative')}
                    sub={opsTrack.next ? t('dossier.tierSub', { tier: opsTrack.earned, next: opsTrack.next.rank }) : t('dossier.tierSubMax', { tier: opsTrack.earned })}
                  />
                )}
              </div>
            </div>
          )}

          {/* ── Top Systems (Inara table style) ── */}
          {showDeliveries && props.systems.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <SectionHeader title={t('dossier.topSystems')} count={props.systems.length} />
              <div
                style={{
                  border: '1px solid #323538',
                  borderRadius: 4,
                  overflow: 'hidden',
                }}
              >
                <table style={{ margin: 0, fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th style={{ width: 40, textAlign: 'center' }}>#</th>
                      <th>{t('dossier.colSystem')}</th>
                      <th style={{ textAlign: 'right' }}>{t('dossier.colTons')}</th>
                      <th style={{ textAlign: 'right', width: 80 }}>%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {props.systems.slice(0, 10).map(([name, tons], i) => {
                      const pct = props.totalTons > 0 ? (tons / props.totalTons) * 100 : 0;
                      return (
                        <tr key={name}>
                          <td
                            style={{
                              textAlign: 'center',
                              color: '#9ca3af',
                              fontFamily: 'ui-monospace, monospace',
                              fontSize: 11,
                            }}
                          >
                            {i + 1}
                          </td>
                          <td style={{ color: '#eeeeee', fontWeight: 500 }}>{name}</td>
                          <td
                            style={{
                              textAlign: 'right',
                              color: '#e67e22',
                              fontFamily: 'ui-monospace, monospace',
                              fontWeight: 600,
                            }}
                          >
                            {tons.toLocaleString(locale)}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                justifyContent: 'flex-end',
                              }}
                            >
                              <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#9ca3af' }}>
                                {pct.toFixed(1)}%
                              </span>
                              <div
                                style={{
                                  width: 40,
                                  height: 4,
                                  background: '#25282b',
                                  borderRadius: 2,
                                  overflow: 'hidden',
                                }}
                              >
                                <div
                                  style={{
                                    width: `${Math.min(100, pct * 5)}%`,
                                    height: '100%',
                                    background: '#e67e22',
                                  }}
                                />
                              </div>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Top Commodities (Inara bar style) ── */}
          {showDeliveries && props.commodities.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <SectionHeader title={t('dossier.topCommodities')} count={props.commodities.length} />
              <div
                style={{
                  border: '1px solid #323538',
                  borderRadius: 4,
                  padding: '12px 16px',
                  background: '#1a1c1e',
                }}
              >
                {props.commodities.slice(0, 10).map(([name, tons]) => {
                  const pct = maxCommodity > 0 ? (tons / maxCommodity) * 100 : 0;
                  return (
                    <div
                      key={name}
                      style={{
                        marginBottom: 10,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                      }}
                    >
                      <span
                        style={{
                          minWidth: 120,
                          maxWidth: 120,
                          fontSize: 12,
                          color: '#eeeeee',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {name}
                      </span>
                      <div style={{ flex: 1, height: 6, background: '#25282b', borderRadius: 3, overflow: 'hidden' }}>
                        <div
                          style={{
                            width: `${pct}%`,
                            height: '100%',
                            background: '#60a5fa',
                            transition: 'width 0.4s ease',
                          }}
                        />
                      </div>
                      <span
                        style={{
                          minWidth: 70,
                          textAlign: 'right',
                          fontFamily: 'ui-monospace, monospace',
                          fontSize: 11,
                          color: '#9ca3af',
                        }}
                      >
                        {tons.toLocaleString(locale)} {t('dossier.tonsUnit')}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Recent Deliveries (Inara table style) ── */}
          {showDeliveries && props.recent.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <SectionHeader title={t('dossier.recentDeliveries')} count={props.recent.length} />
              <div
                style={{
                  border: '1px solid #323538',
                  borderRadius: 4,
                  overflow: 'hidden',
                }}
              >
                <table style={{ margin: 0, fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th>{t('forum.date')}</th>
                      <th>{t('dossier.colSystem')}</th>
                      <th>{t('atlas.ui.commodityLabel')}</th>
                      <th style={{ textAlign: 'right' }}>{t('dossier.colTons')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {props.recent.slice(0, 15).map((d, i) => (
                      <tr key={i}>
                        <td
                          style={{
                            fontFamily: 'ui-monospace, monospace',
                            fontSize: 11,
                            color: '#9ca3af',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {new Date(d.delivered_at).toLocaleDateString('ru-RU')}
                        </td>
                        <td style={{ color: '#eeeeee' }}>{d.system_name}</td>
                        <td style={{ color: '#9ca3af' }}>{d.commodity}</td>
                        <td
                          style={{
                            textAlign: 'right',
                            color: '#e67e22',
                            fontFamily: 'ui-monospace, monospace',
                            fontWeight: 600,
                          }}
                        >
                          +{d.amount}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Weekly Activity ── */}
          {Object.keys(props.trackTons).length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <SectionHeader
                title={t('dossier.activity7')}
                count={Object.keys(props.trackTons).length}
              />
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 8,
                }}
              >
                {Object.entries(props.trackTons)
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 10)
                  .map(([sys, tons]) => (
                    <span
                      key={sys}
                      style={{
                        padding: '5px 12px',
                        background: '#1a1c1e',
                        border: '1px solid #323538',
                        borderRadius: 3,
                        fontSize: 12,
                        color: '#eeeeee',
                        fontFamily: 'ui-monospace, monospace',
                      }}
                    >
                      {sys}: <strong style={{ color: '#e67e22' }}>{tons.toLocaleString(locale)} {t('dossier.tonsUnit')}</strong>
                    </span>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'transport' && (
        <div>
          {props.cargoKinds.length === 0 || !showCargo ? (
            <div className="card" style={{ margin: 0, padding: 30, textAlign: 'center', color: 'var(--muted)' }}>
              {showCargo ? t('dossier.cargoNone') : t('dossier.cargoHidden')}
            </div>
          ) : null}
      {/* ── Структура перевозок: куда именно ушёл груз ── */}
      {showCargo && props.cargoKinds.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <SectionHeader title={t('dossier.transportSection')} count={props.opsCount} />
          <div
            style={{
              border: '1px solid #323538',
              background: '#1a1c1e',
              borderRadius: 4,
              padding: '16px 18px',
            }}
          >
            <p style={{ margin: '0 0 14px', fontSize: 12, color: '#9ca3af', lineHeight: 1.6 }}>
              {t('dossier.transportLead')}
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {props.cargoKinds.map((entry) => {
                const meta = CARGO_KIND_META[entry.kind];
                const share = props.totalTons > 0 ? (entry.tons / props.totalTons) * 100 : 0;
                return (
                  <div key={entry.kind}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 }}>
                      <span style={{ color: '#eeeeee' }} title={meta ? t(meta.hint) : undefined}>
                        <span
                          style={{
                            display: 'inline-block',
                            width: 8,
                            height: 8,
                            borderRadius: 2,
                            background: meta?.color ?? '#9ca3af',
                            marginRight: 8,
                          }}
                        />
                        {meta ? t(meta.label) : entry.kind}
                        <span style={{ color: '#6b7280', marginLeft: 8, fontSize: 11 }}>
                          {t('dossier.deliveriesCount', { count: entry.ops.toLocaleString(locale) })}
                        </span>
                      </span>
                      <span style={{ color: meta?.color ?? '#9ca3af', fontFamily: 'ui-monospace, monospace' }}>
                        {t('dossier.cargoLine', { tons: entry.tons.toLocaleString(locale), share: share.toFixed(1) })}
                      </span>
                    </div>
                    <div style={{ background: '#25282b', borderRadius: 4, height: 6, marginTop: 6 }}>
                      <div
                        style={{
                          width: `${Math.max(1, Math.min(100, share))}%`,
                          background: meta?.color ?? '#9ca3af',
                          height: '100%',
                          borderRadius: 4,
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            {props.transportSystems.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6, letterSpacing: 0.4 }}>
                  {t('dossier.nonProjectTitle')}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {props.transportSystems.slice(0, 8).map(([systemName, tons]) => (
                    <span
                      key={systemName}
                      style={{
                        border: '1px solid #323538',
                        borderRadius: 4,
                        padding: '4px 8px',
                        fontSize: 12,
                        color: '#eeeeee',
                        fontFamily: 'ui-monospace, monospace',
                      }}
                    >
                      {systemName}{' '}
                      <span style={{ color: '#e67e22', fontWeight: 600 }}>{tons.toLocaleString(locale)} {t('dossier.tonsUnit')}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
        </div>
      )}

      {tab === 'architect' && (
        <div>
          {props.architectCount === 0 && (
            <div className="card" style={{ margin: 0, padding: 30, textAlign: 'center', color: 'var(--muted)' }}>
              {t('dossier.architectEmpty')}
            </div>
          )}
          <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--muted)' }}>
            {t('dossier.architectLead')}
          </p>
      {/* ── Architect Systems (RavenColonial) ── */}
      {props.architectCount > 0 && (
        <div style={{ marginBottom: 24 }}>
          <SectionHeader
            title={t('dossier.architectTitle')}
            count={props.architectSystems.length}
          />
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
            }}
          >
            {props.architectSystems.map((sys) => (
              <Link
                href={`/system/${encodeURIComponent(sys)}`}
                key={sys}
                title={t('dossier.openSystem', { system: sys })}
                className="dossier-arch-link"
                style={{
                  textDecoration: 'none',
                  padding: '5px 12px',
                  background: '#1a1c1e',
                  border: '1px solid #e67e2255',
                  borderRadius: 3,
                  fontSize: 12,
                  color: '#f39c12',
                  fontFamily: 'ui-monospace, monospace',
                  letterSpacing: 0.5,
                }}
              >
                {sys} →
              </Link>
            ))}
          </div>
        </div>
      )}
        </div>
      )}

      {tab === 'achievements' && (
        <div>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
            <h2 style={{ margin: 0, fontSize: 18, color: '#eeeeee' }}>{t('dossier.achievementsTitle')}</h2>
            <span
              style={{
                background: 'rgba(255,157,46,0.15)',
                color: '#e67e22',
                padding: '4px 12px',
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 600,
                fontFamily: 'ui-monospace, monospace',
              }}
            >
              {t('dossier.tiersTotal', { count: totalTiers })}
            </span>
          </div>

          {/* Achievement tracks grid */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
              gap: 12,
              marginBottom: 24,
            }}
          >
            {progress.map((p) => (
              <AchievementTrackCard key={p.track.id} p={p} />
            ))}
          </div>

          {/* Hero badges */}
          {heroes.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <SectionHeader title={t('dossier.heroAwards')} count={heroes.length} />
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
                  gap: 12,
                }}
              >
                {heroes.map((h) => (
                  <div
                    key={h.id}
                    style={{
                      padding: 14,
                      borderRadius: 4,
                      background: 'rgba(251,191,36,0.06)',
                      border: '1px solid rgba(251,191,36,0.25)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                    }}
                  >
                    <span style={{ fontSize: 28, display: 'flex', alignItems: 'center' }}><AchievementIcon icon={h.icon} size={28} /></span>
                    <div>
                      <h4 style={{ margin: '0 0 2px', color: '#f39c12', fontSize: 14 }}>{heroBadgeName(h.trackId, h.name, t)}</h4>
                      <p style={{ margin: 0, fontSize: 11, color: '#9ca3af' }}>{heroBadgeDesc(h.trackId, h.desc, t)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'squadron' && (
        <div>
          {props.squadron ? (
            <>
              {/* Шапка эскадрильи */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16, marginBottom: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <div style={{ width: 12, height: 48, borderRadius: 2, background: props.squadron.color, flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'ui-monospace, monospace', letterSpacing: 1, textTransform: 'uppercase' }}>
                      {props.squadron.tag ? `[${props.squadron.tag}]` : t('sq.squadron')}
                    </div>
                    <h2 style={{ margin: '4px 0 0', color: props.squadron.color }}>{props.squadron.name}</h2>
                    {props.squadron.description && (
                      <p style={{ color: '#9ca3af', marginTop: 6, maxWidth: 600, fontSize: 14, lineHeight: 1.6 }}>
                        {props.squadron.description}
                      </p>
                    )}
                  </div>
                </div>
                <span style={{
                  padding: '4px 12px',
                  borderRadius: 2,
                  fontSize: 11,
                  background: `${props.squadron.color}15`,
                  color: props.squadron.color,
                  fontWeight: 600,
                  fontFamily: 'ui-monospace, monospace',
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                }}>
                  {props.squadron.status === 'active' ? t('dossier.sqActive') : props.squadron.status === 'recruiting' ? t('dossier.sqRecruiting') : props.squadron.status === 'closed' ? t('dossier.sqClosed') : t('dossier.sqDisbanded')}
                </span>
              </div>

              {/* Бейджи параметров */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 10px', marginBottom: 20 }}>
                {props.squadron.allegiance && (
                  <span style={badgeStyle} title={t('dossier.badgeAllegiance')}>
                    <AllegianceIcon allegiance={props.squadron.allegiance} size={12} color="#9ca3af" /> {props.squadron.allegiance}
                  </span>
                )}
                {props.squadron.power && (
                  <span style={{ ...badgeStyle, borderColor: '#e67e2255', color: '#f39c12' }} title={t('dossier.badgePower')}>
                    <IconPower size={12} color="#f39c12" /> {props.squadron.power}
                  </span>
                )}
                {props.squadron.activity_type && props.squadron.activity_type !== 'Mixed' && (
                  <span style={{ ...badgeStyle, borderColor: '#60a5fa55', color: '#60a5fa' }} title={t('dossier.badgeActivity')}>
                    <IconActivity size={12} color="#60a5fa" /> {props.squadron.activity_type}
                  </span>
                )}
                {props.squadron.home_system && (
                  <span style={{ ...badgeStyle, borderColor: '#c4b5fd55', color: '#c4b5fd' }} title={t('dossier.badgeHome')}>
                    <IconHomeSystem size={12} color="#c4b5fd" /> {props.squadron.home_system}
                  </span>
                )}
                {props.squadron.language && (
                  <span style={badgeStyle} title={t('dossier.badgeLanguage')}>
                    <IconLanguage size={12} color="#9ca3af" /> {props.squadron.language}
                  </span>
                )}
                {props.squadron.timezone && (
                  <span style={badgeStyle} title={t('dossier.badgeTimezone')}>
                    <IconTimezone size={12} color="#9ca3af" /> {props.squadron.timezone}
                  </span>
                )}
                {props.squadron.is_open_recruitment && (
                  <span style={{ ...badgeStyle, borderColor: '#22c55e55', color: '#22c55e' }} title={t('dossier.badgeRecruit')}>
                    <IconOpenRecruit size={12} color="#22c55e" /> {t('dossier.openRecruit')}
                  </span>
                )}
                {props.squadron.discord_url && (
                  <a href={props.squadron.discord_url} target="_blank" rel="noreferrer" style={{ ...badgeStyle, borderColor: '#5865F255', color: '#5865F2', textDecoration: 'none' }}>
                    <IconDiscord size={12} color="#5865F2" /> Discord
                  </a>
                )}
                {props.squadron.website_url && (
                  <a href={props.squadron.website_url} target="_blank" rel="noreferrer" style={{ ...badgeStyle, borderColor: '#22c55e55', color: '#22c55e', textDecoration: 'none' }}>
                    <IconWebsite size={12} color="#22c55e" /> {t('dossier.website')}
                  </a>
                )}
              </div>

              {/* Статистика */}
              <div className="stat-grid" style={{ marginBottom: 24 }}>
                <div className="stat-box">
                  <div className="num" style={{ color: props.squadron.color }}>{props.squadron.member_count || 0}</div>
                  <div className="lbl">{t('dossier.sqPilots')}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4, fontFamily: 'ui-monospace, monospace' }}>
                    {t('dossier.sqOf', { count: props.squadron.member_limit || 600 })}
                  </div>
                </div>
                <div className="stat-box">
                  <div className="num" style={{ color: props.squadron.color }}>{props.squadron.project_count || 0}</div>
                  <div className="lbl">{t('dossier.sqProjects')}</div>
                </div>
                <div className="stat-box">
                  <div className="num" style={{ color: props.squadron.color }}>#{props.rank ?? '—'}</div>
                  <div className="lbl">{t('dossier.sqPilotPlace')}</div>
                </div>
              </div>

              {/* Действия */}
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <Link href={`/squadrons/${props.squadron.id}`} className="btn btn-cyan">
                  {t('dossier.sqGo')}
                </Link>
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', padding: '48px 20px', color: '#9ca3af', border: '1px dashed #323538', borderRadius: 8 }}>
              <div style={{
                width: 64, height: 64, borderRadius: '50%', background: '#1a1c1e',
                border: '2px solid #323538', display: 'flex', alignItems: 'center',
                justifyContent: 'center', margin: '0 auto 16px', fontSize: 28,
              }}>
                —
              </div>
              <h3 style={{ color: '#eeeeee', margin: '0 0 8px', fontSize: 16 }}>{t('dossier.sqNone')}</h3>
              <p style={{ margin: 0, fontSize: 13 }}>{t('dossier.sqNoneText')}</p>
              <Link href="/squadrons" className="btn btn-cyan" style={{ marginTop: 16, fontSize: 12 }}>
                {t('dossier.sqFind')}
              </Link>
            </div>
          )}
        </div>
      )}

      <Link href="/leaderboard" className="btn btn-cyan" style={{ marginTop: 18 }}>
        {t('dossier.backToLeaderboard')}
      </Link>
    </div>
  );
}

const badgeStyle: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 3,
  fontSize: 11,
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid #323538',
  color: '#9ca3af',
  fontFamily: 'ui-monospace, monospace',
  whiteSpace: 'nowrap',
};
