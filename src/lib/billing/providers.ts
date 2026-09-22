/**
 * Payment provider integrations.
 *
 * Each provider implements:
 *  - `createPayment` — create a checkout in the payment system and return a
 *    redirect URL + external id;
 *  - `parseWebhook`  — verify & normalise an incoming webhook into a
 *    { externalId, status } tuple;
 *  - `check`         — lightweight credentials test for the admin panel.
 *
 * Secrets live in `payment_providers.config` (server only) and are never
 * returned to the browser unmasked.
 */
import crypto from 'crypto';
import { tbank } from './tbank';
import type { PaymentProvider, ProviderConfigField, PaymentIntent } from '@/types/billing';
import { getSiteUrl } from '@/lib/siteUrl';

export interface CreatePaymentInput {
  intent: PaymentIntent;
  description: string;
  returnUrl: string;
  customerEmail?: string | null;
}

export interface CreatePaymentResult {
  externalId: string;
  paymentUrl: string;
  raw?: any;
}

export interface WebhookResult {
  ok: boolean;
  externalId?: string;
  intentId?: string;
  status?: 'paid' | 'failed' | 'canceled' | 'pending';
  eventType?: string;
  amountMinor?: number;
  currency?: string;
  error?: string;
}

export interface ProviderDriver {
  id: string;
  name: string;
  description: string;
  docsUrl: string;
  methods: string[];
  fields: ProviderConfigField[];
  isConfigured(config: Record<string, any>): boolean;
  createPayment(provider: PaymentProvider, input: CreatePaymentInput): Promise<CreatePaymentResult>;
  parseWebhook(provider: PaymentProvider, req: { headers: Headers; rawBody: string; query: URLSearchParams }): Promise<WebhookResult>;
  check(provider: PaymentProvider): Promise<{ ok: boolean; message: string }>;
}

export const SECRET_MASK = '••••••••';

function safeSiteUrl(): string {
  try {
    return getSiteUrl();
  } catch {
    return process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000';
  }
}

export function webhookUrlFor(providerId: string): string {
  return `${safeSiteUrl()}/api/billing/webhooks/${providerId}`;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = 15000): Promise<{ status: number; json: any }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

// ───────────────────────────── YooKassa ─────────────────────────────

const yookassa: ProviderDriver = {
  id: 'yookassa',
  name: 'ЮKassa (YooMoney)',
  description: 'Банковские карты, СБП, ЮMoney. Самый распространённый эквайринг для РФ. Требуется магазин в личном кабинете ЮKassa.',
  docsUrl: 'https://yookassa.ru/developers/api',
  methods: ['card', 'sbp'],
  fields: [
    { key: 'shop_id', label: 'Shop ID', type: 'text', required: true, placeholder: '123456' },
    { key: 'secret_key', label: 'Секретный ключ', type: 'secret', required: true, placeholder: 'live_... / test_...' },
    { key: 'webhook_secret', label: 'Доп. секрет вебхука (опц.)', type: 'secret', help: 'Если задан — передаётся в metadata и проверяется при приёме уведомления.' },
  ],
  isConfigured: (c) => Boolean(c.shop_id && c.secret_key),
  async createPayment(provider, input) {
    const { shop_id, secret_key } = provider.config;
    const auth = Buffer.from(`${shop_id}:${secret_key}`).toString('base64');
    const body = {
      amount: { value: Number(input.intent.amount_rub).toFixed(2), currency: input.intent.currency || 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: input.returnUrl },
      description: input.description.slice(0, 128),
      metadata: { intent_id: input.intent.id, whs: provider.config.webhook_secret || undefined },
      receipt: input.customerEmail
        ? {
            customer: { email: input.customerEmail },
            items: [
              {
                description: input.description.slice(0, 128),
                quantity: '1.00',
                amount: { value: Number(input.intent.amount_rub).toFixed(2), currency: 'RUB' },
                vat_code: 1,
                payment_subject: 'service',
                payment_mode: 'full_payment',
              },
            ],
          }
        : undefined,
    };
    const { status, json } = await fetchJson('https://api.yookassa.ru/v3/payments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
        'Idempotence-Key': input.intent.id,
      },
      body: JSON.stringify(body),
    });
    if (status >= 300 || !json?.id) {
      throw new Error(`ЮKassa: ${json?.description || json?.code || `HTTP ${status}`}`);
    }
    return { externalId: json.id, paymentUrl: json.confirmation?.confirmation_url, raw: json };
  },
  async parseWebhook(provider, { rawBody }) {
    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { ok: false, error: 'Invalid JSON' };
    }
    const obj = payload?.object;
    if (!obj?.id) return { ok: false, error: 'No payment object' };
    if (provider.config.webhook_secret && obj.metadata?.whs !== provider.config.webhook_secret) {
      return { ok: false, error: 'Webhook secret mismatch' };
    }
    // Verify with API (recommended by YooKassa — webhook bodies are not signed)
    const auth = Buffer.from(`${provider.config.shop_id}:${provider.config.secret_key}`).toString('base64');
    const { status, json } = await fetchJson(`https://api.yookassa.ru/v3/payments/${obj.id}`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (status >= 300) return { ok: false, error: `Verification failed: HTTP ${status}` };
    const st = json?.status;
    return {
      ok: true,
      externalId: obj.id,
      intentId: json?.metadata?.intent_id || obj.metadata?.intent_id,
      eventType: payload.event,
      status: st === 'succeeded' ? 'paid' : st === 'canceled' ? 'canceled' : 'pending',
    };
  },
  async check(provider) {
    const auth = Buffer.from(`${provider.config.shop_id}:${provider.config.secret_key}`).toString('base64');
    const { status, json } = await fetchJson('https://api.yookassa.ru/v3/me', { headers: { Authorization: `Basic ${auth}` } });
    if (status === 200) return { ok: true, message: `Магазин ${json?.account_id || provider.config.shop_id}: ${json?.status || 'ok'}${json?.test ? ' (тест)' : ''}` };
    return { ok: false, message: json?.description || `HTTP ${status}` };
  },
};

// ───────────────────────────── Robokassa ─────────────────────────────

function md5(s: string) {
  return crypto.createHash('md5').update(s).digest('hex');
}

const robokassa: ProviderDriver = {
  id: 'robokassa',
  name: 'Robokassa',
  description: 'Карты, СБП, электронные кошельки. Оплата через redirect на страницу Robokassa, подтверждение через ResultURL.',
  docsUrl: 'https://docs.robokassa.ru/',
  methods: ['card', 'sbp'],
  fields: [
    { key: 'merchant_login', label: 'Идентификатор магазина (MerchantLogin)', type: 'text', required: true },
    { key: 'password1', label: 'Пароль #1', type: 'secret', required: true },
    { key: 'password2', label: 'Пароль #2', type: 'secret', required: true },
  ],
  isConfigured: (c) => Boolean(c.merchant_login && c.password1 && c.password2),
  async createPayment(provider, input) {
    const { merchant_login, password1 } = provider.config;
    const outSum = Number(input.intent.amount_rub).toFixed(2);
    // InvId must be numeric — derive a stable int from intent id and pass the id via Shp_ param
    const invId = String(Math.abs(parseInt(crypto.createHash('sha1').update(input.intent.id).digest('hex').slice(0, 8), 16) % 2147483647));
    const shp = `Shp_intent=${input.intent.id}`;
    const signature = md5(`${merchant_login}:${outSum}:${invId}:${password1}:${shp}`);
    const params = new URLSearchParams({
      MerchantLogin: merchant_login,
      OutSum: outSum,
      InvId: invId,
      Description: input.description.slice(0, 100),
      SignatureValue: signature,
      Shp_intent: input.intent.id,
      Culture: 'ru',
    });
    if (input.customerEmail) params.set('Email', input.customerEmail);
    if (provider.test_mode) params.set('IsTest', '1');
    return { externalId: invId, paymentUrl: `https://auth.robokassa.ru/Merchant/Index.aspx?${params.toString()}` };
  },
  async parseWebhook(provider, { rawBody, query }) {
    const form = new URLSearchParams(rawBody || '');
    const get = (k: string) => form.get(k) ?? query.get(k) ?? '';
    const outSum = get('OutSum');
    const invId = get('InvId');
    const intentId = get('Shp_intent');
    const sig = get('SignatureValue').toLowerCase();
    if (!invId || !sig) return { ok: false, error: 'Missing params' };
    const expected = md5(`${outSum}:${invId}:${provider.config.password2}:Shp_intent=${intentId}`).toLowerCase();
    if (expected !== sig) return { ok: false, error: 'Bad signature' };
    return { ok: true, externalId: invId, intentId, status: 'paid', eventType: 'result' };
  },
  async check(provider) {
    const c = provider.config;
    if (!this.isConfigured(c)) return { ok: false, message: 'Не заполнены обязательные поля' };
    return { ok: true, message: 'Параметры сохранены. Robokassa не предоставляет ping API — проверьте тестовым платежом.' };
  },
};

// ───────────────────────────── Stripe ─────────────────────────────

const stripe: ProviderDriver = {
  id: 'stripe',
  name: 'Stripe',
  description: 'Международные карты (Checkout Session). Подходит для зарубежных пилотов. Валюта задаётся в настройках.',
  docsUrl: 'https://docs.stripe.com/payments/checkout',
  methods: ['card'],
  fields: [
    { key: 'secret_key', label: 'Secret key', type: 'secret', required: true, placeholder: 'sk_live_... / sk_test_...' },
    { key: 'webhook_secret', label: 'Webhook signing secret', type: 'secret', required: true, placeholder: 'whsec_...' },
    {
      key: 'currency',
      label: 'Валюта',
      type: 'select',
      options: [
        { value: 'rub', label: 'RUB' },
        { value: 'usd', label: 'USD' },
        { value: 'eur', label: 'EUR' },
      ],
    },
    { key: 'rate_to_rub', label: 'Курс к рублю (если валюта не RUB)', type: 'text', placeholder: '90', help: 'Сумма в рублях будет пересчитана по этому курсу.' },
  ],
  isConfigured: (c) => Boolean(c.secret_key && c.webhook_secret),
  async createPayment(provider, input) {
    const currency = (provider.config.currency || 'rub').toLowerCase();
    const rate = currency === 'rub' ? 1 : Number(provider.config.rate_to_rub) || 90;
    const amountMinor = Math.max(50, Math.round((Number(input.intent.amount_rub) / rate) * 100));
    const params = new URLSearchParams();
    params.set('mode', 'payment');
    params.set('success_url', input.returnUrl + (input.returnUrl.includes('?') ? '&' : '?') + 'stripe=success');
    params.set('cancel_url', input.returnUrl + (input.returnUrl.includes('?') ? '&' : '?') + 'stripe=cancel');
    params.set('client_reference_id', input.intent.id);
    params.set('metadata[intent_id]', input.intent.id);
    params.set('line_items[0][quantity]', '1');
    params.set('line_items[0][price_data][currency]', currency);
    params.set('line_items[0][price_data][unit_amount]', String(amountMinor));
    params.set('line_items[0][price_data][product_data][name]', input.description.slice(0, 120));
    if (input.customerEmail) params.set('customer_email', input.customerEmail);
    const { status, json } = await fetchJson('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.config.secret_key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (status >= 300 || !json?.id) throw new Error(`Stripe: ${json?.error?.message || `HTTP ${status}`}`);
    return { externalId: json.id, paymentUrl: json.url, raw: json };
  },
  async parseWebhook(provider, { headers, rawBody }) {
    const sigHeader = headers.get('stripe-signature') || '';
    const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=') as [string, string]));
    const ts = parts.t;
    const v1 = parts.v1;
    if (!ts || !v1) return { ok: false, error: 'Missing signature' };
    const expected = crypto.createHmac('sha256', provider.config.webhook_secret).update(`${ts}.${rawBody}`).digest('hex');
    if (expected.length !== v1.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1))) {
      return { ok: false, error: 'Bad signature' };
    }
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 600) return { ok: false, error: 'Stale signature' };
    let event: any;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return { ok: false, error: 'Invalid JSON' };
    }
    const obj = event?.data?.object || {};
    const type = String(event?.type || '');
    let st: WebhookResult['status'] = 'pending';
    if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') st = 'paid';
    else if (type === 'checkout.session.async_payment_failed') st = 'failed';
    else if (type === 'checkout.session.expired') st = 'canceled';
    return { ok: true, externalId: obj.id, intentId: obj.metadata?.intent_id || obj.client_reference_id, status: st, eventType: type };
  },
  async check(provider) {
    const { status, json } = await fetchJson('https://api.stripe.com/v1/balance', {
      headers: { Authorization: `Bearer ${provider.config.secret_key}` },
    });
    if (status === 200) return { ok: true, message: `Аккаунт доступен, режим ${json?.livemode ? 'LIVE' : 'TEST'}` };
    return { ok: false, message: json?.error?.message || `HTTP ${status}` };
  },
};

// ───────────────────────────── Crypto Pay (CryptoBot) ─────────────────────────────

const cryptobot: ProviderDriver = {
  id: 'cryptobot',
  name: 'Crypto Pay (CryptoBot)',
  description: 'Оплата криптовалютой через Telegram @CryptoBot. Счёт создаётся в фиате (RUB), оплатить можно USDT/TON/BTC и др.',
  docsUrl: 'https://help.crypt.bot/crypto-pay-api',
  methods: ['crypto'],
  fields: [
    { key: 'api_token', label: 'API Token', type: 'secret', required: true },
    {
      key: 'network',
      label: 'Сеть',
      type: 'select',
      options: [
        { value: 'mainnet', label: 'Mainnet (pay.crypt.bot)' },
        { value: 'testnet', label: 'Testnet (testnet-pay.crypt.bot)' },
      ],
    },
  ],
  isConfigured: (c) => Boolean(c.api_token),
  async createPayment(provider, input) {
    const base = provider.config.network === 'testnet' || provider.test_mode ? 'https://testnet-pay.crypt.bot/api' : 'https://pay.crypt.bot/api';
    const { status, json } = await fetchJson(`${base}/createInvoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Crypto-Pay-API-Token': provider.config.api_token },
      body: JSON.stringify({
        currency_type: 'fiat',
        fiat: 'RUB',
        amount: Number(input.intent.amount_rub).toFixed(2),
        description: input.description.slice(0, 1024),
        payload: input.intent.id,
        paid_btn_name: 'callback',
        paid_btn_url: input.returnUrl,
        expires_in: 3600,
      }),
    });
    if (status >= 300 || !json?.ok) throw new Error(`CryptoBot: ${json?.error?.name || `HTTP ${status}`}`);
    const inv = json.result;
    return { externalId: String(inv.invoice_id), paymentUrl: inv.bot_invoice_url || inv.mini_app_invoice_url || inv.web_app_invoice_url, raw: inv };
  },
  async parseWebhook(provider, { headers, rawBody }) {
    const sig = headers.get('crypto-pay-api-signature') || '';
    const secret = crypto.createHash('sha256').update(provider.config.api_token).digest();
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    if (!sig || expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
      return { ok: false, error: 'Bad signature' };
    }
    let ev: any;
    try {
      ev = JSON.parse(rawBody);
    } catch {
      return { ok: false, error: 'Invalid JSON' };
    }
    if (ev?.update_type !== 'invoice_paid') return { ok: true, status: 'pending', eventType: ev?.update_type };
    const inv = ev.payload || {};
    return { ok: true, externalId: String(inv.invoice_id), intentId: inv.payload, status: 'paid', eventType: 'invoice_paid' };
  },
  async check(provider) {
    const base = provider.config.network === 'testnet' || provider.test_mode ? 'https://testnet-pay.crypt.bot/api' : 'https://pay.crypt.bot/api';
    const { status, json } = await fetchJson(`${base}/getMe`, { headers: { 'Crypto-Pay-API-Token': provider.config.api_token } });
    if (status === 200 && json?.ok) return { ok: true, message: `Приложение @${json.result?.name || 'app'} (id ${json.result?.app_id})` };
    return { ok: false, message: json?.error?.name || `HTTP ${status}` };
  },
};

// ───────────────────────────── Manual (invoice / admin confirm) ─────────────────────────────

const manual: ProviderDriver = {
  id: 'manual',
  name: 'Ручное подтверждение',
  description: 'Пилот получает реквизиты/инструкцию, переводит средства, а администратор подтверждает платёж в реестре транзакций. Без внешнего API.',
  docsUrl: '',
  methods: ['manual'],
  fields: [
    { key: 'instructions', label: 'Инструкция для пилота', type: 'text', placeholder: 'Переведите сумму на карту ... и укажите номер счёта в комментарии', required: true },
    { key: 'admin_secret', label: 'Секрет для подтверждения по ссылке (опц.)', type: 'secret', help: 'Позволяет подтверждать платёж GET-запросом на webhook с ?intent=…&secret=…' },
  ],
  isConfigured: (c) => Boolean(c.instructions),
  async createPayment(provider, input) {
    const url = `${safeSiteUrl()}/premium-shop/pay/${input.intent.id}`;
    return { externalId: input.intent.id, paymentUrl: url };
  },
  async parseWebhook(provider, { query }) {
    const secret = provider.config.admin_secret;
    if (!secret) return { ok: false, error: 'Manual confirmation via webhook disabled' };
    if (query.get('secret') !== secret) return { ok: false, error: 'Bad secret' };
    const intentId = query.get('intent') || '';
    if (!intentId) return { ok: false, error: 'intent required' };
    return { ok: true, intentId, externalId: intentId, status: 'paid', eventType: 'manual_confirm' };
  },
  async check(provider) {
    return { ok: this.isConfigured(provider.config), message: this.isConfigured(provider.config) ? 'Готово к использованию' : 'Заполните инструкцию' };
  },
};

export const PROVIDER_DRIVERS: Record<string, ProviderDriver> = { yookassa, robokassa, stripe, cryptobot, tbank, manual };

export function getDriver(id: string): ProviderDriver | null {
  return PROVIDER_DRIVERS[id] || null;
}

/** Mask secret fields for transport to admin UI. */
export function maskConfig(driver: ProviderDriver, config: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...config };
  for (const f of driver.fields) {
    if (f.type === 'secret' && out[f.key]) out[f.key] = SECRET_MASK;
  }
  return out;
}

/** Merge admin-submitted config with stored config, preserving masked secrets. */
export function mergeConfig(driver: ProviderDriver, stored: Record<string, any>, incoming: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...stored };
  for (const f of driver.fields) {
    if (!(f.key in incoming)) continue;
    const v = incoming[f.key];
    if (f.type === 'secret' && (v === SECRET_MASK || v === undefined)) continue;
    if (v === '' || v === null) delete out[f.key];
    else out[f.key] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}
