'use client';

/**
 * Сводка сборки: то, ради чего верфь и открывают.
 *
 * Показываем не «все поля подряд», а то, по чему принимают решения:
 * дальность прыжка (три цифры — пустой, снаряжённый, весь бак), скорость,
 * щит и броня, баланс энергии и деньги. Предупреждения (не хватает реактора,
 * двигатели не тянут массу) идут первыми: это ошибки сборки.
 *
 * Все подписи — из словаря (`outfitting.stats.*`), числа форматируются по
 * языку интерфейса.
 */

import { useI18n } from '@/lib/i18n/I18nContext';
import type { BuildStats } from '@/lib/outfitting/calc';
import { LABEL, MONO, PANEL, formatters } from './styles';

function Row({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, padding: '3px 0' }}>
      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{label}</span>
      <span style={{ fontSize: 12.5, color: accent ?? 'var(--text)', fontFamily: MONO, textAlign: 'right' }}>
        {value}
        {hint ? <span style={{ color: 'var(--muted)', fontSize: 10.5 }}> {hint}</span> : null}
      </span>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 8, marginTop: 8 }}>
      <div style={{ ...LABEL, marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  );
}

export default function StatsPanel({ stats, shipName }: { stats: BuildStats; shipName: string }) {
  const { t, locale } = useI18n();
  const { num, credits } = formatters(locale);
  const powerRatio = stats.powerCapacity > 0 ? stats.powerDeployed / stats.powerCapacity : 0;
  const powerColor = powerRatio > 1 ? 'var(--red)' : powerRatio > 0.9 ? '#f0b37e' : 'var(--green)';

  const ly = (value: number, digits = 2) => t('outfitting.unit.ly', { value: num(value, digits) });
  const ms = (value: number) => t('outfitting.unit.ms', { value: num(value, 0) });
  const tons = (value: number, digits = 1) => t('outfitting.unit.t', { value: num(value, digits) });
  const mw = (value: number) => t('outfitting.unit.mw', { value: num(value, 2) });

  return (
    <div style={{ ...PANEL, position: 'sticky', top: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1, marginBottom: 2 }}>{shipName}</div>
      <div style={{ ...LABEL, marginBottom: 6 }}>{t('outfitting.stats.summary')}</div>

      {stats.warnings.map((warning) => (
        <div
          key={warning.code}
          style={{
            fontSize: 11, color: '#f0b37e', border: '1px solid rgba(240,179,126,0.4)',
            background: 'rgba(240,179,126,0.08)', borderRadius: 2, padding: '5px 7px', marginBottom: 5, lineHeight: 1.4,
          }}
        >
          ⚠ {t(`outfitting.warn.${warning.code}`, { value: warning.value ?? '' })}
        </div>
      ))}

      <Block title={t('outfitting.stats.jump')}>
        <Row label={t('outfitting.stats.jump.full')} value={ly(stats.jumpRange)} accent="var(--orange)" />
        <Row label={t('outfitting.stats.jump.max')} value={ly(stats.maxJumpRange)} />
        <Row label={t('outfitting.stats.jump.laden')} value={ly(stats.ladenJumpRange)} />
        <Row label={t('outfitting.stats.jump.total')} value={ly(stats.totalRange, 1)} />
      </Block>

      <Block title={t('outfitting.stats.drive')}>
        <Row label={t('outfitting.stats.speed')} value={ms(stats.speed)} hint={t('outfitting.stats.boostHint', { value: num(stats.boost, 0) })} />
        <Row label={t('outfitting.stats.ladenSpeed')} value={ms(stats.ladenSpeed)} hint={t('outfitting.stats.boostHint', { value: num(stats.ladenBoost, 0) })} />
        <Row label={t('outfitting.stats.mass')} value={tons(stats.unladenMass)} hint={t('outfitting.stats.ladenMassHint', { value: num(stats.ladenMass, 1) })} />
        <Row label={t('outfitting.stats.masslock')} value={String(stats.masslock)} />
      </Block>

      <Block title={t('outfitting.stats.defence')}>
        <Row
          label={t('outfitting.stats.shield')}
          value={t('outfitting.unit.mj', { value: num(stats.shield, 0) })}
          accent={stats.shield > 0 ? 'var(--cyan)' : 'var(--muted)'}
        />
        <Row
          label={t('outfitting.stats.shieldRes')}
          value={`${num(stats.shieldResistances.kinetic * 100, 0)}% / ${num(stats.shieldResistances.thermal * 100, 0)}% / ${num(stats.shieldResistances.explosive * 100, 0)}%`}
          hint={t('outfitting.stats.resHint')}
        />
        <Row label={t('outfitting.stats.armour')} value={`${num(stats.armour, 0)}`} accent="var(--text)" />
        <Row
          label={t('outfitting.stats.armourRes')}
          value={`${num(stats.armourResistances.kinetic * 100, 0)}% / ${num(stats.armourResistances.thermal * 100, 0)}% / ${num(stats.armourResistances.explosive * 100, 0)}%`}
          hint={t('outfitting.stats.resHint')}
        />
      </Block>

      <Block title={t('outfitting.stats.power')}>
        <Row label={t('outfitting.stats.powerPlant')} value={mw(stats.powerCapacity)} />
        <Row label={t('outfitting.stats.powerRetracted')} value={mw(stats.powerRetracted)} />
        <Row label={t('outfitting.stats.powerDeployed')} value={mw(stats.powerDeployed)} accent={powerColor} />
        <div style={{ height: 6, background: 'var(--line)', borderRadius: 3, overflow: 'hidden', marginTop: 4 }}>
          <div style={{ width: `${Math.min(100, powerRatio * 100)}%`, height: '100%', background: powerColor }} />
        </div>
        <Row
          label={t('outfitting.stats.distributor')}
          value={`${num(stats.distributor.sys, 1)} / ${num(stats.distributor.eng, 1)} / ${num(stats.distributor.wep, 1)}`}
          hint="SYS/ENG/WEP"
        />
      </Block>

      <Block title={t('outfitting.stats.cargoMoney')}>
        <Row label={t('outfitting.stats.cargo')} value={t('outfitting.unit.t', { value: stats.cargo })} />
        <Row label={t('outfitting.stats.fuel')} value={tons(stats.fuel, 0)} />
        {stats.passengers > 0 && <Row label={t('outfitting.stats.passengers')} value={`${stats.passengers}`} />}
        <Row label={t('outfitting.stats.cost')} value={credits(stats.cost)} accent="var(--orange)" />
        {stats.engineered > 0 && <Row label={t('outfitting.stats.engineered')} value={String(stats.engineered)} accent="var(--green)" />}
        {stats.experimental > 0 && <Row label={t('outfitting.stats.experimental')} value={String(stats.experimental)} accent="#c9a0ff" />}
      </Block>
    </div>
  );
}
