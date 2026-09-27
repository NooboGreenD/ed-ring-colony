// ═══════════════════════════════════════════════════════════════
// Frontier CAPI HTTP Client
// ═══════════════════════════════════════════════════════════════
//
// Что здесь важно знать про CAPI (EDCD/FDevIDs → Frontier API):
//
//   • 401/403 — токен отозван или неполон, 422 — устаревшая форма того же
//     («нужен refresh»);
//   • 418 «I'm a teapot» — сервис на техобслуживании. Это НЕ повод рвать
//     привязку и не повод обновлять токен;
//   • 204 — данных нет: у командира нет авианосца, либо в этот день он не
//     играл. Тело пустое, `res.json()` на нём падает SyntaxError'ом;
//   • 206 — журнал отдан частично, надо повторить позже;
//   • `/journal` вообще отдаёт не JSON, а построчный журнал (NDJSON).
//
// Прежний клиент всё это сводил к `res.json()` и падал: пустой ответ и
// NDJSON давали «Unexpected end of JSON input» / «Unexpected token», а
// вызывающий код видел загадочную 500 вместо «сегодня вы не играли».

import type {
  CapiJournal,
  CapiMarket,
  CapiFleetCarrier,
  CapiCommunityGoalsResponse,
  CapiProfile,
  CapiRawProfile,
} from '@/types/capi';
import { normalizeCapiProfile } from './profile.ts';
import { parseCapiJournal, journalPath } from './journal.ts';

const CAPI_BASE = 'https://companion.orerve.net';
/** Данные Legacy-галактики живут на отдельном хосте (Odyssey Update 14). */
export const CAPI_LEGACY_BASE = 'https://legacy-companion.orerve.net';

/**
 * Frontier просит третьи стороны представляться по шаблону
 * `EDCD-[A-Za-z]+-[.0-9]+` (EDCD/FDevIDs → Frontier API/README.md), чтобы
 * отличать инструменты сообщества от ботов. Прежний `ED-Ring-Colony/1.0`
 * шаблону не соответствовал.
 */
export function capiUserAgent(version = process.env.NEXT_PUBLIC_APP_VERSION): string {
  const safeVersion = String(version || '1.0').replace(/[^.0-9]/g, '') || '1.0';
  return `EDCD-EDRingColony-${safeVersion}`;
}

export type CapiErrorKind =
  | 'unauthorized'
  | 'no_entitlement'
  | 'maintenance'
  | 'no_content'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'malformed';

/**
 * Подсказка для самой частой и самой непонятной ошибки CAPI.
 *
 * `400` у Frontier означает не «кривой запрос», а «за этим аккаунтом игры
 * нет»: тело ответа — `Please Visit the store to purchase Elite: Dangerous`.
 * Так отвечают, когда токен выдан учётке магазина frontierstore.net, а игра
 * куплена в Steam или Epic (и при известном сбое Frontier с Epic-привязками,
 * issues.frontierstore.net/issue-detail/21258).
 */
export const NO_ENTITLEMENT_HINT =
  'Frontier не видит купленную Elite Dangerous у этого аккаунта. '
  + 'Отвяжите Frontier и подключите заново, выбрав платформу, где куплена игра '
  + '(Steam или Epic), — на странице входа Frontier нужно нажать кнопку Steam/Epic, '
  + 'а не входить почтой.';

/** Ошибка обращения к CAPI с разобранной причиной. */
export class CapiError extends Error {
  readonly kind: CapiErrorKind;
  readonly status: number;
  readonly endpoint: string;

  constructor(kind: CapiErrorKind, endpoint: string, status: number, message?: string) {
    // Сообщение 'UNAUTHORIZED' сохранено дословно: на него смотрит
    // `CapiSession.run()` и тесты, написанные до появления этого класса.
    super(kind === 'unauthorized' ? 'UNAUTHORIZED' : (message || `CAPI ${endpoint}: ${status}`));
    this.name = 'CapiError';
    this.kind = kind;
    this.status = status;
    this.endpoint = endpoint;
  }
}

/** Нужен ли refresh токена. Работает и со «старыми» Error('UNAUTHORIZED'). */
export function isUnauthorizedError(err: unknown): boolean {
  if (err instanceof CapiError) return err.kind === 'unauthorized';
  return err instanceof Error && err.message === 'UNAUTHORIZED';
}

/** Человеческое объяснение — его показываем пилоту, а не «CAPI /profile: 418». */
export function describeCapiError(err: unknown): string {
  if (err instanceof CapiError) {
    switch (err.kind) {
      case 'unauthorized':
        return 'Frontier отклонил токен доступа — нужна повторная авторизация';
      case 'no_entitlement':
        return NO_ENTITLEMENT_HINT;
      case 'maintenance':
        return 'Companion API Frontier на техобслуживании (HTTP 418), попробуйте позже';
      case 'no_content':
        return 'Frontier не вернул данных: командир ещё не заходил в игру';
      case 'rate_limited':
        return 'Frontier ограничил частоту запросов, попробуйте через минуту';
      case 'server':
        return `Companion API Frontier ответил ошибкой ${err.status}`;
      case 'malformed':
        return 'Companion API Frontier вернул нечитаемый ответ';
      case 'network':
      default:
        return `Не удалось связаться с Companion API: ${err.message}`;
    }
  }
  if (err instanceof Error) return err.message;
  return 'Неизвестная ошибка Companion API';
}

interface CapiResponse {
  status: number;
  body: string;
  partial: boolean;
}

export class CapiClient {
  // Поле объявлено явно (без «parameter property»): так файл читается
  // сборкой Next и напрямую загрузчиком TypeScript в тестах node --test.
  private accessToken: string;
  private base: string;
  private timeoutMs: number;

  constructor(accessToken: string, options: { base?: string; timeoutMs?: number } = {}) {
    this.accessToken = accessToken;
    this.base = options.base || CAPI_BASE;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Сырой запрос: сюда сведён весь разбор кодов ответа Frontier. */
  private async request(endpoint: string): Promise<CapiResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${endpoint}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
        cache: 'no-store',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: 'application/json',
          'User-Agent': capiUserAgent(),
        },
      });
    } catch (err) {
      throw new CapiError('network', endpoint, 0, err instanceof Error ? err.message : String(err));
    }

    if (res.status === 401 || res.status === 403 || res.status === 422) {
      throw new CapiError('unauthorized', endpoint, res.status);
    }
    if (res.status === 400) {
      // Не 'server': повторять бессмысленно, пилоту нужно переподключить
      // аккаунт нужной платформы.
      throw new CapiError('no_entitlement', endpoint, 400);
    }
    if (res.status === 418) {
      throw new CapiError('maintenance', endpoint, 418);
    }
    if (res.status === 429) {
      throw new CapiError('rate_limited', endpoint, 429);
    }
    if (res.status === 204) {
      return { status: 204, body: '', partial: false };
    }
    if (!res.ok) {
      throw new CapiError('server', endpoint, res.status);
    }

    return { status: res.status, body: await res.text(), partial: res.status === 206 };
  }

  /** JSON-эндпоинты. Пустое тело — отдельный случай, а не SyntaxError. */
  private async fetchJson(endpoint: string): Promise<unknown> {
    const { status, body } = await this.request(endpoint);
    if (status === 204 || !body.trim()) {
      throw new CapiError('no_content', endpoint, status);
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new CapiError('malformed', endpoint, status);
    }
  }

  /** Профиль в нормализованной форме — именно его пишет сайт в базу. */
  async getProfile(): Promise<CapiProfile> {
    return normalizeCapiProfile(await this.fetchJson('/profile'));
  }

  /** Сырой ответ `/profile` — для диагностики и отладки привязки. */
  async getRawProfile(): Promise<CapiRawProfile> {
    return (await this.fetchJson('/profile')) as CapiRawProfile;
  }

  /**
   * Журнал командира. `date` — `YYYY-MM-DD`; без него отдаётся сегодняшний.
   * Пустой день (204) и частичный ответ (206) возвращаются флагами, а не
   * исключением: это нормальные состояния, а не поломка привязки.
   */
  async getJournal(date?: string | null): Promise<CapiJournal> {
    const endpoint = journalPath(date);
    const { status, body, partial } = await this.request(endpoint);
    if (status === 204) {
      return { text: '', events: [], partial: false, empty: true, malformedLines: 0 };
    }
    return parseCapiJournal(body, { partial });
  }

  async getMarket(): Promise<CapiMarket> {
    return (await this.fetchJson('/market')) as CapiMarket;
  }

  /** `null` — у командира просто нет авианосца (CAPI отвечает 204). */
  async getFleetCarrier(): Promise<CapiFleetCarrier | null> {
    try {
      return (await this.fetchJson('/fleetcarrier')) as CapiFleetCarrier;
    } catch (err) {
      if (err instanceof CapiError && err.kind === 'no_content') return null;
      throw err;
    }
  }

  async getCommunityGoals(): Promise<CapiCommunityGoalsResponse> {
    return (await this.fetchJson('/communitygoals')) as CapiCommunityGoalsResponse;
  }

  async getVisitedStars(): Promise<Blob> {
    const endpoint = '/visitedstars';
    let res: Response;
    try {
      res = await fetch(`${this.base}${endpoint}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'User-Agent': capiUserAgent(),
        },
      });
    } catch (err) {
      throw new CapiError('network', endpoint, 0, err instanceof Error ? err.message : String(err));
    }

    // Тот же разбор, что и в request(): иначе просроченный токен отдавал
    // «CAPI /visitedstars: 422» и обновление не запускалось.
    if (res.status === 401 || res.status === 403 || res.status === 422) {
      throw new CapiError('unauthorized', endpoint, res.status);
    }
    if (res.status === 418) throw new CapiError('maintenance', endpoint, 418);
    // 102 — архив ещё собирается на стороне Frontier, надо повторить позже.
    if (res.status === 102 || res.status === 204) throw new CapiError('no_content', endpoint, res.status);
    if (!res.ok) throw new CapiError('server', endpoint, res.status);

    return res.blob();
  }
}
