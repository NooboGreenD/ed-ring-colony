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
  totalTons: number;
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
          {value.toLocaleString('ru-RU')} / {max.toLocaleString('ru-RU')}
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
          ({count.toLocaleString('ru-RU')})
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
  const track = p.track;
  const isLocked = p.earned === 0;
  const currentColor = p.earned > 0 ? tierColor(p.earned) : '#475569';
  const prevThreshold = p.earned > 0 ? track.ranks[p.earned - 1].threshold : 0;
  const nextThreshold = p.next?.threshold ?? (p.current?.threshold ?? 1);
  const span = nextThreshold - prevThreshold;
  const intoPct = span > 0 ? Math.min(100, ((p.total - prevThreshold) / span) * 100) : 100;

  const allTiersTooltip = track.ranks
    .map((r) => `T${r.rank}: ${r.name} — ${r.desc}`)
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
              {track.title}
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
                ТИР {p.earned}
              </span>
            )}
          </div>
          <p style={{ margin: '2px 0 0', fontSize: 11, color: '#9ca3af' }}>{track.subtitle}</p>
        </div>
        <div style={{ textAlign: 'right', minWidth: 80 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: isLocked ? '#475569' : currentColor, fontFamily: 'ui-monospace, monospace' }}>
            {p.total.toLocaleString('ru-RU')}
          </div>
          <div style={{ fontSize: 10, color: '#9ca3af' }}>
            {p.next
              ? `до T${p.next.rank}: ${(p.next.threshold - p.total).toLocaleString('ru-RU')}`
              : p.earned > 0
                ? 'МАКС'
                : `T1: ${track.ranks[0].threshold.toLocaleString('ru-RU')}`}
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
              name={r.name}
              desc={r.desc}
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
  const [tab, setTab] = useState<'overview' | 'achievements' | 'squadron'>('overview');
  const [sending, setSending] = useState(false);
  const [optimisticSent, setOptimisticSent] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' } | null>(null);

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
      showToast('Запрос в друзья отправлен', 'ok');
    } else if (status === 409) {
      showToast('Вы уже друзья с этим пилотом', 'ok');
      refresh();
    } else {
      showToast('Не удалось отправить запрос', 'err');
    }
  };

  const handleAccept = async () => {
    if (!props.profileUserId || !props.currentUserId) return;
    const ok = await acceptRequest({ requester_id: props.profileUserId, addressee_id: props.currentUserId });
    if (ok) {
      showToast('Запрос принят! Вы теперь друзья', 'ok');
      refresh();
    } else {
      showToast('Не удалось принять запрос', 'err');
    }
  };

  const handleReject = async () => {
    if (!props.profileUserId || !props.currentUserId) return;
    const ok = await rejectRequest({ requester_id: props.profileUserId, addressee_id: props.currentUserId });
    if (ok) {
      showToast('Запрос отклонён', 'ok');
      refresh();
    } else {
      showToast('Не удалось отклонить запрос', 'err');
    }
  };

  const handleCancel = async () => {
    if (!props.profileUserId || !props.currentUserId) return;
    const ok = await rejectRequest({ requester_id: props.currentUserId, addressee_id: props.profileUserId });
    if (ok) {
      setOptimisticSent(false);
      showToast('Запрос отменён', 'ok');
      refresh();
    } else {
      showToast('Не удалось отменить запрос', 'err');
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
                <IconCheck size={14} color="#22c55e" /> Вы друзья
              </span>
              <span style={{ color: '#9ca3af', fontSize: 12 }}>Перейдите в раздел Друзья, чтобы написать сообщение.</span>
            </>
          )}
          {friendStatus === 'pending_incoming' && (
            <>
              <span style={{ color: '#e67e22', fontSize: 13, fontWeight: 600 }}>Входящий запрос в друзья</span>
              <button onClick={handleAccept} className="btn btn-cyan" style={{ fontSize: 12, padding: '5px 12px' }}>
                <IconCheck size={12} /> Принять
              </button>
              <button onClick={handleReject} className="btn" style={{ fontSize: 12, padding: '5px 12px', borderColor: '#e74c3c', color: '#e74c3c' }}>
                <IconError size={12} /> Отклонить
              </button>
            </>
          )}
          {friendStatus === 'pending_outgoing' && (
            <>
              <span style={{ color: '#9ca3af', fontSize: 13 }}>Запрос в друзья отправлен</span>
              <button onClick={handleCancel} className="btn" style={{ fontSize: 12, padding: '5px 12px', borderColor: '#e74c3c', color: '#e74c3c' }}>
                Отменить
              </button>
            </>
          )}
          {friendStatus === 'none' && (
            <button onClick={handleSendRequest} disabled={sending} className="btn btn-cyan" style={{ fontSize: 13, padding: '6px 16px', opacity: sending ? 0.6 : 1 }}>
              {sending ? 'Отправка...' : '+ Добавить в друзья'}
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
          Обзор
        </button>
        <button
          type="button"
          className={tab === 'achievements' ? 'tab tab-active' : 'tab'}
          onClick={() => setTab('achievements')}
        >
          Достижения{totalTiers > 0 ? ` (${totalTiers})` : ''}
        </button>
        <button
          type="button"
          className={tab === 'squadron' ? 'tab tab-active' : 'tab'}
          onClick={() => setTab('squadron')}
        >
          Эскадрилья
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
              label="Всего тонн"
              value={props.totalTons.toLocaleString('ru-RU')}
              color="#e67e22"
              icon={<IconAnchor size={14} color="#e67e22" />}
              sub={
                cargoTrack?.next
                  ? `до Т${cargoTrack.next.rank}: ${(cargoTrack.next.threshold - props.totalTons).toLocaleString('ru-RU')} т`
                  : cargoTrack && cargoTrack.earned > 0
                    ? 'МАКС'
                    : undefined
              }
            />
            <StatCard
              label="Операций"
              value={props.opsCount.toLocaleString('ru-RU')}
              color="#f472b6"
              icon={<IconRadio size={14} color="#f472b6" />}
              sub={
                opsTrack?.next
                  ? `до Т${opsTrack.next.rank}: ${(opsTrack.next.threshold - props.opsCount).toLocaleString('ru-RU')}`
                  : opsTrack && opsTrack.earned > 0
                    ? 'МАКС'
                    : undefined
              }
            />
            <StatCard
              label="Хабов"
              value={props.hubsCount}
              color="#22c55e"
              icon={<IconAtlas size={14} color="#22c55e" />}
              sub={
                hubsTrack?.next
                  ? `до Т${hubsTrack.next.rank}: ${hubsTrack.next.threshold - props.hubsCount}`
                  : hubsTrack && hubsTrack.earned > 0
                    ? 'МАКС'
                    : undefined
              }
            />
            <StatCard
              label="Маршрут"
              value={props.routeCount}
              color="#60a5fa"
              icon={<IconRoute size={14} color="#60a5fa" />}
            />
            <StatCard
              label="Систем маршрутов"
              value={props.routeSystemsVisited}
              color="#60a5fa"
              icon={<IconRoute size={14} color="#60a5fa" />}
              sub="Уникальных систем маршрутов"
            />
            <StatCard
              label="Систем всего"
              value={props.systems.length}
              color="#c4b5fd"
              icon={<IconAtlas size={14} color="#c4b5fd" />}
            />
            <StatCard
              label="Архитектор"
              value={props.architectCount}
              color="#f39c12"
              icon={<IconBuilding size={14} color="#f39c12" />}
              sub={
                architectTrack?.next
                  ? `до Т${architectTrack.next.rank}: ${architectTrack.next.threshold - props.architectCount}`
                  : architectTrack && architectTrack.earned > 0
                    ? 'МАКС'
                    : undefined
              }
            />
          </div>

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
                Прогресс достижений — {totalTiers} тиров
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
                    label="Экспедиционер"
                    sub={cargoTrack.next ? `Тир ${cargoTrack.earned} → ${cargoTrack.next.rank}` : `Тир ${cargoTrack.earned} (макс)`}
                  />
                )}
                {steelTrack && steelTrack.earned > 0 && (
                  <InaraProgress
                    value={steelTrack.total}
                    max={steelTrack.next?.threshold ?? steelTrack.current?.threshold ?? 1}
                    color="#eeeeee"
                    label="Металлург"
                    sub={steelTrack.next ? `Тир ${steelTrack.earned} → ${steelTrack.next.rank}` : `Тир ${steelTrack.earned} (макс)`}
                  />
                )}
                {titaniumTrack && titaniumTrack.earned > 0 && (
                  <InaraProgress
                    value={titaniumTrack.total}
                    max={titaniumTrack.next?.threshold ?? titaniumTrack.current?.threshold ?? 1}
                    color="#7dd3fc"
                    label="Титановый мастер"
                    sub={titaniumTrack.next ? `Тир ${titaniumTrack.earned} → ${titaniumTrack.next.rank}` : `Тир ${titaniumTrack.earned} (макс)`}
                  />
                )}
                {cmmTrack && cmmTrack.earned > 0 && (
                  <InaraProgress
                    value={cmmTrack.total}
                    max={cmmTrack.next?.threshold ?? cmmTrack.current?.threshold ?? 1}
                    color="#c4b5fd"
                    label="Композитчик"
                    sub={cmmTrack.next ? `Тир ${cmmTrack.earned} → ${cmmTrack.next.rank}` : `Тир ${cmmTrack.earned} (макс)`}
                  />
                )}
                {architectTrack && (architectTrack.earned > 0 || props.architectCount > 0) && (
                  <InaraProgress
                    value={props.architectCount}
                    max={architectTrack.next?.threshold ?? architectTrack.current?.threshold ?? 1}
                    color="#f39c12"
                    label="Архитектор"
                    sub={architectTrack.next ? `Тир ${architectTrack.earned} → ${architectTrack.next.rank}` : `Тир ${architectTrack.earned} (макс)`}
                  />
                )}
                {hubsTrack && hubsTrack.earned > 0 && (
                  <InaraProgress
                    value={props.hubsCount}
                    max={hubsTrack.next?.threshold ?? hubsTrack.current?.threshold ?? 1}
                    color="#22c55e"
                    label="Первооткрыватель"
                    sub={hubsTrack.next ? `Тир ${hubsTrack.earned} → ${hubsTrack.next.rank}` : `Тир ${hubsTrack.earned} (макс)`}
                  />
                )}
                {opsTrack && opsTrack.earned > 0 && (
                  <InaraProgress
                    value={props.opsCount}
                    max={opsTrack.next?.threshold ?? opsTrack.current?.threshold ?? 1}
                    color="#f472b6"
                    label="Оперативник"
                    sub={opsTrack.next ? `Тир ${opsTrack.earned} → ${opsTrack.next.rank}` : `Тир ${opsTrack.earned} (макс)`}
                  />
                )}
              </div>
            </div>
          )}

          {/* ── Architect Systems (RavenColonial) ── */}
          {props.architectCount > 0 && (
            <div style={{ marginBottom: 24 }}>
              <SectionHeader
                title="Системы архитектора"
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
                  <span
                    key={sys}
                    style={{
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
                    {sys}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* ── Top Systems (Inara table style) ── */}
          {props.systems.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <SectionHeader title="Топ систем по доставкам" count={props.systems.length} />
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
                      <th>Система</th>
                      <th style={{ textAlign: 'right' }}>Тонн</th>
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
                            {tons.toLocaleString('ru-RU')}
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
          {props.commodities.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <SectionHeader title="Топ товаров" count={props.commodities.length} />
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
                        {tons.toLocaleString('ru-RU')} т
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Recent Deliveries (Inara table style) ── */}
          {props.recent.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <SectionHeader title="Последние доставки" count={props.recent.length} />
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
                      <th>Дата</th>
                      <th>Система</th>
                      <th>Товар</th>
                      <th style={{ textAlign: 'right' }}>Тонн</th>
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
                title="Активность за 7 дней"
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
                      {sys}: <strong style={{ color: '#e67e22' }}>{tons.toLocaleString('ru-RU')} т</strong>
                    </span>
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
            <h2 style={{ margin: 0, fontSize: 18, color: '#eeeeee' }}>Достижения</h2>
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
              Всего тиров: {totalTiers}
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
              <SectionHeader title="Геройские награды" count={heroes.length} />
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
                      <h4 style={{ margin: '0 0 2px', color: '#f39c12', fontSize: 14 }}>{h.name}</h4>
                      <p style={{ margin: 0, fontSize: 11, color: '#9ca3af' }}>{h.desc}</p>
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
                      {props.squadron.tag ? `[${props.squadron.tag}]` : 'Эскадрилья'}
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
                  {props.squadron.status === 'active' ? 'Активна' : props.squadron.status === 'recruiting' ? 'Набор' : props.squadron.status === 'closed' ? 'Закрыта' : 'Расформирована'}
                </span>
              </div>

              {/* Бейджи параметров */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 10px', marginBottom: 20 }}>
                {props.squadron.allegiance && (
                  <span style={badgeStyle} title="Принадлежность">
                    <AllegianceIcon allegiance={props.squadron.allegiance} size={12} color="#9ca3af" /> {props.squadron.allegiance}
                  </span>
                )}
                {props.squadron.power && (
                  <span style={{ ...badgeStyle, borderColor: '#e67e2255', color: '#f39c12' }} title="Сила (Power)">
                    <IconPower size={12} color="#f39c12" /> {props.squadron.power}
                  </span>
                )}
                {props.squadron.activity_type && props.squadron.activity_type !== 'Mixed' && (
                  <span style={{ ...badgeStyle, borderColor: '#60a5fa55', color: '#60a5fa' }} title="Тип активности">
                    <IconActivity size={12} color="#60a5fa" /> {props.squadron.activity_type}
                  </span>
                )}
                {props.squadron.home_system && (
                  <span style={{ ...badgeStyle, borderColor: '#c4b5fd55', color: '#c4b5fd' }} title="Домашняя система">
                    <IconHomeSystem size={12} color="#c4b5fd" /> {props.squadron.home_system}
                  </span>
                )}
                {props.squadron.language && (
                  <span style={badgeStyle} title="Язык">
                    <IconLanguage size={12} color="#9ca3af" /> {props.squadron.language}
                  </span>
                )}
                {props.squadron.timezone && (
                  <span style={badgeStyle} title="Часовой пояс">
                    <IconTimezone size={12} color="#9ca3af" /> {props.squadron.timezone}
                  </span>
                )}
                {props.squadron.is_open_recruitment && (
                  <span style={{ ...badgeStyle, borderColor: '#22c55e55', color: '#22c55e' }} title="Набор">
                    <IconOpenRecruit size={12} color="#22c55e" /> Свободный набор
                  </span>
                )}
                {props.squadron.discord_url && (
                  <a href={props.squadron.discord_url} target="_blank" rel="noreferrer" style={{ ...badgeStyle, borderColor: '#5865F255', color: '#5865F2', textDecoration: 'none' }}>
                    <IconDiscord size={12} color="#5865F2" /> Discord
                  </a>
                )}
                {props.squadron.website_url && (
                  <a href={props.squadron.website_url} target="_blank" rel="noreferrer" style={{ ...badgeStyle, borderColor: '#22c55e55', color: '#22c55e', textDecoration: 'none' }}>
                    <IconWebsite size={12} color="#22c55e" /> Сайт
                  </a>
                )}
              </div>

              {/* Статистика */}
              <div className="stat-grid" style={{ marginBottom: 24 }}>
                <div className="stat-box">
                  <div className="num" style={{ color: props.squadron.color }}>{props.squadron.member_count || 0}</div>
                  <div className="lbl">Пилотов</div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4, fontFamily: 'ui-monospace, monospace' }}>
                    из {props.squadron.member_limit || 600}
                  </div>
                </div>
                <div className="stat-box">
                  <div className="num" style={{ color: props.squadron.color }}>{props.squadron.project_count || 0}</div>
                  <div className="lbl">Проектов</div>
                </div>
                <div className="stat-box">
                  <div className="num" style={{ color: props.squadron.color }}>#{props.rank ?? '—'}</div>
                  <div className="lbl">Место пилота</div>
                </div>
              </div>

              {/* Действия */}
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <Link href={`/squadrons/${props.squadron.id}`} className="btn btn-cyan">
                  Перейти к эскадрилье
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
              <h3 style={{ color: '#eeeeee', margin: '0 0 8px', fontSize: 16 }}>Нет эскадрильи</h3>
              <p style={{ margin: 0, fontSize: 13 }}>Пилот не состоит в эскадрилье</p>
              <Link href="/squadrons" className="btn btn-cyan" style={{ marginTop: 16, fontSize: 12 }}>
                Найти эскадрилью
              </Link>
            </div>
          )}
        </div>
      )}

      <Link href="/leaderboard" className="btn btn-cyan" style={{ marginTop: 18 }}>
        ← К лидерборду
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
