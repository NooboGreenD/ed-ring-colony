/**
 * Почему прямой Postgres «недоступен»: отдельная проверка DNS и TCP.
 *
 * Драйвер `pg` на любую сетевую беду отвечает одной строкой — `timeout
 * expired`. Для оператора это бесполезно: одинаково выглядят «имя `db`
 * вообще не резолвится», «резолвится, но в чужой адрес» и «адрес верный, но
 * порт закрыт». Разные причины — разные действия, поэтому перед вердиктом
 * мы отдельно спрашиваем резолвер и отдельно открываем сокет.
 *
 * Самый частый случай на self-hosted: контейнер `web` не подключён к сети
 * стека Supabase. Тогда `db` либо не резолвится (`EAI_AGAIN`), либо — если у
 * хоста есть DNS с подстановкой/поисковым доменом — резолвится в чужой
 * ПУБЛИЧНЫЙ адрес, и соединение честно висит до таймаута. Второй вариант и
 * выглядит как «firewall», хотя firewall ни при чём.
 */

import { lookup } from 'node:dns/promises';
import { createConnection } from 'node:net';

export type PgReachabilityKind =
  /** Имя не резолвится вообще. */
  | 'dns-missing'
  /** Имя резолвится в публичный адрес — почти наверняка не тот хост. */
  | 'dns-public'
  /** Адрес приватный (docker/LAN), но порт не отвечает. */
  | 'tcp-timeout'
  /** Порт закрыт/соединение отвергнуто — хост жив, Postgres не слушает. */
  | 'tcp-refused'
  /** TCP-рукопожатие прошло: сеть ни при чём. */
  | 'ok';

export interface PgReachability {
  kind: PgReachabilityKind;
  host: string;
  port: number;
  /** Адреса, в которые разрешилось имя (пусто — не разрешилось). */
  addresses: string[];
  /** Готовая строка для лога/панели: что произошло и что делать. */
  message: string;
}

/** Адреса, которые могут принадлежать docker-сети или LAN сервера. */
export function isPrivateAddress(address: string): boolean {
  if (address.startsWith('127.') || address === '::1') return true;
  if (address.startsWith('10.') || address.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return true;
  // IPv6 ULA и link-local.
  if (/^(fc|fd|fe80)/i.test(address)) return true;
  return false;
}

/** Подсказки по каждому исходу — одно место, чтобы панель и CLI говорили одинаково. */
export function reachabilityMessage(kind: PgReachabilityKind, host: string, port: number, addresses: string[]): string {
  const at = `${host}:${port}`;
  switch (kind) {
    case 'dns-missing':
      return (
        `Имя «${host}» не резолвится из этого процесса. Оно существует только внутри docker-сети стека Supabase. ` +
        'Подключите web к ней: deploy/compose.supabase-net.yml (SUPABASE_NETWORK, по умолчанию supabase_default) ' +
        'либо укажите адрес, видимый отсюда (host.docker.internal, 172.17.0.1, IP сервера с опубликованным 5432). ' +
        'Если это уже делалось и подключение «отваливается» снова — значит, контейнер web пересоздали командой ' +
        'docker compose up БЕЗ deploy/compose.supabase-net.yml (другой каталог, старый скрипт, ручной запуск). ' +
        'При запущенном профиле monitoring update-agent сам переподключит web к сети в течение минуты — повторите ' +
        'проверку; кто пересоздал контейнер, видно в журнале: docker logs <проект>-update-agent-1 | grep "сторож сети".'
      );
    case 'dns-public':
      return (
        `Имя «${host}» резолвится в ПУБЛИЧНЫЙ адрес ${addresses.join(', ')} — это не контейнер Supabase, ` +
        'а посторонний хост (DNS провайдера или поисковый домен отвечает на короткое имя). ' +
        'Поэтому соединение и висит до «timeout expired», а не падает сразу: firewall здесь ни при чём. ' +
        'Контейнер web не в сети стека Supabase — подключите его (deploy/compose.supabase-net.yml) ' +
        'или замените host в DATABASE_URL на адрес, который этот контейнер реально видит.'
      );
    case 'tcp-timeout':
      return (
        `Адрес ${addresses.join(', ') || host} найден, но порт ${port} не ответил за отведённое время. ` +
        'Теперь это действительно сеть: проверьте, что контейнер Postgres в одной сети с web ' +
        '(docker network inspect), что правила DOCKER-USER/ufw не режут трафик и что Postgres слушает этот порт.'
      );
    case 'tcp-refused':
      return (
        `Хост ${at} отвечает, но порт закрыт (connection refused). Postgres на нём не слушает: ` +
        'проверьте, что контейнер supabase-db запущен и что порт в DATABASE_URL верный (обычно 5432, ' +
        'а не порт supavisor/pooler).'
      );
    case 'ok':
    default:
      return `TCP до ${at} открывается — сеть в порядке, причина отказа не сетевая (пароль, база, SSL, pg_hba).`;
  }
}

/** Одна попытка открыть TCP-сокет (без Postgres-рукопожатия). */
function probeTcp(host: string, port: number, timeoutMs: number): Promise<'ok' | 'refused' | 'timeout'> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (result: 'ok' | 'refused' | 'timeout') => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done('ok'));
    socket.once('timeout', () => done('timeout'));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      done(error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET' ? 'refused' : 'timeout');
    });
  });
}

/**
 * Проверить, достижим ли Postgres по сети, и объяснить результат.
 *
 * Зависимости (`lookupImpl`/`probeImpl`) инъектируются — тесты не ходят в сеть.
 */
export async function probePgReachability(
  host: string,
  port = 5432,
  options: {
    timeoutMs?: number;
    lookupImpl?: (hostname: string) => Promise<Array<{ address: string }>>;
    probeImpl?: (host: string, port: number, timeoutMs: number) => Promise<'ok' | 'refused' | 'timeout'>;
  } = {},
): Promise<PgReachability> {
  const timeoutMs = options.timeoutMs ?? 4_000;
  const lookupImpl = options.lookupImpl ?? ((hostname: string) => lookup(hostname, { all: true }));
  const probeImpl = options.probeImpl ?? probeTcp;

  let addresses: string[] = [];
  try {
    addresses = (await lookupImpl(host)).map((entry) => entry.address);
  } catch {
    addresses = [];
  }

  const finish = (kind: PgReachabilityKind): PgReachability => ({
    kind,
    host,
    port,
    addresses,
    message: reachabilityMessage(kind, host, port, addresses),
  });

  if (addresses.length === 0) return finish('dns-missing');

  const tcp = await probeImpl(addresses[0], port, timeoutMs);
  if (tcp === 'ok') return finish('ok');
  if (tcp === 'refused') return finish('tcp-refused');
  // Таймаут + публичный адрес = имя увели в сторону; это не firewall.
  if (!addresses.some(isPrivateAddress)) return finish('dns-public');
  return finish('tcp-timeout');
}
