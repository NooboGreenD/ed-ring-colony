'use client';

/**
 * Сводка сборки: то, ради чего верфь и открывают.
 *
 * Показываем не «все поля подряд», а то, по чему принимают решения:
 * дальность прыжка (три цифры — пустой, снаряжённый, весь бак), скорость,
 * щит и броня, баланс энергии и деньги. Предупреждения (не хватает реактора,
 * двигатели не тянут массу) идут первыми: это ошибки сборки.
 */

import type { BuildStats } from '@/lib/outfitting/calc';
import { LABEL, MONO, PANEL, credits, num } from './styles';

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
  const powerRatio = stats.powerCapacity > 0 ? stats.powerDeployed / stats.powerCapacity : 0;
  const powerColor = powerRatio > 1 ? 'var(--red)' : powerRatio > 0.9 ? '#f0b37e' : 'var(--green)';

  return (
    <div style={{ ...PANEL, position: 'sticky', top: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1, marginBottom: 2 }}>{shipName}</div>
      <div style={{ ...LABEL, marginBottom: 6 }}>сводка сборки</div>

      {stats.warnings.map((warning) => (
        <div
          key={warning}
          style={{
            fontSize: 11, color: '#f0b37e', border: '1px solid rgba(240,179,126,0.4)',
            background: 'rgba(240,179,126,0.08)', borderRadius: 2, padding: '5px 7px', marginBottom: 5, lineHeight: 1.4,
          }}
        >
          ⚠ {warning}
        </div>
      ))}

      <Block title="прыжок">
        <Row label="Полный бак" value={`${num(stats.jumpRange, 2)} св. лет`} accent="var(--orange)" />
        <Row label="Максимум (на остатке)" value={`${num(stats.maxJumpRange, 2)} св. лет`} />
        <Row label="С грузом" value={`${num(stats.ladenJumpRange, 2)} св. лет`} />
        <Row label="Запас хода" value={`${num(stats.totalRange, 1)} св. лет`} />
      </Block>

      <Block title="ход">
        <Row label="Скорость" value={`${num(stats.speed, 0)} м/с`} hint={`буст ${num(stats.boost, 0)}`} />
        <Row label="С грузом" value={`${num(stats.ladenSpeed, 0)} м/с`} hint={`буст ${num(stats.ladenBoost, 0)}`} />
        <Row label="Масса" value={`${num(stats.unladenMass, 1)} т`} hint={`снар. ${num(stats.ladenMass, 1)} т`} />
        <Row label="Масс-лок" value={String(stats.masslock)} />
      </Block>

      <Block title="защита">
        <Row label="Щит" value={`${num(stats.shield, 0)} MJ`} accent={stats.shield > 0 ? 'var(--cyan)' : 'var(--muted)'} />
        <Row
          label="Сопр. щита"
          value={`${num(stats.shieldResistances.kinetic * 100, 0)}% / ${num(stats.shieldResistances.thermal * 100, 0)}% / ${num(stats.shieldResistances.explosive * 100, 0)}%`}
          hint="кин/терм/взр"
        />
        <Row label="Броня" value={`${num(stats.armour, 0)}`} accent="var(--text)" />
        <Row
          label="Сопр. брони"
          value={`${num(stats.armourResistances.kinetic * 100, 0)}% / ${num(stats.armourResistances.thermal * 100, 0)}% / ${num(stats.armourResistances.explosive * 100, 0)}%`}
          hint="кин/терм/взр"
        />
      </Block>

      <Block title="энергия">
        <Row label="Реактор" value={`${num(stats.powerCapacity, 2)} МВт`} />
        <Row label="В походе" value={`${num(stats.powerRetracted, 2)} МВт`} />
        <Row label="В бою" value={`${num(stats.powerDeployed, 2)} МВт`} accent={powerColor} />
        <div style={{ height: 6, background: 'var(--line)', borderRadius: 3, overflow: 'hidden', marginTop: 4 }}>
          <div style={{ width: `${Math.min(100, powerRatio * 100)}%`, height: '100%', background: powerColor }} />
        </div>
        <Row
          label="Распределитель"
          value={`${num(stats.distributor.sys, 1)} / ${num(stats.distributor.eng, 1)} / ${num(stats.distributor.wep, 1)}`}
          hint="SYS/ENG/WEP"
        />
      </Block>

      <Block title="трюм и деньги">
        <Row label="Груз" value={`${stats.cargo} т`} />
        <Row label="Топливо" value={`${num(stats.fuel, 0)} т`} />
        {stats.passengers > 0 && <Row label="Пассажиры" value={`${stats.passengers}`} />}
        <Row label="Стоимость" value={credits(stats.cost)} accent="var(--orange)" />
        {stats.engineered > 0 && <Row label="Доработано модулей" value={String(stats.engineered)} accent="var(--green)" />}
      </Block>
    </div>
  );
}
