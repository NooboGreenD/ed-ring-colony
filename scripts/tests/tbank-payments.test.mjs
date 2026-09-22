import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const root = process.cwd();
const dir = mkdtempSync(join(tmpdir(), 'edrc-tbank-'));
const require = createRequire(import.meta.url);
const originalFetch = globalThis.fetch;
process.env.BILLING_STORAGE = 'file';
process.env.BILLING_DATA_FILE = join(dir, 'billing.json');
process.env.NEXT_PUBLIC_SITE_URL = 'https://shop.example.com';
after(() => { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); });
const shim = join(dir, 'next.mjs');
writeFileSync(shim, 'export const NextResponse = { json: (body, init) => Response.json(body, init) };');
const auth = join(dir, 'auth.mjs');
writeFileSync(auth, `export async function requireUser() { return { actor: { userId: 'user-1', cmdrName: 'CMDR Test', email: 'test@example.com', isPreview: false } }; }
export function errorResponse(e) { return Response.json({ error: e.message }, { status: 500 }); }`);
async function load(entry, name) {
  const outfile = join(dir, `${name}.cjs`);
  await build({ entryPoints: [join(root, entry)], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    alias: { '@': join(root, 'src'), 'next/server': shim, '@/lib/billing/auth': auth } });
  return require(outfile);
}
const { tbank, tbankToken, rubToKopecks } = await load('src/lib/billing/tbank.ts', 'driver');
const { getDriver, maskConfig, mergeConfig } = await load('src/lib/billing/providers.ts', 'providers');
const { billingRepo: repo } = await load('src/lib/billingData.ts', 'repo');
const webhook = await load('src/app/api/billing/webhooks/[provider]/route.ts', 'webhook');
const checkout = await load('src/app/api/billing/checkout/route.ts', 'checkout');
const password = 'test-password-not-a-real-secret';
const provider = { id: 'tbank', name: 'Т-Банк', test_mode: true, is_enabled: true,
  config: { terminal_key: '123DEMO', password }, methods: ['card'], display_order: 5 };
const baseIntent = { id: 'pi-test-order', provider_id: 'tbank', amount_rub: 290.01, currency: 'RUB' };
const input = { intent: baseIntent, description: 'Подписка «Пионер»', returnUrl: 'https://shop.example.com/premium-shop/pay/pi-test-order' };
// Independent signature builder for notifications, so driver and test do not
// accidentally agree on an incorrect implementation.
function sign(data, secret = password) {
  const pairs = Object.entries(data).filter(([key, value]) => key !== 'Token' && value !== null && typeof value !== 'object');
  pairs.push(['Password', secret]);
  return crypto.createHash('sha256').update(pairs.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, value]) => String(value)).join('')).digest('hex');
}
function notification(intent = baseIntent, extra = {}) {
  const data = { TerminalKey: '123DEMO', OrderId: intent.id, PaymentId: intent.external_id || '987654321',
    Amount: Math.round(intent.amount_rub * 100), Status: 'CONFIRMED', Success: true, ErrorCode: '0', ...extra };
  return { ...data, Token: sign(data) };
}
const parse = (data, p = provider) => tbank.parseWebhook(p, { headers: new Headers(), rawBody: JSON.stringify(data), query: new URLSearchParams() });
const deliver = (data) => webhook.POST(new Request('https://shop.example.com/api/billing/webhooks/tbank', {
  method: 'POST', body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' },
}), { params: Promise.resolve({ provider: 'tbank' }) });
let paymentCounter = 1000;
function mockBank(override = {}) {
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://securepay.tinkoff.ru/v2/Init');
    const body = JSON.parse(options.body);
    assert.equal(body.Token, sign(body));
    return Response.json({ Success: true, ErrorCode: '0', TerminalKey: body.TerminalKey, OrderId: body.OrderId,
      Amount: body.Amount, PaymentId: String(++paymentCounter), PaymentURL: 'https://securepay.tinkoff.ru/payment/test', ...override });
  };
}
async function createIntent(overrides = {}) {
  const it = await repo.createIntent({ userId: 'user-1', cmdrName: 'Test', providerId: 'tbank',
    purpose: 'credit_topup', targetId: 'pack-500', amountRub: 79, amountCredits: 500 });
  return repo.updateIntent(it.id, { external_id: String(++paymentCounter), ...overrides });
}
async function buy(body) {
  return checkout.POST(new Request('https://shop.example.com/api/billing/checkout', {
    method: 'POST', body: JSON.stringify({ providerId: 'tbank', ...body }), headers: { 'Content-Type': 'application/json' },
  }));
}
beforeEach(async () => {
  globalThis.fetch = async () => { throw new Error('Unexpected network access'); };
  process.env.NEXT_PUBLIC_SITE_URL = 'https://shop.example.com';
  await repo.getProviders();
  const db = globalThis.__billingAdapter;
  for (const table of ['payment_intents', 'payment_webhook_events', 'user_balances', 'billing_transactions', 'user_subscriptions', 'user_inventory', 'user_cosmetics_equipped']) {
    await db.removeWhere(table, {});
  }
  await repo.updateProvider('tbank', provider);
});

test('T-Bank registers and secrets are masked/preserved by the existing admin helpers', () => {
  assert.equal(getDriver('tbank').name, 'Т-Банк');
  const masked = maskConfig(tbank, provider.config);
  assert.notEqual(masked.password, password);
  assert.equal(mergeConfig(tbank, provider.config, masked).password, password);
});

test('token matches the official UTF-8 vector; nested fields and Token are excluded', () => {
  const data = { TerminalKey: 'MerchantTerminalKey', Amount: 19200, OrderId: '00000', Description: 'Подарочная карта на 1000 рублей' };
  assert.equal(tbankToken(data, '11111111111111'), '72dd466f8ace0a37a1f740ce5fb78101712bc0665d91a8108c7c8a0ccd426db2');
  assert.equal(tbankToken({ ...data, DATA: { Email: 'a@b.c' }, Receipt: { Items: [] }, Token: 'ignored', Null: null }, '11111111111111'), tbankToken(data, '11111111111111'));
  const boolData = { ...data, Success: true };
  assert.equal(tbankToken(boolData, password), sign(boolData));
  assert.equal(rubToKopecks(290.01), 29001);
  for (const value of [0, -1, NaN, Infinity, 1.001, Number.MAX_SAFE_INTEGER]) assert.throws(() => rubToKopecks(value));
});

test('Init is signed, in kopecks, one-stage, with same success/failure return and no card binding', async () => {
  let body;
  mockBank();
  const bank = globalThis.fetch;
  globalThis.fetch = (url, options) => { body = JSON.parse(options.body); return bank(url, options); };
  const result = await tbank.createPayment(provider, input);
  assert.equal(result.paymentUrl, 'https://securepay.tinkoff.ru/payment/test');
  assert.equal(body.Amount, 29001);
  assert.equal(body.OrderId, input.intent.id);
  assert.equal(body.PayType, 'O');
  assert.equal(body.NotificationURL, 'https://shop.example.com/api/billing/webhooks/tbank');
  assert.equal(body.SuccessURL, body.FailURL);
  for (const key of ['Recurrent', 'CustomerKey', 'RebillId', 'Password', 'Receipt']) assert.equal(body[key], undefined);
});

test('configuration check does not pretend to validate credentials remotely; DEMO/live cannot be mixed', async () => {
  assert.match((await tbank.check(provider)).message, /не проверены/);
  for (const p of [
    { ...provider, test_mode: false },
    { ...provider, config: { ...provider.config, terminal_key: '123' } },
    { ...provider, test_mode: false, config: { ...provider.config, terminal_key: '123' } },
  ]) {
    assert.equal((await tbank.check(p)).ok, false);
    await assert.rejects(tbank.createPayment(p, input));
  }
  const live = { ...provider, test_mode: false, config: { ...provider.config, terminal_key: '123', external_receipts_confirmed: true } };
  assert.equal((await tbank.check(live)).ok, true);
});

test('invalid currency, callback origin, amount and bank response never return a checkout URL', async () => {
  await assert.rejects(tbank.createPayment(provider, { ...input, intent: { ...baseIntent, currency: 'USD' } }));
  await assert.rejects(tbank.createPayment(provider, { ...input, returnUrl: 'https://attacker.example/pay' }));
  process.env.NEXT_PUBLIC_SITE_URL = 'http://localhost:3000';
  await assert.rejects(tbank.createPayment(provider, { ...input, returnUrl: 'http://localhost:3000/pay' }));
  process.env.NEXT_PUBLIC_SITE_URL = 'https://shop.example.com';
  for (const patch of [{ Success: false }, { ErrorCode: '999' }, { PaymentURL: 'javascript:alert(1)' },
    { PaymentURL: null }, { PaymentId: null }, { Amount: 1 }, { OrderId: 'another-order' }, { TerminalKey: 'another-terminal' }]) {
    mockBank(patch);
    await assert.rejects(tbank.createPayment(provider, input));
  }
  globalThis.fetch = async () => new Response('not JSON', { status: 502 });
  await assert.rejects(tbank.createPayment(provider, input), /некорректный ответ/);
});

test('only signed successful CONFIRMED fulfils; holds, refunds and reversals do not', async () => {
  const statuses = { CONFIRMED: 'paid', AUTHORIZED: 'pending', NEW: 'pending', REJECTED: 'failed',
    CANCELED: 'canceled', DEADLINE_EXPIRED: 'canceled', REFUNDED: 'pending', PARTIAL_REFUNDED: 'pending', REVERSED: 'pending' };
  for (const [Status, expected] of Object.entries(statuses)) {
    const parsed = await parse(notification(baseIntent, { Status }));
    assert.equal(parsed.ok, true, Status);
    assert.equal(parsed.status, expected, Status);
  }
  for (const patch of [{ Success: false }, { Success: 'true' }, { ErrorCode: '99' }, { Amount: '29001' },
    { PaymentId: {} }, { OrderId: 42 }, { TerminalKey: 'other' }]) assert.equal((await parse(notification(baseIntent, patch))).ok, false);
  assert.equal((await parse({ ...notification(), Amount: 1 })).ok, false);
  assert.equal((await parse(notification(), { ...provider, config: { ...provider.config, password: 'wrong' } })).ok, false);
  for (const Token of ['', 'a'.repeat(63), 'z'.repeat(64), null]) assert.equal((await parse({ ...notification(), Token })).ok, false);
  for (const rawBody of ['oops', 'null', '[]', '"string"']) assert.equal((await tbank.parseWebhook(provider, { rawBody })).ok, false);
});

test('checkout uses server catalogue prices; confirmed webhook issues credits and replies exactly OK', async () => {
  mockBank();
  const response = await buy({ purpose: 'credit_topup', packId: 'pack-500', amountRub: 0.01, amountCredits: 999999 });
  assert.equal(response.status, 200);
  const { intent } = await response.json();
  assert.equal(intent.amount_rub, 79);
  assert.equal(intent.amount_credits, 500);
  assert.equal((await repo.getUserBalance('user-1')).credits, 0);
  const hold = await deliver(notification(intent, { Status: 'AUTHORIZED' }));
  assert.equal(await hold.text(), 'OK');
  assert.equal((await repo.getIntent(intent.id)).status, 'pending');
  const confirmed = await deliver(notification(intent));
  assert.equal(confirmed.status, 200);
  assert.equal(await confirmed.text(), 'OK');
  assert.equal((await repo.getUserBalance('user-1')).credits, 500);
  assert.equal((await repo.getIntent(intent.id)).status, 'paid');
});

test('concurrent and sequential repeated confirmations do not double-credit', async () => {
  const intent = await createIntent();
  const replies = await Promise.all(Array.from({ length: 10 }, () => deliver(notification(intent))));
  assert.ok(replies.some((r) => r.status === 200));
  assert.ok(replies.every((r) => [200, 500].includes(r.status)));
  assert.equal((await deliver(notification(intent))).status, 200);
  assert.equal((await repo.getUserBalance('user-1')).credits, 500);
  assert.equal(await globalThis.__billingAdapter.count('billing_transactions'), 1);
});

test('provider/order/payment/amount/currency mismatches never grant a purchase', async () => {
  const intent = await createIntent();
  for (const patch of [{ Amount: 1 }, { PaymentId: '123' }, { OrderId: 'unknown-order' }]) {
    assert.notEqual((await deliver(notification(intent, patch))).status, 200);
  }
  await repo.updateIntent(intent.id, { currency: 'USD' });
  assert.equal((await deliver(notification(intent))).status, 400);
  await repo.updateIntent(intent.id, { currency: 'RUB', provider_id: 'manual' });
  assert.equal((await deliver(notification(intent))).status, 400);
  assert.equal((await repo.getUserBalance('user-1')).credits, 0);
});

test('Init persistence race is retried; disabled provider still handles existing orders; GET rejected', async () => {
  const intent = await createIntent({ external_id: null });
  const data = notification(intent);
  assert.equal((await deliver(data)).status, 503);
  await repo.updateIntent(intent.id, { external_id: data.PaymentId });
  await repo.updateProvider('tbank', { is_enabled: false });
  assert.equal(await (await deliver(data)).text(), 'OK');
  const get = await webhook.GET(new Request('https://shop.example.com/api/billing/webhooks/tbank'), { params: Promise.resolve({ provider: 'tbank' }) });
  assert.equal(get.status, 405);
});

test('bank refusals change pending status but late refusals cannot overwrite fulfilled payment', async () => {
  const intent = await createIntent();
  assert.equal(await (await deliver(notification(intent, { Status: 'REJECTED', Success: false, ErrorCode: '1051' }))).text(), 'OK');
  assert.equal((await repo.getIntent(intent.id)).status, 'failed');
  assert.equal((await repo.getUserBalance('user-1')).credits, 0);
  const paid = await createIntent();
  await deliver(notification(paid));
  await deliver(notification(paid, { Status: 'CANCELED' }));
  assert.equal((await repo.getIntent(paid.id)).status, 'paid');
});

test('notification audit never persists reusable signature, card data or rebill token', async () => {
  const intent = await createIntent();
  const payload = notification(intent, { Pan: '200000******0000', CardId: '99', ExpDate: '1228', RebillId: 'sensitive', DATA: { nested: 'private' } });
  await deliver(payload);
  await deliver({ ...payload, Token: 'invalid' });
  const events = await repo.listWebhookEvents();
  for (const ev of events) {
    for (const key of ['Token', 'Pan', 'CardId', 'ExpDate', 'RebillId', 'DATA']) assert.equal(ev.payload[key], undefined);
  }
  assert.ok(events.some((e) => e.error === 'Bad signature'));
});

test('subscription payments extend the same plan manually; cosmetics are delivered by existing shop flow', async () => {
  mockBank();
  const first = await (await buy({ purpose: 'subscription', planId: 'pioneer' })).json();
  assert.ok(first.intent, JSON.stringify(first));
  await deliver(notification(first.intent));
  const sub = await repo.getUserSubscription('user-1');
  assert.equal(sub.auto_renew, false);
  const second = await (await buy({ purpose: 'subscription', planId: 'pioneer' })).json();
  await deliver(notification(second.intent));
  const extended = await repo.getUserSubscription('user-1');
  assert.equal(extended.auto_renew, false);
  assert.equal(new Date(extended.expires_at) - new Date(sub.expires_at), 30 * 86400000);
  const item = await (await buy({ purpose: 'shop_purchase', itemId: 'frame-subzero' })).json();
  assert.ok(item.intent, JSON.stringify(item));
  assert.equal((await deliver(notification(item.intent))).status, 200);
  assert.equal(await repo.userOwnsItem('user-1', 'frame-subzero'), true);
});

test('partial fulfilment failure keeps the claim, never marks paid or silently repeats side effects', async () => {
  const intent = await createIntent();
  const original = repo.topupBalance;
  let attempts = 0;
  repo.topupBalance = async () => { attempts++; throw new Error('Simulated storage interruption'); };
  try {
    assert.equal((await deliver(notification(intent))).status, 500);
    assert.equal((await repo.getIntent(intent.id)).status, 'processing');
    assert.equal((await deliver(notification(intent))).status, 500);
    assert.equal(attempts, 1);
    await repo.updatePendingIntent(intent.id, { status: 'failed' });
    assert.equal((await repo.getIntent(intent.id)).status, 'processing');
  } finally { repo.topupBalance = original; }
});

test('live checkout is blocked on file storage and API errors leave an unfulfilled intent', async () => {
  await repo.updateProvider('tbank', { test_mode: false, config: { ...provider.config, terminal_key: '123', external_receipts_confirmed: true } });
  assert.equal((await buy({ purpose: 'credit_topup', packId: 'pack-500' })).status, 503);
  await repo.updateProvider('tbank', provider);
  mockBank({ Success: false, ErrorCode: '7', Message: password });
  const failed = await buy({ purpose: 'credit_topup', packId: 'pack-500' });
  assert.equal(failed.status, 502);
  assert.equal((await failed.text()).includes(password), false);
  const intents = await repo.listIntents();
  assert.equal(intents.length, 1);
  assert.equal(intents[0].status, 'failed');
  assert.equal((await repo.getUserBalance('user-1')).credits, 0);
});
