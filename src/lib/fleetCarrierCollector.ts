/**
 * Сборщик событий авианосца из журнала (браузер и тесты; без node-зависимостей).
 *
 * Тот же алгоритм, что и `uploader/carrier_sync.py` в Colonial Helper:
 * отбирает события, нужные серверу для учёта носителей, и дописывает к ним
 * контекст стоянки, которого в самом событии нет (CargoTransfer не знает,
 * у какого авианосца стоит пилот). Хеши грузовых дельт считает сервер из полей
 * события, поэтому одинаковый журнал с сайта и из Helper'а не задваивается.
 */

export const FC_MARKET_MIN = 3_700_000_000;
export const FC_MARKET_MAX = 3_800_000_000;

type JournalEvent = Record<string, unknown>;

/** Какие поля события нужны серверу (остальное не отправляем — меньше трафика). */
const COMMON_FIELDS = ['event', 'timestamp', 'CarrierType'];
const STATION_FIELDS = ['Docked', 'MarketID', 'StationType', 'StationName', 'StationServices',
  'StarSystem', 'SystemAddress', 'StarPos', 'Body', 'BodyID'];
export const CARRIER_EVENT_FIELDS: Record<string, string[]> = {
  CarrierStats: ['CarrierID', 'Callsign', 'Name', 'DockingAccess', 'AllowNotorious', 'FuelLevel',
    'JumpRangeCurr', 'JumpRangeMax', 'PendingDecommission', 'SpaceUsage', 'Finance', 'Crew'],
  CarrierBuy: ['CarrierID', 'Callsign', 'Location', 'StarSystem', 'SystemAddress'],
  CarrierLocation: ['CarrierID', 'StarSystem', 'SystemAddress', 'BodyID'],
  CarrierJump: STATION_FIELDS,
  Docked: STATION_FIELDS,
  Location: STATION_FIELDS,
  CarrierJumpRequest: ['CarrierID', 'SystemName', 'SystemAddress', 'Body', 'BodyID', 'DepartureTime'],
  CarrierJumpCancelled: ['CarrierID'],
  CarrierNameChanged: ['CarrierID', 'Name', 'Callsign'],
  CarrierNameChange: ['CarrierID', 'Name', 'Callsign'],
  CarrierDecommission: ['CarrierID'],
  CarrierCancelDecommission: ['CarrierID'],
  CarrierDockingPermission: ['CarrierID', 'DockingAccess', 'AllowNotorious'],
  CarrierCrewServices: ['CarrierID', 'CrewRole', 'Operation', 'CrewName'],
  CarrierTradeOrder: ['CarrierID', 'Commodity', 'Commodity_Localised', 'PurchaseOrder', 'SaleOrder',
    'CancelTrade', 'Price', 'BlackMarket'],
  MarketBuy: ['MarketID', 'Type', 'Type_Localised', 'Count', 'BuyPrice', 'TotalCost'],
  MarketSell: ['MarketID', 'Type', 'Type_Localised', 'Count', 'SellPrice', 'TotalSale', 'AvgPricePaid'],
  CargoTransfer: ['Transfers'],
};

function integer(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d{1,18}$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

export function isCarrierMarketId(value: unknown): boolean {
  const parsed = integer(value);
  return parsed != null && parsed >= FC_MARKET_MIN && parsed < FC_MARKET_MAX;
}

function project(event: JournalEvent, name: string): JournalEvent {
  const fields = CARRIER_EVENT_FIELDS[name] ?? [];
  const out: JournalEvent = {};
  for (const key of [...COMMON_FIELDS, ...fields]) {
    if (event[key] !== undefined) out[key] = event[key];
  }
  return out;
}

interface DockContext {
  marketId: number | null;
  stationType: string;
  system: string;
  starPos: number[] | null;
}

export class CarrierEventCollector {
  private readonly events: JournalEvent[] = [];
  private context: DockContext = { marketId: null, stationType: '', system: '', starPos: null };
  /** Сколько событий отобрано за всё время (для статистики загрузчика). */
  collected = 0;

  private dockedAtCarrier(): boolean {
    return this.context.marketId != null
      && (/carrier/i.test(this.context.stationType) || isCarrierMarketId(this.context.marketId));
  }

  private push(event: JournalEvent) {
    this.events.push(event);
    this.collected += 1;
  }

  private setSystem(event: JournalEvent) {
    const system = typeof event.StarSystem === 'string' ? event.StarSystem : '';
    if (!system) return;
    if (system !== this.context.system) this.context.starPos = null;
    this.context.system = system;
    if (Array.isArray(event.StarPos) && event.StarPos.length === 3) this.context.starPos = event.StarPos as number[];
  }

  private dock(event: JournalEvent) {
    this.context.marketId = integer(event.MarketID);
    this.context.stationType = String(event.StationType ?? '');
  }

  private undock() {
    this.context.marketId = null;
    this.context.stationType = '';
  }

  /** Хук для `parseJournal(..., hooks)`: (line, event). */
  feed(_line: string, event: JournalEvent): void {
    if (!event || typeof event !== 'object') return;
    const name = String(event.event ?? '');
    switch (name) {
      case 'LoadGame':
      case 'Shutdown':
        this.undock();
        return;
      case 'FSDJump':
        this.setSystem(event);
        this.undock();
        return;
      case 'Undocked':
        this.undock();
        return;
      case 'Location': {
        this.setSystem(event);
        if (event.Docked === true) this.dock(event); else this.undock();
        if (this.dockedAtCarrier()) this.push(project(event, name));
        return;
      }
      case 'Docked': {
        this.setSystem(event);
        this.dock(event);
        if (!this.dockedAtCarrier()) return;
        const projected = project(event, name);
        // В Docked нет координат системы — берём их из последнего FSDJump/Location.
        if (this.context.starPos && event.StarSystem === this.context.system) projected._StarPos = this.context.starPos;
        this.push(projected);
        return;
      }
      case 'CarrierJump': {
        this.setSystem(event);
        if (event.Docked !== false) this.dock(event);
        this.push(project(event, name));
        return;
      }
      case 'MarketBuy':
      case 'MarketSell': {
        const marketId = integer(event.MarketID);
        const sameDock = marketId != null && marketId === this.context.marketId;
        if (!isCarrierMarketId(marketId) && !(sameDock && /carrier/i.test(this.context.stationType))) return;
        const projected = project(event, name);
        if (sameDock && this.context.stationType) projected._StationType = this.context.stationType;
        this.push(projected);
        return;
      }
      case 'CargoTransfer': {
        if (!this.dockedAtCarrier()) return;
        const projected = project(event, name);
        projected._MarketID = this.context.marketId;
        projected._StationType = this.context.stationType;
        this.push(projected);
        return;
      }
      default:
        if (name.startsWith('Carrier') && CARRIER_EVENT_FIELDS[name]) this.push(project(event, name));
    }
  }

  /** Забрать накопленное (сборщик продолжает следить за контекстом стоянки). */
  drain(): JournalEvent[] {
    return this.events.splice(0, this.events.length);
  }
}
