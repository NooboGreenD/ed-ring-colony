/**
 * Минимальный подписчик ZeroMQ (ZMTP 3.0, механизм NULL) без нативных модулей.
 *
 * Реле EDDN (`tcp://eddn.edcd.io:9500`) — обычный сокет PUB библиотеки
 * libzmq: без шифрования и без пульса (EDCD/EDDN, src/eddn/Relay.py). Для
 * подписки хватает малой части протокола (https://rfc.zeromq.org/spec/23/):
 *
 *   1. приветствие — 64 байта: сигнатура FF…7F, версия 3.0, механизм «NULL»;
 *   2. рукопожатие NULL — команда READY со свойством Socket-Type=SUB, в ответ
 *      READY реле;
 *   3. подписка — сообщение «0x01 + префикс» (в ZMTP 3.0 так, команда
 *      SUBSCRIBE появилась в 3.1); пустой префикс — все сообщения;
 *   4. дальше — кадры: флаги (MORE, LONG, COMMAND), длина (1 или 8 байт) и тело.
 *      Сообщение — кадры до первого без MORE. На PING (ZMTP 3.1) отвечаем PONG,
 *      хотя реле EDDN его не шлёт.
 *
 * Модулю не важно, что внутри сообщений: это делает `listener.ts`. Пакет
 * `zeromq` (нативный аддон) для этого не нужен — и образ Docker не меняется.
 */

import net from 'node:net';

export const ZMTP_GREETING_BYTES = 64;
const FLAG_MORE = 0x01;
const FLAG_LONG = 0x02;
const FLAG_COMMAND = 0x04;
/** Больше реле не шлёт: сообщения EDDN — сжатый JSON в единицы килобайт. */
const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;

export interface ZmtpCloseInfo {
  /** closed — реле закрыло; error — ошибка сети; timeout — нет рукопожатия; protocol — не ZMTP; иначе — причина из `close()`. */
  reason: string;
  error: string | null;
  /** Рукопожатие прошло, подписка отправлена. */
  ready: boolean;
  bytes: number;
  messages: number;
}

export interface ZmtpSubscribeOptions {
  host: string;
  port: number;
  /** Префикс подписки; пустой — все сообщения. */
  topic?: string;
  handshakeTimeoutMs?: number;
  maxMessageBytes?: number;
  onReady?: (peer: { socketType: string | null }) => void;
  onMessage: (frames: Buffer[]) => void;
  /** Пришли байты (любые) — для сторожа «тишины». */
  onData?: (bytes: number) => void;
  onClose: (info: ZmtpCloseInfo) => void;
  /** Для тестов: своё соединение вместо `net.connect`. */
  connect?: (port: number, host: string) => net.Socket;
}

export interface ZmtpSession {
  close(reason?: string): void;
  readonly ready: boolean;
  readonly bytes: number;
  readonly messages: number;
}

/** Приветствие ZMTP 3.0, механизм NULL, клиент (as-server = 0). */
export function zmtpGreeting(): Buffer {
  const greeting = Buffer.alloc(ZMTP_GREETING_BYTES, 0);
  greeting[0] = 0xff;
  greeting[9] = 0x7f;
  greeting[10] = 3;
  greeting[11] = 0;
  greeting.write('NULL', 12, 'ascii');
  return greeting;
}

/** Кадр: флаги, длина (короткая до 255 байт, иначе 8 байт), тело. */
export function zmtpFrame(body: Buffer, options: { command?: boolean; more?: boolean } = {}): Buffer {
  const long = body.length > 255;
  const header = Buffer.alloc(long ? 9 : 2);
  header[0] = (options.more ? FLAG_MORE : 0) | (long ? FLAG_LONG : 0) | (options.command ? FLAG_COMMAND : 0);
  if (long) header.writeBigUInt64BE(BigInt(body.length), 1);
  else header[1] = body.length;
  return Buffer.concat([header, body]);
}

/** Команда: имя (байт длины + ASCII) и полезная нагрузка. */
export function zmtpCommand(name: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  return zmtpFrame(Buffer.concat([Buffer.from([name.length]), Buffer.from(name, 'ascii'), payload]), { command: true });
}

/** Свойства метаданных READY: имя (байт длины) и значение (4 байта длины). */
export function zmtpProperties(properties: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [key, value] of Object.entries(properties)) {
    const raw = Buffer.from(value, 'utf8');
    const size = Buffer.alloc(4);
    size.writeUInt32BE(raw.length);
    parts.push(Buffer.from([key.length]), Buffer.from(key, 'ascii'), size, raw);
  }
  return Buffer.concat(parts);
}

export function parseZmtpProperties(payload: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let offset = 0;
  while (offset < payload.length) {
    const keyLength = payload[offset];
    offset += 1;
    if (offset + keyLength + 4 > payload.length) break;
    const key = payload.subarray(offset, offset + keyLength).toString('ascii');
    offset += keyLength;
    const valueLength = payload.readUInt32BE(offset);
    offset += 4;
    if (offset + valueLength > payload.length) break;
    out[key.toLowerCase()] = payload.subarray(offset, offset + valueLength).toString('utf8');
    offset += valueLength;
  }
  return out;
}

function parseCommand(body: Buffer): { name: string; payload: Buffer } {
  const length = body[0] ?? 0;
  return { name: body.subarray(1, 1 + length).toString('ascii'), payload: body.subarray(1 + length) };
}

/**
 * Подписаться на PUB-сокет. Сессия одна на соединение: после `onClose`
 * нужна новая (переподключение решает вызывающий — `listener.ts`).
 */
export function zmtpSubscribe(options: ZmtpSubscribeOptions): ZmtpSession {
  const maxBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const socket = (options.connect ?? ((port: number, host: string) => net.connect({ port, host })))(options.port, options.host);
  let buffer: Buffer = Buffer.alloc(0);
  let stage: 'greeting' | 'handshake' | 'traffic' = 'greeting';
  let parts: Buffer[] = [];
  let partsBytes = 0;
  let ready = false;
  let closed = false;
  let bytes = 0;
  let messages = 0;
  let closeReason: string | null = null;
  let closeError: string | null = null;

  const close = (reason: string, error: string | null = null) => {
    if (closed) return;
    closeReason ??= reason;
    closeError ??= error;
    socket.destroy();
  };

  const timer = setTimeout(
    () => close('timeout', `реле не завершило рукопожатие за ${Math.round((options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS) / 1000)} с`),
    options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
  );
  timer.unref?.();

  const readFrame = (): { more: boolean; command: boolean; body: Buffer } | null => {
    if (buffer.length < 2) return null;
    const flags = buffer[0];
    const long = (flags & FLAG_LONG) !== 0;
    const headerBytes = long ? 9 : 2;
    if (buffer.length < headerBytes) return null;
    const size = long ? Number(buffer.readBigUInt64BE(1)) : buffer[1];
    if (!Number.isSafeInteger(size) || size > maxBytes) throw new Error(`кадр ${size} байт — больше допустимого`);
    if (buffer.length < headerBytes + size) return null;
    const body = buffer.subarray(headerBytes, headerBytes + size);
    buffer = buffer.subarray(headerBytes + size);
    return { more: (flags & FLAG_MORE) !== 0, command: (flags & FLAG_COMMAND) !== 0, body };
  };

  const drain = () => {
    for (;;) {
      if (stage === 'greeting') {
        if (buffer.length < ZMTP_GREETING_BYTES) return;
        const greeting = buffer.subarray(0, ZMTP_GREETING_BYTES);
        buffer = buffer.subarray(ZMTP_GREETING_BYTES);
        if (greeting[0] !== 0xff || greeting[9] !== 0x7f) throw new Error('это не ZeroMQ: неверная сигнатура приветствия');
        if (greeting[10] < 3) throw new Error(`ZMTP ${greeting[10]}.x не поддерживается`);
        const mechanism = greeting.subarray(12, 32).toString('ascii').replace(/\0+$/, '');
        if (mechanism !== 'NULL') throw new Error(`механизм безопасности ${mechanism} не поддерживается`);
        socket.write(zmtpCommand('READY', zmtpProperties({ 'Socket-Type': 'SUB' })));
        stage = 'handshake';
        continue;
      }
      const frame = readFrame();
      if (!frame) return;
      if (stage === 'handshake') {
        if (!frame.command) throw new Error('реле прислало данные до рукопожатия');
        const { name, payload } = parseCommand(frame.body);
        if (name === 'ERROR') throw new Error(`реле отказало: ${payload.subarray(1).toString('utf8') || 'без причины'}`);
        if (name !== 'READY') throw new Error(`ожидалась команда READY, пришла ${name || '?'}`);
        const peer = parseZmtpProperties(payload);
        socket.write(zmtpFrame(Buffer.concat([Buffer.from([0x01]), Buffer.from(options.topic ?? '', 'utf8')])));
        stage = 'traffic';
        ready = true;
        clearTimeout(timer);
        options.onReady?.({ socketType: peer['socket-type'] ?? null });
        continue;
      }
      if (frame.command) {
        const { name, payload } = parseCommand(frame.body);
        // PING: TTL (2 байта) и контекст — PONG возвращает контекст.
        if (name === 'PING') socket.write(zmtpCommand('PONG', payload.subarray(2)));
        else if (name === 'ERROR') throw new Error(`реле закрыло подписку: ${payload.subarray(1).toString('utf8') || 'без причины'}`);
        continue;
      }
      parts.push(frame.body);
      partsBytes += frame.body.length;
      if (partsBytes > maxBytes) throw new Error(`сообщение больше ${maxBytes} байт`);
      if (!frame.more) {
        const message = parts;
        parts = [];
        partsBytes = 0;
        messages += 1;
        options.onMessage(message);
      }
    }
  };

  socket.setNoDelay?.(true);
  socket.on('connect', () => {
    socket.write(zmtpGreeting());
  });
  socket.on('data', (chunk: Buffer) => {
    if (closed) return;
    bytes += chunk.length;
    options.onData?.(chunk.length);
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    try {
      drain();
    } catch (error) {
      close('protocol', error instanceof Error ? error.message : String(error));
    }
  });
  socket.on('error', (error: Error) => {
    closeReason ??= 'error';
    closeError ??= error.message;
  });
  socket.on('close', () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    options.onClose({ reason: closeReason ?? 'closed', error: closeError, ready, bytes, messages });
  });

  return {
    close: (reason = 'manual') => close(reason),
    get ready() {
      return ready;
    },
    get bytes() {
      return bytes;
    },
    get messages() {
      return messages;
    },
  };
}
