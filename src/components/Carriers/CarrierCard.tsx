"use client";

import type { ReactNode } from "react";
import { useMemo } from "react";
import Link from "next/link";
import type { CarrierView } from "@/lib/fleetCarriers";
import { systemPageHref } from "@/lib/systemIdentity";
import { useI18n } from "@/lib/i18n/I18nContext";

/**
 * Карточка авианосца: статус, система и прыжок, службы, трюм поимённо, рынок.
 * Одна разметка для личного носителя (профиль) и эскадренного (эскадрилья).
 */

type TFunc = (key: string, params?: Record<string, string | number>) => string;

const PANEL = { background: "#1e2124", border: "1px solid #2d3033", borderRadius: 8, padding: 16 } as const;
const MUTED = "#9ca3af";
const DIM = "#6b7280";
const TEXT = "#eeeeee";
const ORANGE = "#e67e22";
const CYAN = "#3498db";
const GREEN = "#2ecc71";
const RED = "#e74c3c";

function formatTime(locale: string, value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
}

/** «5 мин назад», «через 12 мин». */
export function relativeTime(t: TFunc, value: string | null | undefined, now = Date.now()): string {
  if (!value) return "";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return "";
  const diff = Math.round((ms - now) / 60000);
  const abs = Math.abs(diff);
  const text = abs < 1 ? t("fc.lessThanMinute")
    : abs < 60 ? t("fc.minutes", { count: abs })
      : abs < 48 * 60 ? t("fc.hours", { count: Math.round(abs / 60) })
        : t("fc.days", { count: Math.round(abs / 1440) });
  return diff >= 0 ? t("fc.inFuture", { text }) : t("fc.ago", { text });
}

function sourceLabel(t: TFunc, source: string | null): string {
  switch (source) {
    case "Market": return t("fc.srcMarket");
    case "CarrierStats": return t("fc.srcEmpty");
    case "CarrierBuy": return t("fc.srcBuy");
    case "capi": return t("fc.srcCapi");
    default: return t("fc.byLogs");
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
  const { t, locale } = useI18n();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
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
            <Chip color={squadron ? ORANGE : CYAN}>{squadron ? t("fc.squadron") : t("fc.personal")}</Chip>
            {carrier.relation === "own" && <Chip color={GREEN} title={carrier.ownerSource === "manual" ? t("fc.ownManualTitle") : t("fc.ownLogTitle")}>
              {t("fc.ownCarrier")}{carrier.ownerSource === "manual" ? t("fc.ownManualSuffix") : ""}</Chip>}
            {carrier.relation === "squadron" && <Chip color={ORANGE}>{t("fc.squadronCarrier")}</Chip>}
            {carrier.status.pendingDecommission && <Chip color={RED}>{t("fc.decommission")}</Chip>}
          </div>
        </div>
        {actions && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{actions}</div>}
      </div>

      <Section title={t("fc.sectionWhere")}>
        <div style={{ fontSize: 14, color: TEXT }}>
          {carrier.location.system
            ? <>{carrier.location.estimated ? "≈ " : ""}<Link href={systemPageHref(carrier.location.system)} title={t("stn.systemCard")} style={{ color: "inherit" }}><b>{carrier.location.system}</b></Link>{carrier.location.body ? <span style={{ color: MUTED }}> · {carrier.location.body}</span> : null}</>
            : <span style={{ color: MUTED }}>{t("fc.locationUnknown")}</span>}
        </div>
        <div style={{ fontSize: 11, color: DIM, marginTop: 2 }}>
          {carrier.location.estimated
            ? t("fc.jumpPending", { system: carrier.location.previousSystem ?? "—" })
            : carrier.location.at ? t("fc.dataFrom", { time: formatTime(locale, carrier.location.at), ago: relativeTime(t, carrier.location.at) }) : ""}
        </div>
        {carrier.jump && (
          <div style={{ marginTop: 6, fontSize: 13, color: ORANGE }}>
            {carrier.jump.state === "jumping" ? t("fc.jumping") : t("fc.jumpScheduled")}
            <Link href={systemPageHref(carrier.jump.system)} title={t("stn.systemCard")} style={{ color: "inherit" }}><b>{carrier.jump.system}</b></Link>{carrier.jump.body ? ` · ${carrier.jump.body}` : ""}
            {carrier.jump.departureAt && carrier.jump.state === "scheduled"
              ? <span style={{ color: MUTED }}>{t("fc.departure", { time: formatTime(locale, carrier.jump.departureAt), ago: relativeTime(t, carrier.jump.departureAt) })}</span> : null}
          </div>
        )}
      </Section>

      <Section title={t("fc.sectionStatus")}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "4px 16px", fontSize: 12 }}>
          <span style={{ color: DIM }}>{t("fc.docking")} <span style={{ color: TEXT }}>{carrier.status.dockingLabel ?? "—"}</span>
            {carrier.status.allowNotorious ? <span style={{ color: RED }}>{t("fc.notorious")}</span> : null}</span>
          <span style={{ color: DIM }}>{t("fc.tritium")} <span style={{ color: TEXT }}>{carrier.status.fuelLevel != null ? t("stn.tons", { count: nf.format(carrier.status.fuelLevel) }) : "—"}</span></span>
          <span style={{ color: DIM }}>{t("fc.jumpRange")} <span style={{ color: TEXT }}>
            {carrier.status.jumpRangeCurr != null ? t("fc.jumpRangeValue", { curr: Math.round(carrier.status.jumpRangeCurr), max: Math.round(carrier.status.jumpRangeMax ?? 500) }) : "—"}</span></span>
          {carrier.finance && (
            <span style={{ color: DIM }}>{t("fc.balance")} <span style={{ color: TEXT }}>
              {nf.format(Number(carrier.finance.carrier_balance ?? carrier.finance.available_balance ?? 0))} CR</span></span>
          )}
        </div>
        {carrier.status.statsAt
          ? <div style={{ fontSize: 11, color: DIM, marginTop: 4 }}>{t("fc.statsLine", { time: formatTime(locale, carrier.status.statsAt), ago: relativeTime(t, carrier.status.statsAt) })}</div>
          : <div style={{ fontSize: 11, color: DIM, marginTop: 4 }}>{t("fc.statsHint")}</div>}
      </Section>

      {carrier.services.length > 0 && (
        <Section title={t("fc.sectionServices")}>
          <div>
            {carrier.services.map((service) => (
              <Chip key={service.role}
                color={!service.activated ? DIM : service.enabled ? GREEN : ORANGE}
                title={!service.activated ? t("fc.serviceNotInstalled") : service.enabled ? t("fc.serviceActive") : t("fc.serviceSuspended")}>
                {service.label}{service.activated && !service.enabled ? t("fc.servicePauseSuffix") : ""}
              </Chip>
            ))}
          </div>
        </Section>
      )}

      {cargo && (
        <Section title={t("fc.sectionCargo")} right={cargo.updatedAt ? <span style={{ fontSize: 11, color: DIM }}>{t("fc.cargoUpdated", { ago: relativeTime(t, cargo.updatedAt) })}</span> : null}>
          {capacity != null && stored != null && (
            <>
              <div style={{ fontSize: 13, color: TEXT, marginBottom: 4 }}>
                {t("fc.capacityLine", { stored: nf.format(stored), capacity: nf.format(capacity) })} <span style={{ color: MUTED }}>{t("fc.cargoFree", { count: nf.format(space?.freeSpace ?? 0) })}</span>
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
                  <th style={{ padding: "4px 0", fontWeight: 400 }}>{t("fc.colGood")}</th>
                  <th style={{ padding: "4px 0", fontWeight: 400, textAlign: "right" }}>{t("fc.colTons")}</th>
                  <th style={{ padding: "4px 0 4px 12px", fontWeight: 400 }}>{t("fc.colBaseline")}</th>
                </tr>
              </thead>
              <tbody>
                {cargo.items.map((item) => (
                  <tr key={item.commodity} style={{ borderTop: "1px solid #2d3033" }}>
                    <td style={{ padding: "4px 0", color: TEXT }}>{item.name}</td>
                    <td style={{ padding: "4px 0", color: ORANGE, textAlign: "right", fontFamily: "ui-monospace, monospace" }}>{nf.format(item.quantity)}</td>
                    <td style={{ padding: "4px 0 4px 12px", color: DIM }} title={item.baselineAt ? t("fc.baselineSnapshot", { time: formatTime(locale, item.baselineAt) }) : undefined}>
                      {item.baselineAt ? sourceLabel(t, item.baselineSource) : t("fc.byLogs")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ fontSize: 12, color: MUTED, marginTop: 6 }}>{t("fc.cargoNotTracked")}</div>
          )}
          <div style={{ fontSize: 11, color: DIM, marginTop: 6 }}>
            {t("fc.trackedTotal", { count: nf.format(cargo.trackedTotal) })}
            {untracked ? t("fc.untracked", { count: nf.format(untracked) }) : ""}
            {cargo.baselineAt ? t("fc.baselineFull", { time: formatTime(locale, cargo.baselineAt) }) : ""}
          </div>
        </Section>
      )}

      {(carrier.market || carrier.orders.length > 0) && (
        <Section title={t("fc.sectionMarket")} right={carrier.market ? <span style={{ fontSize: 11, color: DIM }}>{t("fc.marketSnapshot", { ago: relativeTime(t, carrier.market.observedAt) })}</span> : null}>
          {carrier.market ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, fontSize: 12 }}>
              <div>
                <div style={{ color: GREEN, marginBottom: 4 }}>{t("fc.sells")}</div>
                {selling.length ? selling.map((item) => (
                  <div key={`s-${item.name}`} style={{ display: "flex", justifyContent: "space-between", color: TEXT }}>
                    <span>{item.name}</span>
                    <span style={{ fontFamily: "ui-monospace, monospace", color: MUTED }}>{t("fc.stockPrice", { qty: nf.format(Number(item.stock)), price: nf.format(Number(item.buyPrice ?? 0)) })}</span>
                  </div>
                )) : <div style={{ color: DIM }}>—</div>}
              </div>
              <div>
                <div style={{ color: CYAN, marginBottom: 4 }}>{t("fc.buys")}</div>
                {buying.length ? buying.map((item) => (
                  <div key={`b-${item.name}`} style={{ display: "flex", justifyContent: "space-between", color: TEXT }}>
                    <span>{item.name}</span>
                    <span style={{ fontFamily: "ui-monospace, monospace", color: MUTED }}>{t("fc.stockPrice", { qty: nf.format(Number(item.demand)), price: nf.format(Number(item.sellPrice ?? 0)) })}</span>
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
                    {order.sale ? t("fc.orderSale", { qty: nf.format(order.sale) }) : ""}{order.purchase ? t("fc.orderPurchase", { qty: nf.format(order.purchase) }) : ""}
                    {order.price ? t("fc.orderPrice", { price: nf.format(order.price) }) : ""}
                  </span>
                </div>
              ))}
              <div style={{ fontSize: 11, color: DIM, marginTop: 4 }}>{t("fc.ordersHint")}</div>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}
