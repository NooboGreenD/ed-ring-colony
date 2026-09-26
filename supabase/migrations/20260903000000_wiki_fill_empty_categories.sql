-- ============================================================
-- ED Ring Colony Wiki — Seed: гайды (категория «Гайды»)
--
-- ⚠ Файл восстановлен 2026-09-25. Прежняя версия лежала одной строкой: в ней
--   были потеряны все переводы строк, поэтому первый же комментарий «-- …»
--   съедал весь остаток файла вместе с блоком DO. Миграция не создавала
--   ничего, а при попытке выполнить DO сервер отвечал
--   «syntax error at end of input» — и обновление падало
--   (deploy/update-project.sh накатывает миграции с ON_ERROR_STOP=1).
--
--   Что сделано при восстановлении:
--     • комментарии снова на своих строках, структура DO/INSERT/END цела;
--     • маркеры $nl$ внутри текстов статей заменены реальными переводами
--       строк — разворачивать их было некому, в базу попадала одна строка
--       с литералами «$nl$»;
--     • статья и её первая ревизия вставляются идемпотентно
--       (ON CONFLICT (slug) DO NOTHING), чтобы повторный накат не ронял
--       обновление на «duplicate key value violates unique constraint»;
--     • категория ищется по id из рабочей базы, затем по slug 'guides' и лишь
--       при отсутствии создаётся: 20260901000000_wiki.sql сеет категории
--       через gen_random_uuid(), и в свежей базе id у них другие;
--     • если пользователя-автора в базе нет (установка с нуля до регистрации
--       администратора), сид пропускается с NOTICE: это контент, а не схема,
--       ронять из-за него деплой нельзя.
--
--   Остальные статьи серии: 20260903010000 (колонизация), 20260903020000 (лор).
-- ============================================================

DO $seed$
DECLARE
  v_admin_id   UUID := 'd0680fc1-5fa0-4a54-b9bd-6918f88de63a';
  v_author_id  UUID;
  v_cat_guides UUID;
  v_article_id UUID;
BEGIN
  -- ============================================================
  -- 0. Категория «Гайды» и автор статей
  -- ============================================================
  SELECT id INTO v_cat_guides FROM public.wiki_categories
   WHERE id = '448d06b4-5a1d-4c90-b37e-019f22ec9064';
  IF v_cat_guides IS NULL THEN
    SELECT id INTO v_cat_guides FROM public.wiki_categories WHERE slug = 'guides';
  END IF;
  IF v_cat_guides IS NULL THEN
    INSERT INTO public.wiki_categories (name, slug, description, sort_order)
    VALUES ('Гайды', 'guides', 'Руководства и советы', 4)
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO v_cat_guides;
  END IF;

  SELECT COALESCE(
           (SELECT id FROM auth.users WHERE id = v_admin_id),
           (SELECT id FROM public.profiles
             WHERE role IN ('admin', 'moderator')
             ORDER BY created_at LIMIT 1)
         ) INTO v_author_id;
  IF v_author_id IS NULL THEN
    RAISE NOTICE 'wiki_fill_empty_categories: нет пользователя-автора (admin/moderator) — сид пропущен';
    RETURN;
  END IF;

  -- ============================================================
  -- КАТЕГОРИЯ: ГАЙДЫ (3 статьи)
  -- ============================================================
  -- ── Первые шаги новичка ──────────────────────────────────────────────
  INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
  VALUES (
    'Первые шаги новичка',
    'pervye-shagi-novichka',
    $c$# Первые шаги новичка

**Тип:** Гайд
**Сложность:** Начальный
**Время чтения:** 15 минут

## Описание

Только что купили Elite Dangerous и не знаете, с чего начать? Этот гайд проведёт вас от первого запуска до осознанного выбора профессии. Не торопитесь — игра вознаградит любопытство.

## Этап 1: Прохождение обучения

Не пропускайте обучение. Оно научит:
- Базовому управлению (взлёт, посадка, FSD)
- Суперкруизу и выходу из него
- Стыковке вручную и через Docking Computer
- Базовому бою и сканированию

## Этап 2: Первые кредиты (Sidewinder)

| Способ | Доход | Сложность |
|--------|-------|-----------|
| Миссии «Доставка данных» | 10–50 тыс. | Низкая |
| Поиск обломков (RES) | 20–100 тыс. | Средняя |
| Базовая торговля | 5–20 тыс. | Низкая |

Рекомендация: выполните 3–5 миссий на доставку данных, чтобы накопить на Cobra Mk III (~350 тыс.)

## Этап 3: Первый апгрейд корабля

**Цель:** Cobra Mk III
- Универсальность: торговля, бой, исследования
- 4 внутренних слота
- Достаточно щитов и скорости

Обязательные модули для покупки:
1. **D-rated FSD** — максимальная дальность прыжка
2. **Fuel Scoop** — бесплатное топливо от звёзд
3. **Detailed Surface Scanner** — заработок на исследованиях

## Этап 4: Выбор пути

После Cobra Mk III выберите специализацию:

| Профессия | Следующий корабль | Что делать |
|-----------|-------------------|------------|
| Торговля | Type-6 Transporter | Loop routes, rare goods |
| Бой | Vulture | RES, Combat Zones |
| Исследования | Diamondback Explorer | Дальние миры, продажа данных |
| Многоцелевой | Python | Всё понемногу |

## Советы

- **Не летайте без страховки (Rebuy)** — всегда держите 5–10% стоимости корабля
- **Используйте Inara.cz и EDDB** — внеигровые инструменты экономят часы
- **Присоединяйтесь к Squadron** — сообщество поможет и ответит на вопросы
- **Откройте Felicity Farseer** — первый инженер, G5 FSD — must have
- **Не бойтесь Open** — PvP-гриферы редки, а помощь других игроков бесценна

## Оценка

Первые 10 часов в Elite Dangerous — самые важные. Не гонитесь за кредитами, изучайте механики. Хорошо настроенный Cobra Mk III принесёт больше удовольствия, чем stock Anaconda.$c$,
    v_cat_guides, v_author_id, v_author_id, 'published', true, 0, 1, NOW(), NOW()
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO v_article_id;

  IF v_article_id IS NOT NULL THEN
    INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
    VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed', NOW());
  END IF;

  -- ── Быстрый заработок кредитов ──────────────────────────────────────────────
  INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
  VALUES (
    'Быстрый заработок кредитов',
    'bystryj-zarabotok-kreditov',
    $c$# Быстрый заработок кредитов

**Тип:** Гайд
**Сложность:** Любая
**Актуальность:** 2026

## Описание

Elite Dangerous предлагает множество способов заработка. Этот гайд описывает самые эффективные методы на разных этапах карьеры — от стартового Sidewinder до флота Fleet Carrier.

## Начальный этап (0–5 млн CR)

| Метод | Доход/час | Требования |
|-------|-----------|------------|
| Миссии доставки данных | 0.5–1 млн | Sidewinder, любая станция |
| Road to Riches | 1–3 млн | Cobra Mk III + DSS + Fuel Scoop |
| Низкоуровневый RES | 1–2 млн | Любой боевой корабль, система с RES |

**Road to Riches** — сканируйте дорогие планеты (Earth-like, Water worlds) в пределах 5000 св. лет от Bubble. Маршруты есть на [EDTools](https://edtools.cc/).

## Средний этап (5–500 млн CR)

| Метод | Доход/час | Требования |
|-------|-----------|------------|
| Void Opals / LTD mining | 50–200 млн | Корабль с трюмом 100+ т, seismic charges |
| Passenger missions (Robigo) | 20–50 млн | Python, 3A Business cabins |
| Stackable massacre missions | 30–100 млн | Корабль G3+, allied фракция |

**Robigo Mines** — станция в системе Robigo. Берите пассажиров в Sirius Atmospherics, летите в Sothis. 10-минутный рейс, 10–20 млн прибыли.

## Продвинутый этап (500 млн+)

| Метод | Доход/час | Требования |
|-------|-----------|------------|
| Platinum laser mining | 100–300 млн | Type-9 / Cutter, mapped hotspot |
| Thargoid interceptor hunting | 100–500 млн | AX-krait, опыт |
| Colonization logistics | 50–200 млн | Fleet Carrier, Type-11 |

## Советы

- Не гонитесь только за кредитами — инженеры важнее
- Fleet Carrier стоит 5 млрд + 500 млн/неделю upkeep — считайте заранее
- Используйте [Mineraltools](https://mineraltools.com) для поиска актуальных hotspot'ов
- Community Goals часто дают десятки миллионов за простые действия

## Оценка

Лучший заработок — тот, который вам не надоеден. Mining приносит больше всего, но быстро утомляет. Passenger Robigo — золотая середина: стабильный, предсказуемый, не требует постоянного внимания.$c$,
    v_cat_guides, v_author_id, v_author_id, 'published', false, 0, 1, NOW(), NOW()
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO v_article_id;

  IF v_article_id IS NOT NULL THEN
    INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
    VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed', NOW());
  END IF;

  -- ── Гайд по открытию инженеров ──────────────────────────────────────────────
  INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
  VALUES (
    'Гайд по открытию инженеров',
    'gayd-po-otkrytiyu-inzhenerov',
    $c$# Гайд по открытию инженеров

**Тип:** Гайд
**Сложность:** Средняя
**Время:** 10–30 часов

## Описание

Инженеры — ключевая прогрессия в Elite Dangerous. G5-модификации превращают стоковый корабль в машину, способную на всё. Этот гайд описывает оптимальный порядок открытия и требования для каждого инженера.

## Порядок открытия (рекомендуемый)

| # | Инженер | Зачем открывать | Сложность |
|---|---------|-----------------|-----------|
| 1 | Felicity Farseer | G5 FSD, G3 Thrusters | Очень низкая |
| 2 | Tod McQuinn | G5 Multi-cannons, G3 Railguns | Низкая |
| 3 | The Dweller | G5 Power Distributor | Низкая |
| 4 | Elvira Martuuk | G5 FSD (альтернатива) | Низкая |
| 5 | Liz Ryder | G5 Missiles, G3 Torpedoes | Низкая |
| 6 | Selene Jean | G5 Hull | Средняя |
| 7 | Didi Vatermann | G5 Shield Boosters | Средняя |
| 8 | Lei Cheung | G5 Shields | Средняя |
| 9 | Marco Qwent | G4 Power Plant, открывает Palin | Средняя |
| 10 | Professor Palin | G5 Thrusters, G3 AFMU | Высокая |

## Как начать

1. **Felicity Farseer** — требует звание Scout в исследованиях. Сделайте Road to Riches, продайте данные в Farseer Inc (Deciat)
2. **Meta-Alloys** — купите у Darnielle's Progress (Maia) или соберите с Thargoid Barnacle
3. **Marco Qwent** — требует приглашение от Elvira Martuuk и 25 единиц Modular Terminals (миссии Sirius Corp)
4. **Professor Palin** — требует 5000 св. лет от стартовой системы + приглашение от Marco Qwent

## Быстрые материалы для старта

| Инженер | Что принести | Где взять |
|---------|--------------|-----------|
| Felicity | 1 Meta-Alloy | Maia — Darnielle's Progress |
| Tod McQuinn | 15 Fragment Cannons убийств | Any RES |
| The Dweller | 5 единиц Black Market | Продайте контрабанду |
| Liz Ryder | 200 единиц Landmines | Eurybia — Kammerman's Port |

## Советы

- Не пытайтесь открыть всех сразу — это выгорание
- Сначала поднимите репутацию (G1→G3 модули), потом фармите G5 материалы
- Используйте [Inara](https://inara.cz) для отслеживания требований
- pinned blueprint — закреплённый чертёж, позволяет крафтить удалённо
- Experimental effects доступны только на базе инженера

## Оценка

Инженеры — must have для любой серьёзной деятельности. Даже G3 FSD от Felicity удвоит вашу дальность. Потратьте 2–3 вечера на открытие первой пятёрки — это окупится сторицей.$c$,
    v_cat_guides, v_author_id, v_author_id, 'published', false, 0, 1, NOW(), NOW()
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO v_article_id;

  IF v_article_id IS NOT NULL THEN
    INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
    VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed', NOW());
  END IF;

END
$seed$;
