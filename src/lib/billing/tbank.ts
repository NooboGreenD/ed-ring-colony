import crypto from 'node:crypto';
import type { PaymentProvider } from '@/types/billing';
import type { ProviderDriver } from './providers';
import { getSiteUrl } from '@/lib/siteUrl';

// DEMO terminals use the same endpoint as production (not the PCI DSS test API).
const API_URL = 'https://securepay.tinkoff.ru/v2/Init';

/** T-Bank signs only non-null scalar root fields, sorted by key, plus Password. */
export function tbankToken(payload: Record<string, unknown>, password: string): string {
  const fields: Record<string, unknown> = { ...payload, Password: password };
  const values = Object.keys(fields).filter((key) => key !== 'Token' &&
    ['string', 'number', 'boolean'].includes(typeof fields[key]))
    .sort().map((key) => String(fields[key])).join('');
  return crypto.createHash('sha256').update(values, 'utf8').digest('hex');
}

export function rubToKopecks(amount: number): number {
  const minor = Math.round(Number(amount) * 100);
  if (!Number.isSafeInteger(minor) || minor <= 0 || Math.abs(Number(amount) * 100 - minor) > 0.00001) {
    throw new Error('Т-Банк: некорректная сумма в рублях');
  }
  return minor;
}

function credentialsPresent(config: Record<string, unknown>): boolean {
  return typeof config.terminal_key === 'string' && Boolean(config.terminal_key.trim()) &&
    typeof config.password === 'string' && Boolean(config.password.trim());
}

function configurationError(provider: PaymentProvider): string | null {
  if (!credentialsPresent(provider.config)) return 'Заполните TerminalKey и пароль терминала';
  const demo = provider.config.terminal_key.endsWith('DEMO');
  if (demo !== provider.test_mode) {
    return provider.test_mode
      ? 'Для тестового режима нужен TerminalKey с суффиксом DEMO'
      : 'Для боевого режима укажите боевой терминал без суффикса DEMO';
  }
  if (!provider.test_mode && provider.config.external_receipts_confirmed !== true) {
    return 'До приёма реальных платежей настройте выдачу чеков отдельно и подтвердите это в настройках';
  }
  return null;
}

function paymentId(value: unknown): string | null {
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return null;
}

export const tbank: ProviderDriver = {
  id: 'tbank',
  name: 'Т-Банк',
  description: 'Разовая оплата через страницу Т-Банка. Подписка продлевается вручную, автосписаний нет. Чеки через API в этой версии не формируются — фискализацию нужно организовать отдельно.',
  docsUrl: 'https://developer.tbank.ru/eacq/api/init',
  methods: ['card'],
  fields: [
    { key: 'terminal_key', label: 'TerminalKey', type: 'text', required: true, help: 'В тестовом режиме — терминал с суффиксом DEMO; в боевом — боевой терминал. Не меняйте терминал, пока есть незавершённые платежи.' },
    { key: 'password', label: 'Пароль терминала', type: 'secret', required: true, help: 'Пароль из настроек интернет-эквайринга, не пароль входа в Т-Бизнес.' },
    { key: 'external_receipts_confirmed', label: 'Выдача чеков организована отдельно / подтверждено законное освобождение', type: 'boolean', help: 'Обязательно для боевого режима. Интеграция не отправляет Receipt и не формирует кассовые чеки. Требования согласуйте с бухгалтером и банком.' },
  ],
  isConfigured: credentialsPresent,
  async check(provider) {
    const error = configurationError(provider);
    return error ? { ok: false, message: error } : {
      ok: true,
      message: 'Формат настроек корректен. Доступ к API и пароль не проверены — выполните тестовый платёж и дождитесь уведомления CONFIRMED.',
    };
  },
  async createPayment(provider, { intent, description, returnUrl }) {
    const error = configurationError(provider);
    if (error) throw new Error(`Т-Банк: ${error}`);
    if (intent.currency !== 'RUB') throw new Error('Т-Банк: поддерживается только RUB');
    if (!intent.id || intent.id.length > 50) throw new Error('Т-Банк: некорректный OrderId');
    const site = new URL(getSiteUrl());
    const back = new URL(returnUrl);
    if (site.protocol !== 'https:' || back.origin !== site.origin || site.port) {
      throw new Error('Т-Банк: укажите публичный HTTPS-адрес сайта (порт 443) в NEXT_PUBLIC_SITE_URL');
    }
    const body: Record<string, unknown> = {
      TerminalKey: provider.config.terminal_key,
      Amount: rubToKopecks(intent.amount_rub),
      OrderId: intent.id,
      Description: description.slice(0, 140),
      PayType: 'O',
      Language: 'ru',
      NotificationURL: `${site.origin}/api/billing/webhooks/tbank`,
      SuccessURL: back.href,
      FailURL: back.href,
      // No Recurrent, CustomerKey or RebillId: never bind a card for future charges.
    };
    body.Token = tbankToken(body, provider.config.password);
    const response = await fetch(API_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000), cache: 'no-store',
      redirect: 'error',
    });
    let data: any;
    try { data = await response.json(); } catch { throw new Error('Т-Банк: некорректный ответ API'); }
    if (!response.ok || data?.Success !== true || String(data?.ErrorCode) !== '0') {
      // Do not relay arbitrary bank response bodies or request secrets to the browser/log.
      const code = /^[\dA-Za-z_-]{1,32}$/.test(String(data?.ErrorCode)) ? `, код ${data.ErrorCode}` : '';
      throw new Error(`Т-Банк: платёж не создан (HTTP ${response.status}${code})`);
    }
    const externalId = paymentId(data.PaymentId);
    let url: URL;
    try { url = new URL(data.PaymentURL); } catch { throw new Error('Т-Банк: отсутствует ссылка на оплату'); }
    if (!externalId || url.protocol !== 'https:' || url.username || url.password ||
        data.OrderId !== intent.id || data.Amount !== body.Amount || data.TerminalKey !== body.TerminalKey) {
      throw new Error('Т-Банк: некорректные реквизиты созданного платежа');
    }
    return { externalId, paymentUrl: url.href };
  },
  async parseWebhook(provider, { rawBody }) {
    if (!credentialsPresent(provider.config)) return { ok: false, error: 'Terminal not configured' };
    let data: any;
    try { data = JSON.parse(rawBody); } catch { return { ok: false, error: 'Invalid JSON' }; }
    if (!data || Array.isArray(data) || typeof data !== 'object') return { ok: false, error: 'Invalid notification' };
    if (data.TerminalKey !== provider.config.terminal_key) return { ok: false, error: 'Terminal mismatch' };
    if (typeof data.Token !== 'string' || !/^[a-fA-F0-9]{64}$/.test(data.Token) ||
        !crypto.timingSafeEqual(Buffer.from(data.Token, 'hex'), Buffer.from(tbankToken(data, provider.config.password), 'hex'))) {
      return { ok: false, error: 'Bad signature' };
    }
    const externalId = paymentId(data.PaymentId);
    if (!externalId || typeof data.OrderId !== 'string' || !data.OrderId || data.OrderId.length > 50 ||
        !Number.isSafeInteger(data.Amount) || data.Amount <= 0 || typeof data.Status !== 'string' ||
        typeof data.Success !== 'boolean') return { ok: false, error: 'Missing or invalid payment fields' };
    if (data.Status === 'CONFIRMED' && (data.Success !== true || String(data.ErrorCode) !== '0')) {
      return { ok: false, error: 'Inconsistent confirmation' };
    }
    const status = data.Status === 'CONFIRMED' ? 'paid'
      : data.Status === 'REJECTED' ? 'failed'
        : ['CANCELED', 'DEADLINE_EXPIRED'].includes(data.Status) ? 'canceled' : 'pending';
    // AUTHORIZED is only a hold. Refund/reversal events are audited, never fulfil again.
    return { ok: true, externalId, intentId: data.OrderId, amountMinor: data.Amount,
      currency: 'RUB', status, eventType: data.Status };
  },
};
