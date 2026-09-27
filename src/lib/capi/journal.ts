// ═══════════════════════════════════════════════════════════════
// Разбор ответа Frontier CAPI `/journal`
// ═══════════════════════════════════════════════════════════════
//
// Endpoint отдаёт СЫРОЙ журнал командира — построчный JSON (NDJSON), ровно
// как файл `Journal.*.log` на диске. Никакого `{"events": [...]}` там нет.
//
// Прежний код делал `res.json()` и затем `journal.events.map(...)`:
//
//   • `res.json()` падал с SyntaxError на второй строке NDJSON;
//   • при пустом теле (HTTP 204 — «в этот день командир не играл») падал
//     на пустой строке;
//   • `journal.events` всегда был `undefined`.
//
// Любой из трёх случаев рвал весь `/api/capi/sync` пятисоткой, и синк не
// сохранял НИЧЕГО — отсюда «данные не подтягиваются» при живой привязке.
//
// Коды ответа (EDCD/FDevIDs → Frontier API):
//   200 — журнал целиком; 204 — в этот день не играли;
//   206 — журнал отдан частично, надо повторить позже; 401 — токен.

import type { CapiJournal, CapiJournalEntry } from '@/types/capi';

/**
 * Разобрать тело `/journal`.
 *
 * Принимает и NDJSON (обычный ответ Frontier), и JSON-массив, и объект
 * `{ events: [...] }` — последние два варианта присылают прокси и десктопные
 * помощники, и терять их данные было бы обидно.
 */
export function parseCapiJournal(
  body: string,
  options: { partial?: boolean } = {},
): CapiJournal {
  const text = (body ?? '').trim();
  const partial = options.partial === true;

  if (!text) {
    return { text: '', events: [], partial, empty: true, malformedLines: 0 };
  }

  // Вариант «одним JSON»: массив событий или объект с полем events.
  if (text.startsWith('[') || text.startsWith('{"events"')) {
    try {
      const parsed = JSON.parse(text);
      const list: unknown[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { events?: unknown }).events)
          ? ((parsed as { events: unknown[] }).events)
          : [];
      const events = list.filter((item): item is CapiJournalEntry =>
        typeof item === 'object' && item !== null && !Array.isArray(item));
      return {
        text: events.map((event) => JSON.stringify(event)).join('\n'),
        events,
        partial,
        empty: events.length === 0,
        malformedLines: list.length - events.length,
      };
    } catch {
      // Не JSON целиком — значит всё-таки NDJSON, разбираем построчно ниже.
    }
  }

  const events: CapiJournalEntry[] = [];
  const lines: string[] = [];
  let malformedLines = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        events.push(parsed as CapiJournalEntry);
        lines.push(line);
        continue;
      }
      malformedLines += 1;
    } catch {
      // Обрезанная последняя строка — обычное дело для частичного ответа
      // (206) и для журнала, который игра пишет прямо сейчас.
      malformedLines += 1;
    }
  }

  return {
    text: lines.join('\n'),
    events,
    partial,
    empty: events.length === 0,
    malformedLines,
  };
}

/**
 * Путь к журналу за конкретную дату.
 *
 * Frontier ждёт сегменты пути `/journal/YYYY/MM/DD`, а не `?date=` — с
 * query-параметром всегда возвращался журнал за сегодня, из-за чего выбор
 * даты в интерфейсе молча ничего не делал.
 */
export function journalPath(date?: string | null): string {
  if (!date) return '/journal';

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!match) throw new Error('CAPI journal date must be YYYY-MM-DD');

  const [, year, month, day] = match;
  return `/journal/${year}/${month}/${day}`;
}
