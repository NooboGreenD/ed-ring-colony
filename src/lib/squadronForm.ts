/**
 * Разбор формы создания эскадрильи.
 *
 * Почему это отдельный модуль. Создание не работало: страница `/squadrons`
 * отправляла форму как есть, вместе с пустыми строками (`tag: ""`,
 * `power: ""`, `home_system: ""`), а схема проверки требовала у тега от 2 до
 * 10 символов. Пустая строка — не «поле не заполнено», поэтому проверка
 * падала, и пилот получал единственное слово «Некорректные данные
 * эскадрильи» без указания, что именно не так. Второй путь (вкладка
 * «Эскадрилья» в личном кабинете) присылал `tag: undefined`, и тогда в базу
 * уходил `NULL` в колонку `squadrons.tag NOT NULL` — insert падал уже на
 * стороне PostgreSQL.
 *
 * Здесь чистые функции без сети: их зовёт маршрут `POST /api/squadrons`,
 * а тесты проверяют на десятках вариантов ввода.
 */

// Относительный путь с расширением: так модуль грузится и сборкой Next, и
// напрямую в тестах `node --test` (там алиасы `@/` не работают).
import { SQUADRON_MEMBER_LIMIT } from './squadronConstants.ts';

export interface SquadronInput {
  name: string;
  tag: string;
  description: string | null;
  color: string;
  icon: string;
  allegiance: string;
  power: string | null;
  language: string;
  timezone: string;
  member_limit: number;
  discord_url: string | null;
  website_url: string | null;
  recruitment_message: string | null;
  activity_type: string;
  is_open_recruitment: boolean;
  home_system: string | null;
}

export interface SquadronParseResult {
  ok: boolean;
  /** Готовые поля для вставки (только при `ok: true`). */
  value: SquadronInput | null;
  /** Человеческие сообщения об ошибках — их видит пилот. */
  errors: string[];
}

const NAME_MIN = 3;
const NAME_MAX = 100;
const TAG_MIN = 2;
const TAG_MAX = 10;

/** Латиница для тега из кириллического названия. */
const TRANSLIT: Record<string, string> = {
  а: 'A', б: 'B', в: 'V', г: 'G', д: 'D', е: 'E', ё: 'E', ж: 'Z', з: 'Z', и: 'I',
  й: 'I', к: 'K', л: 'L', м: 'M', н: 'N', о: 'O', п: 'P', р: 'R', с: 'S', т: 'T',
  у: 'U', ф: 'F', х: 'H', ц: 'C', ч: 'C', ш: 'S', щ: 'S', ъ: '', ы: 'Y', ь: '',
  э: 'E', ю: 'U', я: 'Y',
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Пустая строка = «поле не заполнено», а не «значение ''». */
function optionalText(value: unknown, max: number): string | null {
  const clean = text(value);
  if (!clean) return null;
  return clean.slice(0, max);
}

/**
 * Тег эскадрильи из того, что ввёл пилот.
 *
 * В игре тег пишут в скобках («[RCV]»), с пробелами и в любом регистре —
 * принимаем всё это, а не отвечаем ошибкой на подсказку из собственного же
 * плейсхолдера «Тег [TAG]».
 */
export function normalizeTag(value: unknown): string {
  return text(value)
    .replace(/[[\]()<>{}]/g, '')
    .replace(/[\s._-]+/g, '')
    .toUpperCase()
    .slice(0, TAG_MAX);
}

/**
 * Запасной тег из названия: нужен, пока в базе `squadrons.tag NOT NULL`
 * (миграция 20261005000000 снимает это ограничение, но обновлять базу ради
 * создания эскадрильи пилот не обязан).
 */
export function tagFromName(name: string): string {
  const source = text(name);
  const translit = Array.from(source.toLowerCase())
    .map((char) => (TRANSLIT[char] !== undefined ? TRANSLIT[char] : char))
    .join('');

  const words = translit.split(/[^a-z0-9]+/i).filter(Boolean);
  if (words.length >= 2) {
    const initials = words.map((word) => word[0]).join('').toUpperCase().slice(0, TAG_MAX);
    if (initials.length >= TAG_MIN) return initials;
  }
  const letters = translit.replace(/[^a-z0-9]/gi, '').toUpperCase();
  if (letters.length >= TAG_MIN) return letters.slice(0, 4);
  return 'SQDN';
}

function validUrl(value: string | null): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Привести тело запроса к строке таблицы `squadrons`.
 *
 * Возвращает либо готовое значение, либо список понятных ошибок — по одной
 * на поле, чтобы интерфейс мог показать все сразу.
 */
export function parseSquadronInput(raw: unknown): SquadronParseResult {
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, value: null, errors: ['Ожидались данные эскадрильи'] };
  }
  const body = raw as Record<string, unknown>;

  const name = text(body.name);
  if (!name) errors.push('Укажите название эскадрильи');
  else if (name.length < NAME_MIN) errors.push(`Название короче ${NAME_MIN} символов`);
  else if (name.length > NAME_MAX) errors.push(`Название длиннее ${NAME_MAX} символов`);

  const tagInput = normalizeTag(body.tag);
  let tag = tagInput;
  if (!tagInput) {
    // Тег необязателен: собираем из названия, а не отказываем в создании.
    tag = tagFromName(name);
  } else if (!/^[A-Z0-9]+$/.test(tagInput)) {
    errors.push('Тег: только латинские буквы и цифры');
  } else if (tagInput.length < TAG_MIN) {
    errors.push(`Тег: не короче ${TAG_MIN} символов`);
  }

  const color = text(body.color) || '#e67e22';
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) errors.push('Цвет: ожидается #RRGGBB');

  const description = optionalText(body.description, 1000);
  const discord = optionalText(body.discord_url, 500);
  const website = optionalText(body.website_url, 500);
  if (!validUrl(discord)) errors.push('Ссылка на Discord: нужен полный адрес (https://…)');
  if (!validUrl(website)) errors.push('Ссылка на сайт: нужен полный адрес (https://…)');

  if (errors.length) return { ok: false, value: null, errors };

  return {
    ok: true,
    errors: [],
    value: {
      name,
      tag,
      description,
      color,
      icon: optionalText(body.icon, 50) ?? 'squadron',
      allegiance: optionalText(body.allegiance, 50) ?? 'Independent',
      power: optionalText(body.power, 50),
      language: optionalText(body.language, 50) ?? 'Russian',
      timezone: optionalText(body.timezone, 50) ?? 'Moscow',
      member_limit: SQUADRON_MEMBER_LIMIT,
      discord_url: discord,
      website_url: website,
      recruitment_message: optionalText(body.recruitment_message, 1000),
      activity_type: optionalText(body.activity_type, 50) ?? 'Mixed',
      is_open_recruitment: body.is_open_recruitment === undefined ? true : body.is_open_recruitment !== false,
      home_system: optionalText(body.home_system, 100),
    },
  };
}

export interface DbLikeError {
  code?: string | null;
  message?: string | null;
  details?: string | null;
}

/**
 * Перевести отказ PostgreSQL в текст, по которому понятно, что делать.
 *
 * Раньше маршрут возвращал `error.message` как есть («duplicate key value
 * violates unique constraint …»), а чаще — общее «Could not create
 * squadron»: причина терялась и в интерфейсе, и в поддержке.
 */
export function squadronWriteError(error: DbLikeError | null | undefined): string {
  const code = (error?.code ?? '').toString();
  const message = (error?.message ?? '').toString();

  if (code === '23505' || /duplicate key/i.test(message)) {
    return /tag/i.test(message)
      ? 'Эскадрилья с таким тегом уже есть — выберите другой'
      : 'Эскадрилья с таким названием уже есть — выберите другое';
  }
  if (code === '23503' || /foreign key/i.test(message)) {
    return 'Профиль пилота не найден в базе. Выйдите и войдите снова, затем повторите создание';
  }
  if (code === '23502' || /null value in column/i.test(message)) {
    const column = message.match(/column "([^"]+)"/)?.[1];
    return column
      ? `Поле «${column}» обязательно в базе, но пришло пустым`
      : 'Одно из обязательных полей пришло пустым';
  }
  if (code === '42703' || code === 'PGRST204' || /column .* does not exist/i.test(message)) {
    const column = message.match(/'([^']+)' column/)?.[1] ?? message.match(/column "([^"]+)"/)?.[1];
    return `В базе нет колонки${column ? ` «${column}»` : ''} — примените миграции supabase/migrations`;
  }
  if (code === '42P01' || /relation .* does not exist/i.test(message)) {
    return 'Таблицы эскадрилий нет в базе — примените миграции supabase/migrations';
  }
  if (code === '42501' || /row-level security/i.test(message)) {
    return 'База отклонила запись по политике доступа (RLS). Проверьте SUPABASE_SERVICE_ROLE_KEY на сервере';
  }
  return message || 'Не удалось создать эскадрилью';
}
