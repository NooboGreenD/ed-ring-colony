/**
 * Привязка лаунчера к учётной записи и перенос настроек Helper.
 *
 * Пароль на компьютере не хранится: пилот берёт короткий код в профиле на
 * сайте и вводит его в лаунчере. Код одноразовый, живёт десять минут и лежит
 * в базе хешем; токен устройства — тоже хешем. Так утечка дампа не даёт войти
 * в чужую учётную запись, а отозвать устройство можно одной кнопкой.
 *
 * Что переносится: профили раскладки оверлея и позиции блоков (снимок JSON).
 * Ничего исполняемого и никаких ключей подключений здесь нет.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';

import { nickFromUser, avatarFromUser } from '@/lib/authProfile';
import { createServiceClient } from '@/lib/supabaseServer';

/** Сколько живёт код привязки. */
export const LINK_CODE_TTL_SECONDS = 10 * 60;
/** Алфавит без похожих символов: код диктуют и вводят руками. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const LINK_CODE_LENGTH = 8;
/** Потолок снимка настроек: раскладка оверлея — это килобайты, не мегабайты. */
export const MAX_SETTINGS_BYTES = 256 * 1024;

export interface HelperProfile {
  userId: string;
  nick: string;
  avatarUrl: string | null;
  cmdrName: string;
  role: string;
}

export interface HelperDevice {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface HelperSettingsSnapshot {
  payload: Record<string, unknown>;
  updatedAt: string;
  deviceName: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Нормализовать код: пользователь мог ввести его строчными и с дефисами. */
export function normalizeLinkCode(value: unknown): string {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function generateCode(): string {
  let code = '';
  for (let index = 0; index < LINK_CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Создать код привязки. Прошлые неиспользованные коды пилота гасятся: держать
 * несколько живых кодов незачем, а лишний код — лишний шанс его подсмотреть.
 */
export async function createLinkCode(userId: string): Promise<{ code: string; expiresAt: string }> {
  const svc = createServiceClient();
  const now = new Date();
  await svc
    .from('helper_link_codes')
    .update({ used_at: now.toISOString() })
    .eq('user_id', userId)
    .is('used_at', null);

  // Коллизию по хешу почти невозможно встретить, но код всё равно пробуем
  // записать несколько раз: вставка с дублем — это ошибка, а не ответ.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateCode();
    const expiresAt = new Date(now.getTime() + LINK_CODE_TTL_SECONDS * 1000).toISOString();
    const { error } = await svc.from('helper_link_codes').insert({
      code_hash: sha256(code),
      user_id: userId,
      expires_at: expiresAt,
    });
    if (!error) return { code, expiresAt };
    if (!/duplicate|unique/i.test(error.message ?? '')) {
      throw new Error(error.message || 'Не удалось создать код привязки');
    }
  }
  throw new Error('Не удалось создать код привязки');
}

export interface ClaimResult {
  ok: boolean;
  error?: string;
  token?: string;
  deviceId?: string;
  profile?: HelperProfile;
}

/**
 * Обменять код на токен устройства.
 *
 * Код гасится до выдачи токена: два одновременных запроса с одним кодом не
 * должны получить два живых устройства. Повторный ввод того же кода отвечает
 * «код уже использован», а не «неверный код» — так пилоту понятно, что идти
 * за новым нужно именно за новым.
 */
export async function claimLinkCode(rawCode: unknown, deviceName: string): Promise<ClaimResult> {
  const code = normalizeLinkCode(rawCode);
  if (code.length !== LINK_CODE_LENGTH) {
    return { ok: false, error: 'Код привязки состоит из 8 символов.' };
  }
  const svc = createServiceClient();
  const codeHash = sha256(code);
  const now = new Date();
  const { data: row, error } = await svc
    .from('helper_link_codes')
    .select('code_hash, user_id, expires_at, used_at')
    .eq('code_hash', codeHash)
    .maybeSingle();
  if (error) return { ok: false, error: 'Не удалось проверить код.' };
  if (!row) return { ok: false, error: 'Код не найден. Проверьте символы или получите новый в профиле.' };
  if (row.used_at) return { ok: false, error: 'Этот код уже использован. Получите новый в профиле.' };
  if (new Date(row.expires_at).getTime() < now.getTime()) {
    return { ok: false, error: 'Код истёк. Получите новый в профиле.' };
  }

  const { data: updated, error: burnError } = await svc
    .from('helper_link_codes')
    .update({ used_at: now.toISOString() })
    .eq('code_hash', codeHash)
    .is('used_at', null)
    .select('user_id')
    .maybeSingle();
  if (burnError) return { ok: false, error: 'Не удалось использовать код.' };
  if (!updated?.user_id) return { ok: false, error: 'Этот код уже использован. Получите новый в профиле.' };

  const userId = String(updated.user_id);
  const token = randomBytes(32).toString('hex');
  const name = deviceName.trim().slice(0, 64);
  const { data: device, error: deviceError } = await svc
    .from('helper_devices')
    .insert({ user_id: userId, name, token_hash: sha256(token) })
    .select('id')
    .maybeSingle();
  if (deviceError || !device) return { ok: false, error: 'Не удалось привязать устройство.' };

  await svc
    .from('helper_link_codes')
    .update({ device_id: device.id })
    .eq('code_hash', codeHash);

  const profile = await loadProfile(userId);
  return { ok: true, token, deviceId: String(device.id), profile };
}

async function loadProfile(userId: string): Promise<HelperProfile> {
  const svc = createServiceClient();
  const [{ data: authUser }, { data: profileRow }] = await Promise.all([
    svc.auth.admin.getUserById(userId).catch(() => ({ data: { user: null } })),
    svc.from('profiles').select('cmdr_name, avatar_url, role').eq('id', userId).maybeSingle(),
  ]);
  const user = (authUser as { user?: Record<string, unknown> | null } | null)?.user ?? null;
  const nick = nickFromUser(user as never, profileRow as never);
  return {
    userId,
    nick,
    avatarUrl: avatarFromUser(user as never, profileRow as never),
    cmdrName: String((profileRow as { cmdr_name?: string | null } | null)?.cmdr_name ?? ''),
    role: String((profileRow as { role?: string | null } | null)?.role ?? ''),
  };
}

export interface DeviceAuth {
  userId: string;
  deviceId: string;
  deviceName: string;
}

/** Владелец токена устройства из `Authorization: Bearer …`. */
export async function resolveDeviceToken(request: Request): Promise<DeviceAuth | null> {
  const authorization = request.headers.get('authorization') || '';
  if (!authorization.toLowerCase().startsWith('bearer ')) return null;
  const token = authorization.slice(7).trim();
  if (!token || token.length > 200) return null;
  const svc = createServiceClient();
  const { data, error } = await svc
    .from('helper_devices')
    .select('id, user_id, name, revoked_at')
    .eq('token_hash', sha256(token))
    .maybeSingle();
  if (error || !data || data.revoked_at || !data.user_id) return null;
  try {
    const pending = svc
      .from('helper_devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', data.id);
    if (pending && typeof pending.then === 'function') pending.then(() => undefined, () => undefined);
  } catch {
    // Отметка «видели» не критична для ответа.
  }
  return { userId: String(data.user_id), deviceId: String(data.id), deviceName: String(data.name ?? '') };
}

export async function profileForDevice(auth: DeviceAuth): Promise<HelperProfile> {
  return loadProfile(auth.userId);
}

export async function listDevices(userId: string): Promise<HelperDevice[]> {
  const svc = createServiceClient();
  const { data, error } = await svc
    .from('helper_devices')
    .select('id, name, created_at, last_seen_at')
    .eq('user_id', userId)
    .is('revoked_at', null)
    .order('last_seen_at', { ascending: false })
    .limit(50);
  if (error || !data) return [];
  return data.map((row) => ({
    id: String(row.id),
    name: String(row.name ?? ''),
    createdAt: String(row.created_at ?? ''),
    lastSeenAt: String(row.last_seen_at ?? ''),
  }));
}

/**
 * Отозвать устройство пилота.
 *
 * Успех — это когда обновление действительно затронуло строку: `update` без
 * совпадений Supabase не считает ошибкой, и прежняя версия отвечала «готово»
 * даже на чужое устройство. Возвращаем `true` только по изменённой строке.
 */
export async function revokeDevice(userId: string, deviceId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(deviceId)) return false;
  const svc = createServiceClient();
  const { data, error } = await svc
    .from('helper_devices')
    .update({ revoked_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('id', deviceId)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle();
  if (error) return false;
  return Boolean(data && (data as { id?: string }).id);
}

export async function readSettings(userId: string): Promise<HelperSettingsSnapshot | null> {
  const svc = createServiceClient();
  const { data, error } = await svc
    .from('helper_settings')
    .select('payload, updated_at, device_name')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    payload: (data.payload ?? {}) as Record<string, unknown>,
    updatedAt: String(data.updated_at ?? ''),
    deviceName: String(data.device_name ?? ''),
  };
}

/**
 * Сохранить снимок настроек.
 *
 * Размер проверяется до записи: раскладка оверлея — это килобайты, а мегабайты
 * в этой таблице означали бы, что туда пытаются положить что-то другое.
 */
export async function writeSettings(
  userId: string,
  payload: unknown,
  deviceName: string,
): Promise<{ ok: boolean; error?: string; updatedAt?: string }> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'Настройки должны быть объектом.' };
  }
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SETTINGS_BYTES) {
    return { ok: false, error: `Снимок настроек больше ${Math.round(MAX_SETTINGS_BYTES / 1024)} КБ.` };
  }
  const svc = createServiceClient();
  const updatedAt = new Date().toISOString();
  const { error } = await svc
    .from('helper_settings')
    .upsert({
      user_id: userId,
      payload,
      device_name: deviceName.slice(0, 64),
      updated_at: updatedAt,
    }, { onConflict: 'user_id' });
  if (error) return { ok: false, error: error.message || 'Не удалось сохранить настройки.' };
  return { ok: true, updatedAt };
}
