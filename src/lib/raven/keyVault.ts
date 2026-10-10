/**
 * Хранение RCC-ключа Raven Colonial пользователя на сервере.
 *
 * Ключ нужен, чтобы Архитектор на сайте создавал проект в Raven от имени
 * пользователя. В базе лежит только шифротекст (AES-256-GCM); ключ шифрования
 * берётся из переменной окружения `RAVEN_KEY_SECRET` и в базе не хранится.
 * Наружу (в браузер) ключ не отдаётся никогда — только маска.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const PREFIX = 'v1';

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** Зашифровать ключ. Бросает ошибку, если секрет не задан или пуст. */
export function encryptRavenKey(plain: string, secret: string): string {
  if (!secret) throw new Error('RAVEN_KEY_SECRET не задан: ключ Raven не сохранить');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

/** Расшифровать. Возвращает null, если формат неизвестен или ключ не подходит. */
export function decryptRavenKey(stored: string, secret: string): string | null {
  if (!secret || !stored) return null;
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

/** `abcd…wxyz` — для показа пользователю; короткие ключи не показываем вовсе. */
export function maskRavenKey(key: string): string {
  const value = String(key ?? '').trim();
  if (value.length < 12) return '••••';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}
