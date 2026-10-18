"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import type { CarrierView } from "@/lib/fleetCarriers";
import { systemPageHref } from "@/lib/systemIdentity";

/**
 * Карточка авианосца: статус, система и прыжок, службы, трюм поимённо, рынок.
 * Одна разметка для личного носителя (профиль) и эскадренного (эскадрилья).
 */

const PANEL = { background: "#1e2124", border: "1px solid #2d3033", borderRadius: 8, padding: 16 } as const;
const MUTED = "#9ca3af";
const DIM = "#6b7280";
const TEXT = "#eeeeee";
const ORANGE = "#e67e22";
const CYAN = "#3498db";
const GREEN = "#2ecc71";
const RED = "#e74c3c";

const nf = new Intl.NumberFormat("ru-RU");

function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });
}

/** «5 мин назад», «через 12 мин». */
export function relativeTime(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  const diff = Math.round((ms - now) / 60000);
  const abs = Math.abs(diff);
  const text = abs < 1 ? "меньше минуты" : abs < 60 ? `${abs} мин` : abs < 48 * 60 ? `${Math.round(abs / 60)} ч` : `${Math.round(abs / 1440)} дн`;
  return diff >= 0 ? `через ${text}` : `${text} назад`;
}

function sourceLabel(source: string | null): string {
  switch (source) {
    case "Market": return "по рынку";
    case "CarrierStats": return "трюм был пуст";
    case "CarrierBuy": return "покупка носителя";
    case "capi": return "Frontier CAPI";
    default: return "по журналам";
  }
}

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: DIM }}>{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

function Chip({ children, color = MUTED, title }: { children: ReactNode; color?: string; title?: string }) {
  return (
    <span title={title} style={{
      display: "inline-block", fontSize: 11, padding: "2px 8px", margin: "0 6px 6px 0", borderRadius: 10,
      border: `1px solid ${color}55`, color, background: `${color}14`,
    }}>{children}</span>
  );
}

export default function CarrierCard({ carrier, actions }: { carrier: CarrierView; actions?: ReactNode }) {
  const squadron = carrier.type === "SquadronCarrier";
  const title = carrier.name || carrier.callsign || `FC ${carrier.carrierId}`;
  const space = carrier.space;
  const capacity = space?.cargoCapacity ?? null;
  const stored = space?.cargo ?? null;
  const fill = capacity && stored != null ? Math.max(0, Math.min(100, Math.round((stored / capacity) * 100))) : null;
  const cargo = carrier.cargo;
  const untracked = cargo && stored != null && space?.statsAt && cargo.updatedAt
    && Date.parse(space.statsAt) >= Date.parse(cargo.updatedAt) - 60_000
    ? Math.max(0, stored - cargo.trackedTotal) : null;
  const marketItems = carrier.market?.items ?? [];
  const selling = marketItems.filter((item) => Number(item.stock ?? 0) > 0);
  const buying = marketItems.filter((item) => Number(item.demand ?? 0) > 0);

  return (
    <div style={PANEL}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 16, color: TEXT, fontWeight: 600 }}>{title}</div>
          <div style={{ fontSize: 12, color: MUTED, marginTop: 2, fontFamily: "ui-monospace, monospace" }}>
            {carrier.callsign && carrier.callsign !== title ? `${carrier.callsign} · ` : ""}ID {carrier.carrierId}
          </div>
          <div style={{ marginTop: 6 }}>
            <Chip color={squadron ? ORANGE : CYAN}>{squadron ? "Эскадренный (Javelin)" : "Личный (Drake)"}</Chip>
            {carrier.relation === "own" && <Chip color={GREEN} title={carrier.ownerSource === "manual" ? "Привязан вручную" : "Подтверждён журналом"}>
              ваш носитель{carrier.ownerSource === "manual" ? " · вручную" : ""}</Chip>}
            {carrier.relation === "squadron" && <Chip color={ORANGE}>носитель эскадрильи</Chip>}
            {carrier.status.pendingDecommission && <Chip color={RED}>списывается</Chip>}
          </div>
        </div>
        {actions && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{actions}</div>}
      </div>

      <Section title="Где находится">
        <div style={{ fontSize: 14, color: TEXT }}>
          {carrier.location.system
            ? <>{carrier.location.estimated ? "≈ " : ""}<Link href={systemPageHref(carrier.location.system)} title="Карточка системы" style={{ color: "inherit" }}><b>{carrier.location.system}</b></Link>{carrier.location.body ? <span style={{ color: MUTED }}> · {carrier.location.body}</span> : null}</>
            : <span style={{ color: MUTED }}>неизвестно — нужна стыковка или запуск игры с Colonial Helper</span>}
        </div>
        <div style={{ fontSize: 11, color: DIM, marginTop: 2 }}>
          {carrier.location.estimated
            ? `прыжок из ${carrier.location.previousSystem ?? "—"} должен был завершиться; подтверждения ещё нет`
            : carrier.location.at ? `данные от ${formatTime(carrier.location.at)} (${relativeTime(carrier.location.at)})` : ""}
        </div>
        {carrier.jump && (
          <div style={{ marginTop: 6, fontSize: 13, color: ORANGE }}>
            {carrier.jump.state === "jumping" ? "В прыжке → " : "Запланирован прыжок → "}
            <Link href={systemPageHref(carrier.jump.system)} title="Карточка системы" style={{ color: "inherit" }}><b>{carrier.jump.system}</b></Link>{carrier.jump.body ? ` · ${carrier.jump.body}` : ""}
            {carrier.jump.departureAt && carrier.jump.state === "scheduled"
              ? <span style={{ color: MUTED }}> · вылет {formatTime(carrier.jump.departureAt)} ({relativeTime(carrier.jump.departureAt)})</span> : null}
          </div>
        )}
      </Section>

      <Section title="Статус">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "4px 16px", fontSize: 12 }}>
          <span style={{ color: DIM }}>Стыковка: <span style={{ color: TEXT }}>{carrier.status.dockingLabel ?? "—"}</span>
            {carrier.status.allowNotorious ? <span style={{ color: RED }}> · преступники</span> : null}</span>
          <span style={{ color: DIM }}>Тритий: <span style={{ color: TEXT }}>{carrier.status.fuelLevel != null ? `${nf.format(carrier.status.fuelLevel)} т` : "—"}</span></span>
          <span style={{ color: DIM }}>Дальность: <span style={{ color: TEXT }}>
            {carrier.status.jumpRangeCurr != null ? `${Math.round(carrier.status.jumpRangeCurr)} / ${Math.round(carrier.status.jumpRangeMax ?? 500)} св. лет` : "—"}</span></span>
          {carrier.finance && (
            <span style={{ color: DIM }}>Баланс: <span style={{ color: TEXT }}>
              {nf.format(Number(carrier.finance.carrier_balance ?? carrier.finance.available_balance ?? 0))} CR</span></span>
          )}
        </div>
        {carrier.status.statsAt
          ? <div style={{ fontSize: 11, color: DIM, marginTop: 4 }}>CarrierStats: {formatTime(carrier.status.statsAt)} ({relativeTime(carrier.status.statsAt)})</div>
          : <div style={{ fontSize: 11, color: DIM, marginTop: 4 }}>Откройте управление носителем в игре (Carrier Management) — Helper передаст статус и службы.</div>}
      </Section>

      {carrier.services.length > 0 && (
        <Section title="Службы">
          <div>
            {carrier.services.map((service) => (
              <Chip key={service.role}
                color={!service.activated ? DIM : service.enabled ? GREEN : ORANGE}
                title={!service.activated ? "не установлена" : service.enabled ? "работает" : "приостановлена"}>
                {service.label}{service.activated && !service.enabled ? " (пауза)" : ""}
              </Chip>
            ))}
          </div>
        </Section>
      )}

      {cargo && (
        <Section title="Трюм" right={cargo.updatedAt ? <span style={{ fontSize: 11, color: DIM }}>обновлено {relativeTime(cargo.updatedAt)}</span> : null}>
          {capacity != null && stored != null && (
            <>
              <div style={{ fontSize: 13, color: TEXT, marginBottom: 4 }}>
                {nf.format(stored)} / {nf.format(capacity)} т <span style={{ color: MUTED }}>· свободно {nf.format(space?.freeSpace ?? 0)} т</span>
              </div>
              <div style={{ background: "#323538", borderRadius: 6, height: 8, overflow: "hidden" }}>
                <div style={{ width: `${fill ?? 0}%`, height: "100%", background: (fill ?? 0) < 80 ? GREEN : (fill ?? 0) < 100 ? "#f1c40f" : RED }} />
              </div>
            </>
          )}
          {cargo.items.length > 0 ? (
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 8, fontSize: 12 }}>
              <thead>
                <tr style={{ color: DIM, textAlign: "left" }}>
                  <th style={{ padding: "4px 0", fontWeight: 400 }}>Товар</th>
                  <th style={{ padding: "4px 0", fontWeight: 400, textAlign: "right" }}>Тонн</th>
                  <th style={{ padding: "4px 0 4px 12px", fontWeight: 400 }}>Основа</th>
                </tr>
              </thead>
              <tbody>
                {cargo.items.map((item) => (
                  <tr key={item.commodity} style={{ borderTop: "1px solid #2d3033" }}>
                    <td style={{ padding: "4px 0", color: TEXT }}>{item.name}</td>
                    <td style={{ padding: "4px 0", color: ORANGE, textAlign: "right", fontFamily: "ui-monospace, monospace" }}>{nf.format(item.quantity)}</td>
                    <td style={{ padding: "4px 0 4px 12px", color: DIM }} title={item.baselineAt ? `снимок ${formatTime(item.baselineAt)}` : undefined}>
                      {item.baselineAt ? sourceLabel(item.baselineSource) : "по журналам"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>Поимённо груз пока не учтён.</div>
          )}
          <div style={{ fontSize: 11, color: DIM, marginTop: 6 }}>
            Учтено поимённо: {nf.format(cargo.trackedTotal)} т
            {untracked ? ` · ещё ${nf.format(untracked)} т на борту без разбивки по товарам` : ""}
            {cargo.baselineAt ? ` · полный снимок трюма ${formatTime(cargo.baselineAt)}` : ""}
          </div>
        </Section>
      )}

      {(carrier.market || carrier.orders.length > 0) && (
        <Section title="Рынок" right={carrier.market ? <span style={{ fontSize: 11, color: DIM }}>снимок {relativeTime(carrier.market.observedAt)}</span> : null}>
          {carrier.market ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, fontSize: 12 }}>
              <div>
                <div style={{ color: GREEN, marginBottom: 4 }}>Продаёт</div>
                {selling.length ? selling.map((item) => (
                  <div key={`s-${item.name}`} style={{ display: "flex", justifyContent: "space-between", color: TEXT }}>
                    <span>{item.name}</span>
                    <span style={{ fontFamily: "ui-monospace, monospace", color: MUTED }}>{nf.format(Number(item.stock))} т · {nf.format(Number(item.buyPrice ?? 0))} CR</span>
                  </div>
                )) : <div style={{ color: DIM }}>—</div>}
              </div>
              <div>
                <div style={{ color: CYAN, marginBottom: 4 }}>Покупает</div>
                {buying.length ? buying.map((item) => (
                  <div key={`b-${item.name}`} style={{ display: "flex", justifyContent: "space-between", color: TEXT }}>
                    <span>{item.name}</span>
                    <span style={{ fontFamily: "ui-monospace, monospace", color: MUTED }}>{nf.format(Number(item.demand))} т · {nf.format(Number(item.sellPrice ?? 0))} CR</span>
                  </div>
                )) : <div style={{ color: DIM }}>—</div>}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12 }}>
              {carrier.orders.map((order) => (
                <div key={order.commodity} style={{ display: "flex", justifyContent: "space-between", color: TEXT }}>
                  <span>{order.name}</span>
                  <span style={{ color: MUTED, fontFamily: "ui-monospace, monospace" }}>
                    {order.sale ? `продажа ${nf.format(order.sale)} т` : ""}{order.purchase ? `закупка ${nf.format(order.purchase)} т` : ""}
                    {order.price ? ` · ${nf.format(order.price)} CR` : ""}
                  </span>
                </div>
              ))}
              <div style={{ fontSize: 11, color: DIM, marginTop: 4 }}>Ордера по журналу владельца; актуальные остатки появятся после открытия рынка носителя с Colonial Helper.</div>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}
