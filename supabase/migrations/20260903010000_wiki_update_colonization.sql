-- ============================================================
-- ED Ring Colony Wiki — Update: гайд по колонизации (версия 2.0) + 2 статьи
--
-- ⚠ Файл восстановлен 2026-09-25. Прежняя версия лежала одной строкой без
--   переводов строк: первый комментарий съедал весь остаток файла вместе с
--   блоком DO, поэтому миграция не выполняла ни одной команды (psql считает
--   пустой скрипт успешным, и поломка была незаметна).
--
--   Что сохранено и что исправлено:
--     • текст статей не менялся, маркеры $nl$ развёрнуты в реальные переводы
--       строк (разворачивать их было некому — в базе оставалась одна строка);
--     • гайд по колонизации обновляется до версии 2.0, а на базе, где его нет
--       (чистая установка, гайд заводили вручную из шаблона), — создаётся сразу
--       в версии 2.0: раньше UPDATE молча не находил ни одной строки;
--     • повторный накат безопасен: статьи не дублируются (ON CONFLICT (slug)),
--       ревизия №2 добавляется только если её ещё нет;
--     • категория «Колонизация» и автор ищутся по базе — как в
--       20260903000000_wiki_fill_empty_categories.sql.
-- ============================================================

DO $seed$
DECLARE
  v_admin_id         UUID := 'd0680fc1-5fa0-4a54-b9bd-6918f88de63a';
  v_author_id        UUID;
  v_cat_colonization UUID;
  v_article_id       UUID;
  v_guide_content    TEXT;
BEGIN
  -- ============================================================
  -- 0. Категория «Колонизация» и автор статей
  -- ============================================================
  SELECT id INTO v_cat_colonization FROM public.wiki_categories
   WHERE id = '117fddde-9c52-4741-b00d-edb2788e4e42';
  IF v_cat_colonization IS NULL THEN
    SELECT id INTO v_cat_colonization FROM public.wiki_categories WHERE slug = 'colonization';
  END IF;
  IF v_cat_colonization IS NULL THEN
    INSERT INTO public.wiki_categories (name, slug, description, sort_order)
    VALUES ('Колонизация', 'colonization', 'Всё о колонизации систем', 7)
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO v_cat_colonization;
  END IF;

  SELECT COALESCE(
           (SELECT id FROM auth.users WHERE id = v_admin_id),
           (SELECT id FROM public.profiles
             WHERE role IN ('admin', 'moderator')
             ORDER BY created_at LIMIT 1)
         ) INTO v_author_id;
  IF v_author_id IS NULL THEN
    RAISE NOTICE 'wiki_update_colonization: нет пользователя-автора (admin/moderator) — сид пропущен';
    RETURN;
  END IF;

  v_guide_content := $c$# Полный гайд по колонизации в Elite Dangerous

> **Актуально для:** Update 2 / Trailblazers (февраль 2026)  
> **Автор:** Сообщество ED Ring Colony  
> **Категория:** Колонизация  
> **Версия:** 2.0  
> **Статус:** Актуально для текущего патча

---

## Содержание

1. [Введение: что такое колонизация](#введение-что-такое-колонизация)
2. [Этап 0: Подготовка](#этап-0-подготовка)
3. [Этап 1: Выбор системы](#этап-1-выбор-системы)
4. [Этап 2: Покупка клейма](#этап-2-покупка-клейма)
5. [Этап 3: Размещение маяка](#этап-3-размещение-маяка)
6. [Этап 4: Доставка материалов](#этап-4-доставка-материалов)
7. [Этап 5: Становление System Architect](#этап-5-становление-system-architect)
8. [Защита клейма от перехвата](#защита-клейма-от-перехвата)
9. [Технологическое дерево (Tech Tree)](#технологическое-дерево-tech-tree)
10. [Орбитальные объекты: полный справочник](#орбитальные-объекты-полный-справочник)
11. [Поверхностные объекты: полный справочник](#поверхностные-объекты-полный-справочник)
12. [Экономика системы](#экономика-системы)
13. [BGS, фракции и Powerplay](#bgs-фракции-и-powerplay)
14. [Логистика и Fleet Carrier](#логистика-и-fleet-carrier)
15. [Construction Points (CP)](#construction-points-cp)
16. [Доход и награды](#доход-и-награды)
17. [Название объектов](#название-объектов)
18. [Демонтаж и отмена строительства](#демонтаж-и-отмена-строительства)
19. [Расширение: цепочки систем и мини-Bubble](#расширение-цепочки-систем-и-мини-bubble)
20. [Частые ошибки и как их избежать](#частые-ошибки-и-как-их-избежать)
21. [Полезные инструменты и ресурсы](#полезные-инструменты-и-ресурсы)

---

## Введение: что такое колонизация

**System Colonisation** — это механика, позволяющая игрокам заявлять незаселённые звёздные системы и развивать их, строя порты, аванпосты, поселения и другие объекты. Вы становитесь **System Architect** (Системным Архитектором) — бессрочным управляющим развитием своей колонии.

### Ключевые факты (февраль 2026)

- **101,862+ систем** колонизировано по всей галактике
- **307,014 космических** и **175,973 наземных** объектов построено
- Механика вышла из бета-теста **11 ноября 2025 года** (Dodec Update)
- **Trailblazer megaships** были удалены из игры — колонии теперь самодостаточны
- Колонизация — **PvE-контент**: другие игроки **не могут** разрушить вашу колонию
- **Нет ежемесячных расходов** на содержание — развивайте в своём темпе
- Каждая система уникальна: тип звезды, планеты, ресурсы влияют на экономику

### Общая схема процесса

```
Выбор системы → Покупка клейма → Размещение маяка → Доставка материалов → 
→ Постройка первого порта → System Architect → Расширение системы
```

---

## Этап 0: Подготовка

### Минимальные требования

| Параметр | Требование |
|----------|------------|
| Кредиты | Минимум **50–100 млн** (25 млн маяк + 25 млн резерв + стоимость корабля) |
| Корабль | С трюмом **200+ тонн** (Type-9, Cutter, Type-11, Panther Clipper Mk II) |
| FSD | Инженерный апгрейд от Felicity Farseer желателен |
| Fleet Carrier | **Не обязателен**, но делает процесс в 10 раз проще |
| Squadron | Желателен для координации и BGS-контроля |

### Рекомендуемый набор кораблей

1. **Panther Clipper Mk II** — новый король грузоперевозок (до 1238 т, Large)
2. **Type-11 Prospector** — массовые перевозки, SCO-optimized
3. **Corsair** — быстрый средний корабль с хорошим трюмом (318 т, SCO)
4. **Python** — универсал: доставки, SRV, майнинг
5. **Krait Mk II** — боевые миссии и защита
6. **Diamondback Explorer** — разведка и поиск систем

---

## Этап 1: Выбор системы

### Критерии выбора (от важного к менее важному)

### Обязательные условия

1. **Расстояние** — в пределах **15 световых лет** от заселённой системы
2. **Статус** — система должна быть **Unclaimed** (незаявленной)
3. **Доступность** — не permit-locked, не в exclusion zone

### Желательные условия

| Фактор | Почему важно | Идеально |
|--------|-------------|----------|
| **Тип звезды** | K/G-тип стабильны, дают хорошие слоты | K- или G-звезда |
| **Количество планет** | Больше тел = больше орбитальных слотов | 5+ планет/лун |
| **Кольца** | Создают Resource Extraction Sites | Кольца на Rocky body |
| **Ресурсы** | Влияют на базовую экономику | Pristine reserves |
| **Geological signals** | Бонус к Refinery-экономике | Есть на Rocky/HMC |
| **Terraformable** | Бонус к населению и экономике | 1+ планета |

### Типы планет и базовая экономика

| Тип планеты | Базовая экономика | Бонус |
|-------------|-------------------|-------|
| Rocky body | Refinery +1.0 | Pristine = +, Depleted = − |
| High Metal Content (HMC) | Extraction +1.0 | Геология = + |
| Water World | Tourism потенциал | Terraformable = ++ |
| Gas Giant | Много лун = слоты | Кольца = RES |

### Чего избегать

- **Neutron stars / Black holes** — нет планет, нет слотов
- **White dwarfs** — мало слотов, опасны для FSD
- **Системы с 1-2 планетами** — мало возможностей для развития
- **Системы в 14.9 св.лет** — сложно достичь, мало запаса для цепочки

---

## Этап 2: Покупка клейма

### Процесс

1. Прилетите в **любой Star Port** в заселённой системе
2. Откройте **Station Services → Colonization Contact**
3. Выберите незаселённую систему в пределах 15 св.лет
4. Выберите тип **Primary Starport**

### Типы портов

| Тип порта | Стоимость клейма | Особенности |
|-----------|-----------------|-------------|
| **Outpost** | Дешевле | Только Medium площадки, меньше грузов |
| **Coriolis** | Средне | Классика, Large площадки, Colony-экономика |
| **Ocellus** | Дороже | Tier 3, высокие статы |
| **Orbis** | Дороже | Tier 3, аналог Ocellus |
| **Dodec** | Самый дорогой | Tier 3, максимальные статы, уникальный дизайн |

### Важно

- Клейм действует **24 часа** — за это время нужно разместить маяк
- Если пропустили дедлайн — **3 дня блокировки** перед новой попыткой
- Нельзя иметь несколько активных клеймов одновременно
- После завершения первого порта можно заявлять следующую систему

---

## Этап 3: Размещение маяка

### Что нужно сделать

1. Полетите в заявленную систему
2. Откройте **System Colonization Suite** (модуль по умолчанию на всех кораблях)
3. Разверните **Colonization Beacon** в предустановленной точке
4. Маяк стоит **25 млн кредитов**

### Что происходит дальше

- Система помечается как **Claimed** (заявленная)
- Запускается обратный отсчёт **24 часа**
- Прибывает гигантский **Colonization Ship** — временная база с 32 площадками
- Вы становитесь **System Architect** (после завершения первого порта)

### Если не успели за 24 часа

- Клейм **аннулируется**
- **3 дня** нельзя подавать новые заявки
- Потраченные кредиты **не возвращаются**

---

## Этап 4: Доставка материалов

### Цель

Доставить все необходимые **commodities** на Colonization Ship за **4 недели**.

### Типы материалов

| Категория | Примеры | Источник |
|-----------|---------|----------|
| **Руды (Minerals)** | Bauxite, Gallite, Indite, Coltan | Mining / Покупка |
| **Товары (Commodities)** | Food Cartridges, Insulating Membrane, CMM Composite | Рынки Bubble |
| **Материалы (Materials)** | Iron, Nickel, Carbon, Sulphur | SRV surface mining |
| **Топливо** | Tritium для FC | Рынки / Mining |

### Ключевые советы по доставке

- **Fleet Carrier = must have** для серьёзных проектов: 25,000 т груза + прыжки 500 св.лет
- **Panther Clipper Mk II** — новый лучший корабль для массовых перевозок (1238 т)
- **Type-11 Prospector** — SCO-optimized, хорошая альтернатива
- **Создавайте цепочки** систем каждые 15 св.лет для дальних колоний
- Некоторые товары (**Insulating Membrane**) доступны **только** на орбитальных рынках
- **CMM Composite** производится на планетах с Refinery-экономикой

### Что происходит после доставки

- Порт появляется в виде **строящейся станции** с лесами
- После **еженедельного тика** (четверг, 07:00 UTC) порт достраивается
- Маяк превращается в **Nav Beacon**
- Система становится заселённой

---

## Этап 5: Становление System Architect

### Ваши полномочия

- **Размещение** новых объектов (орбитальных и поверхностных)
- **Управление** экономикой, населением, безопасностью
- **Назначение** названий объектов (платно через Arx)
- **Демонтаж** ошибочно размещённых объектов

### Ограничения

- Нужно дождаться **первого еженедельного тика** после постройки порта
- Количество **одновременных строек** ограничено (смотрите в Architect View)
- Поверхностные объекты могут появляться с **задержкой до 48 часов**
- **Ground Ports (Planetary Port)** не работают с экономическими влияниями — используйте Orbital Ports

### Architect Mode

- Открывается через **System Map**
- Показывает доступные **орбитальные слоты** (иконки с «+»)
- Показывает **поверхностные слоты** на каждой планете
- Флаг на орбитальном слоте = место для **Primary Port**

---

## Защита клейма от перехвата

### Механика «Claim Sniping Protection»

После завершения первого порта в новой системе действует **эксклюзивная блокировка** на подачу клеймов ИЗ этой системы:

| Фаза | Длительность | Кто может заявлять |
|------|-------------|-------------------|
| **Phase 1** | 30 минут | Только System Architect |
| **Phase 2** | 23.5 часа | Члены Squadron Architect'а |
| **Phase 3** | После 24 часов | Любой игрок |

### Важно

- Если Architect **не в Squadron** — действует только 30-минутная блокировка
- Блокировка отображается в панели клейма с таймером
- Это позволяет строить **цепочки систем** без опасения, что кто-то «перехватит» ваш маршрут
- Даже одиночный игрок в своём собственном Squadron получает полные 24 часа защиты

---

## Технологическое дерево (Tech Tree)

### Принцип работы

- Каждый объект даёт **Construction Points (CP)**
- **Tier 1** объекты открываются сразу (нужен только First Station)
- **Tier 2** требуют определённых Tier 1 объектов
- **Tier 3** требуют Tier 2 + достаточного количества CP

### Пример цепочки

```
First Station → Scientific Outpost → Research Station → Ocellus Starport
                    ↓
             Mining Outpost → Asteroid Base
```

### Поверхностная ветка

```
First Station → Planetary Outposts → Settlements → Hubs → Planetary Port
```

---

## Орбитальные объекты: полный справочник

### Starports (Tier 2-3)

| Объект | Tier | Экономика | Security | Tech | Wealth | SoL | Dev | Pop+ | MaxPop+ |
|--------|------|-----------|----------|------|--------|-----|-----|------|---------|
| **Coriolis** | 2 | Colony | -2 | 1 | 2 | 3 | 2 | 1 | 0 |
| **Asteroid Base** | 2 | Extraction | -1 | 3 | 5 | -4 | 7 | 1 | 0 |
| **Ocellus** | 3 | Colony | -3 | 6 | 7 | 5 | 8 | 5 | 1 |
| **Orbis** | 3 | Colony | -3 | 6 | 7 | 5 | 8 | 5 | 1 |
| **Dodec** | 3 | Colony | -4 | 8 | 9 | 7 | 10 | 8 | 4 |

### Outposts (Tier 1)

| Объект | Tier | Экономика | Security | Tech | Wealth | SoL | Dev | Pop+ | CP Reward |
|--------|------|-----------|----------|------|--------|-----|-----|------|-----------|
| **Commercial Outpost** | 1 | Colony | -1 | — | 2 | 5 | — | 0 | Tier 2: 1 |
| **Industrial Outpost** | 1 | Industrial | — | 3 | — | — | 2 | 0 | Tier 2: 1 |
| **Criminal Outpost** | 1 | Colony | -2 | — | 2 | — | — | 0 | Tier 2: 1 |
| **Civilian Outpost** | 1 | Colony | -1 | — | 1 | 1 | 1 | 0 | Tier 2: 1 |
| **Scientific Outpost** | 1 | Hightech | — | 3 | — | — | — | 1 | Tier 2: 1 |
| **Military Outpost** | 1 | Military | 2 | — | — | — | — | 1 | Tier 2: 1 |

### Installations (Tier 1-2)

| Объект | Tier | Экономика | Security | Tech | Wealth | SoL | Dev | CP Cost | CP Reward |
|--------|------|-----------|----------|------|--------|-----|-----|---------|-----------|
| **Satellite** | 1 | — | — | — | 1 | 1 | 1 | — | Tier 2: 1 |
| **Communication Station** | 1 | — | — | 1 | 3 | — | — | — | Tier 2: 1 |
| **Space Farm** | 1 | Agricultural | — | — | — | 5 | 1 | — | Tier 2: 1 |
| **Pirate Base** | 1 | Contraband | -4 | — | 3 | — | — | — | Tier 2: 1 |
| **Mining Outpost** | 1 | Extraction | — | — | 3 | -2 | — | — | Tier 2: 1 |
| **Relay Station** | 1 | Hightech | 1 | — | — | — | 1 | — | Tier 2: 1 |
| **Military Installation** | 2 | Military | 6 | — | — | — | — | Tier 2: 1 | Tier 3: 1 |

---

## Поверхностные объекты: полный справочник

### Planetary Outposts (Tier 1)

| Объект | Tier | Экономика | Security | Tech | Wealth | SoL | Dev | Pop+ | CP Reward |
|--------|------|-----------|----------|------|--------|-----|-----|------|-----------|
| **Civilian Planetary Outpost** | 1 | Colony | -2 | — | — | 3 | — | 2 | Tier 2: 1 |
| **Industrial Planetary Outpost** | 1 | Industrial | -1 | — | 2 | — | — | 1 | Tier 2: 1 |
| **Scientific Planetary Outpost** | 1 | Hightech | -1 | 5 | — | — | 1 | 1 | Tier 2: 1 |

### Planetary Port (Tier 3)

| Объект | Tier | Экономика | Security | Tech | Wealth | SoL | Dev | Pop+ | MaxPop+ | CP Cost |
|--------|------|-----------|----------|------|--------|-----|-----|------|---------|---------|
| **Planetary Port** | 3 | Colony | -3 | 5 | 5 | 6 | 10 | 10 | 10 | Tier 3: 6 |

**Важно:** Planetary Port не получает экономических бонусов от других объектов. Используйте Orbital Ports для торговли.

### Settlements (Tier 1-2)

| Объект | Tier | Экономика | Security | Tech | Wealth | SoL | Dev | CP Cost | CP Reward |
|--------|------|-----------|----------|------|--------|-----|-----|---------|-----------|
| **Small Agricultural Settlement** | 1 | Agricultural | — | — | — | 3 | — | — | Tier 2: 1 |
| **Medium Agricultural Settlement** | 1 | Agricultural | — | — | — | 6 | — | — | Tier 2: 1 |
| **Large Agricultural Settlement** | 2 | Agricultural | — | — | — | 10 | — | Tier 2: 1 | Tier 3: 2 |
| **Small Extraction Settlement** | 1 | Extraction | — | — | 2 | — | — | — | Tier 2: 1 |
| **Medium Extraction Settlement** | 1 | Extraction | — | — | 5 | — | — | — | Tier 2: 1 |
| **Large Extraction Settlement** | 2 | Extraction | — | 1 | 7 | -2 | — | Tier 2: 1 | Tier 3: 2 |
| **Small Industrial Settlement** | 1 | Industrial | — | — | — | — | 2 | — | Tier 2: 1 |
| **Medium Industrial Settlement** | 1 | Industrial | — | — | — | — | 5 | — | Tier 2: 1 |
| **Large Industrial Settlement** | 2 | Industrial | — | — | 2 | — | 8 | Tier 2: 1 | Tier 3: 2 |
| **Small Military Settlement** | 1 | Military | 2 | — | — | — | — | — | Tier 2: 1 |
| **Medium Military Settlement** | 1 | Military | 4 | — | — | — | — | — | Tier 2: 1 |
| **Large Military Settlement** | 2 | Military | 6 | — | — | — | 2 | Tier 2: 1 | Tier 3: 2 |
| **Small Scientific Settlement** | 2 | Hightech | — | 3 | — | — | 1 | Tier 2: 1 | Tier 3: 1 |
| **Medium Scientific Settlement** | 2 | Hightech | — | 6 | — | — | 1 | Tier 2: 1 | Tier 3: 1 |
| **Large Scientific Settlement** | 2 | Hightech | — | 10 | — | — | 2 | Tier 2: 1 | Tier 3: 2 |
| **Small Tourism Settlement** | 2 | Tourism | -1 | — | 1 | — | — | Tier 2: 1 | Tier 3: 1 |
| **Medium Tourism Settlement** | 2 | Tourism | -1 | — | 2 | — | — | Tier 2: 1 | Tier 3: 1 |
| **Large Tourism Settlement** | 2 | Tourism | -1 | — | 5 | — | — | Tier 2: 1 | Tier 3: 2 |

### Hubs (Tier 2)

| Объект | Требует | Экономика | Security | Tech | Wealth | SoL | Dev | CP Cost | CP Reward |
|--------|---------|-----------|----------|------|--------|-----|-----|---------|-----------|
| **Extraction Hub** | Small/Medium/Large Mining Settlement | Extraction | — | — | 10 | -4 | 2 | Tier 2: 1 | Tier 3: 1 |
| **Civilian Hub** | Small/Medium/Large Agricultural Settlement | — | -3 | — | — | 3 | 2 | Tier 2: 1 | Tier 3: 1 |
| **Exploration Hub** | Communication Station | Tourism | -1 | 6 | — | — | 2 | Tier 2: 1 | Tier 3: 1 |
| **Outpost Hub** | Space Farm | — | -2 | — | — | 3 | 2 | Tier 2: 1 | Tier 3: 1 |
| **Scientific Hub** | First Station | Hightech | — | 10 | — | — | — | Tier 2: 1 | Tier 3: 1 |
| **Military Hub** | Military Installation | Military | 10 | — | — | — | — | Tier 2: 1 | Tier 3: 1 |
| **Refinery Hub** | First Station | Refinery | -1 | 3 | 5 | -2 | 7 | Tier 2: 1 | Tier 3: 1 |
| **High Tech Hub** | First Station | Hightech | -2 | 10 | -2 | — | — | Tier 2: 1 | Tier 3: 1 |
| **Industrial Hub** | Mining Outpost | Industrial | — | 3 | 5 | -4 | 2 | Tier 2: 1 | Tier 3: 1 |

---

## Экономика системы

### Как работает экономика

Каждый объект влияет на **6 параметров** системы:

| Параметр | Описание | Что влияет |
|----------|----------|------------|
| **Security** | Уровень безопасности | Высокий = меньше пиратов, налоги |
| **Tech Level** | Технологический уровень | Доступность модулей и кораблей |
| **Wealth** | Богатство | Цены на товары, миссии |
| **Standard of Living** | Уровень жизни | Пассажирские миссии, tourism |
| **Development Level** | Уровень развития | Рост населения, BGS |
| **Population** | Население | Количество миссий, размер рынка |

### Базовая экономика планет

| Тип тела | Базовая экономика | Бонус |
|----------|-------------------|-------|
| Rocky body | Refinery +1.0 | Pristine/Major reserves = + |
| High Metal Content | Extraction +1.0 | Геология = + |
| Water World | Tourism потенциал | Terraformable = ++ |
| Icy body | — | — |
| Gas Giant | — | Кольца = RES |

### CMM Composite

Для производства **CMM Composite** нужна **Refinery-экономика** в топ-2:

1. **Rocky body** + Planetary Port (Civilian) + Refinery Hub
2. **High Metal Content** + Planetary Port (Civilian) + Refinery Hub

Если на планете есть geological/biological signals — может потребоваться больше Refinery Hub'ов.

### Расположение объектов

- Объекты **ближе к планете** сильнее влияют на экономику
- Объекты **дальше от Starport** имеют **слабое рыночное соединение**
- Экономика объекта влияет на рынки портов на **том же теле**

---

## BGS, фракции и Powerplay

### Фракции

- **Фракция, у которой куплен клейм**, становится доминирующей в системе
- Существующие BGS-фракции могут расширяться в вашу систему
- Player Minor Factions можно привезти через прокси
- Супердержавы расширяют влияние через фракции-прокси

### Government Type

| Тип | Эффект |
|-----|--------|
| **Anarchy** | Сниженная безопасность, легальны все товары |
| **Corporate** | Баланс между порядком и свободой |
| **Democracy** | Высокий SoL, средняя безопасность |
| **Dictatorship** | Высокая безопасность, низкий SoL |
| **Theocracy** | Специфические ограничения на товары |

### Powerplay

- После постройки первого порта система **НЕ контролируется Power**
- Фракция переносится из исходной системы
- Для Powerplay-контроля нужно отдельное влияние

---

## Логистика и Fleet Carrier

### Fleet Carrier — must have?

| Без FC | С FC |
|--------|------|
| Множество рейсов в Bubble | Один рейс = 25,000 т |
| Зависимость от рынков | Собственный рынок |
| Ограниченная дальность | Прыжки 500 св.лет |
| Высокие временные затраты | Автономность месяцами |

### Топливо для FC

- **Tritium** — покупается на рынках или добывается
- Расход: ~1 тонна на прыжок
- Всегда держите запас на 2 прыжка + 500 тонн

### Lynx Highliner

- Новый пассажирский лайнер (Zorgon Peterson)
- Отличен для пассажирских миссий в/из вашей колонии
- Business-class каюты = высокий доход

---

## Construction Points (CP)

### Как получить

| Источник | CP | Условие |
|----------|-----|---------|
| Tier 1 объект | — | Даёт CP для Tier 2 |
| Tier 2 объект | Тратит CP | Даёт CP для Tier 3 |
| Tier 3 объект | Тратит CP | Максимальный уровень |

### Пример прогрессии

```
First Station (бесплатно)
    ↓
Scientific Outpost → даёт 1 CP (Tier 2)
    ↓
Research Station → тратит 3 CP (Tier 2 cost)
    ↓
Ocellus Starport → тратит 6 CP (Tier 3 cost)
```

### Ускорение CP

- **Boom state** — +25% к генерации
- **Player activity** — миссии в системе ускоряют рост
- **Powerplay** — некоторые Power дают бонусы

---

## Доход и награды

### Пассивный доход

- **Торговля** — ваши порты генерируют товары
- **Миссии** — чем выше население, тем больше миссий
- **Tourist** — Tourism-экономика = высокооплачиваемые пассажирские миссии
- **Mining** — Extraction/Refinery = ресурсы для продажи

### Активный доход

- **Доставка товаров** в вашу систему = высокие цены
- **Stackable massacre missions** — если Military-экономика
- **Passenger missions** — если Tourism/High SoL

### Нет upkeep costs!

В отличие от Fleet Carrier, колонии **не требуют** еженедельных платежей. Развивайте в своём темпе.

---

## Название объектов

### Процесс

1. Откройте **System Map → Architect View**
2. Выберите объект
3. Нажмите **Rename**
4. Стоимость: **Arx** (внутриигровая премиум-валюта)

### Правила

- Модерация Frontier — оскорбления и товарные знаки запрещены
- Единый стиль важен для иммерсии
- Названия остаются **навсегда**

---

## Демонтаж и отмена строительства

### Как снести объект

1. Откройте **Galaxy Map**
2. Найдите систему с объектом
3. Откройте **System Map → Architect View**
4. Выберите объект
5. Нажмите **Demolish** внизу списка commodities
6. Подтвердите

### Что происходит

- Демонтаж завершается после **серверного тика**
- Таймер отображается в UI
- **Возвращается только часть ресурсов**
- Если объект строился — строительство отменяется

### Важно

- Демонтаж **Primary Port** невозможен
- Некоторые объекты нельзя снести, если они требуются для других
- Планируйте заранее — демонтаж дорогой

---

## Расширение: цепочки систем и мини-Bubble

### Цепочки (Highways)

- Каждая новая система должна быть в **15 св.лет** от существующей
- Создавайте «ступеньки» каждые 10–15 св.лет
- Используйте **Neutron Highway** для ускорения

### Мини-Bubble

- Группа систем в радиусе 30–50 св.лет
- Общая логистика через Fleet Carrier
- Специализация: одна система — добыча, другая — производство, третья — торговля

### Omega Nebula

- Популярное направление для колонизации
- **40+ ringed water worlds** по маршруту
- **31 чёрная дыра** и **57 нейтронных звёзд** в радиусе 50 св.лет
- Достигнута сообществом **6 января 2026**

---

## Частые ошибки и как их избежать

| Ошибка | Последствие | Решение |
|--------|-------------|---------|
| **Пропустили 24 часа на маяк** | Потеря 25 млн + 3 дня блокировки | Ставьте таймер, не откладывайте |
| **Построили Ground Port для торговли** | Нет экономических бонусов | Используйте Orbital Ports |
| **Неправильное расположение** | Слабое влияние на экономику | Объекты ближе к планете = сильнее |
| **Забыли про CP** | Нельзя строить Tier 3 | Планируйте Tech Tree заранее |
| **Нет резерва Tritium** | FC застрял в пустоте | Всегда 2 прыжка + 500 тонн |
| **Соло в дальней системе** | Сложно доставлять материалы | Squadron или FC-логистика |

---

## Полезные инструменты и ресурсы

### Внеигровые инструменты

| Инструмент | Ссылка | Описание |
|------------|--------|----------|
| **ED Colonisation Planner** | [edcolonisationplanner.com](https://edcolonisationplanner.com) | Автоматический планировщик: загрузите журнал, выберите цель — он рассчитает порядок строительства |
| **DaftMav Spreadsheet** | [Google Sheets](https://docs.google.com) | Таблица со всеми объектами, CP, экономикой |
| **Raven Colonial Corp** | [raven-colonial.org](https://raven-colonial.org) | Планирование колоний, экономика, логистика |
| **Inara** | [inara.cz](https://inara.cz) | Поиск товаров, commodities, инженеры |
| **Spansh** | [spansh.co.uk](https://spansh.co.uk) | Neutron Highway, маршруты |

### Сообщества

- **Frontier Forums** — [forums.frontier.co.uk/forums/system-colonisation](https://forums.frontier.co.uk/forums/system-colonisation/)
- **Reddit** — r/EliteDangerous, r/EliteColonization
- **Discord** — серверы Squadron и проектов

---

## Оценка

Колонизация — это **конечная цель** для многих пилотов Elite Dangerous. Это не даёт прямого преимущества в PvP или PvE, но предоставляет **беспрецедентный уровень креативного контроля** над игровой вселенной. Ваша система останется в галактике **навсегда** — это ваш перманентный след в истории Elite Dangerous.$c$;

  -- ============================================================
  -- 1. ОБНОВЛЕНИЕ: Гайд по колонизации (версия 2.0)
  -- ============================================================
  UPDATE public.wiki_articles
     SET content        = v_guide_content,
         last_editor_id = v_author_id,
         version        = 2,
         updated_at     = NOW()
   WHERE slug = 'polnyy-gayd-po-kolonizacii-v-elite-dangerous';

  IF FOUND THEN
    -- Ревизия №2 — как в исходной миграции; повторный накат её не дублирует.
    INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
    SELECT a.id, a.content, v_author_id, 2, 'Updated for February 2026: added claim sniping protection, Dodec stats, new ships (Panther Clipper, Corsair), ground port warnings, demolition info, updated statistics', NOW()
      FROM public.wiki_articles a
     WHERE a.slug = 'polnyy-gayd-po-kolonizacii-v-elite-dangerous'
       AND NOT EXISTS (
             SELECT 1 FROM public.wiki_revisions r
              WHERE r.article_id = a.id AND r.revision_number = 2
           );
  ELSE
    -- Чистая установка: гайд создаётся сразу в версии 2.0.
    INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
    VALUES (
      'Полный гайд по колонизации в Elite Dangerous',
      'polnyy-gayd-po-kolonizacii-v-elite-dangerous',
      v_guide_content,
      v_cat_colonization, v_author_id, v_author_id, 'published', true, 0, 2, NOW(), NOW()
    )
    RETURNING id INTO v_article_id;

    INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
    VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed', NOW());
  END IF;

  -- ============================================================
  -- 2. НОВАЯ СТАТЬЯ: Выбор системы для колонизации
  -- ============================================================
  INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
  VALUES (
    'Выбор системы для колонизации',
    'vybor-sistemy-dlya-kolonizacii',
    $c$# Выбор системы для колонизации

**Тип:** Колонизация / Гайд
**Сложность:** Начальный–Средний
**Время чтения:** 10 минут

## Описание

Выбор правильной системы — это 50% успеха колонизации. Плохой выбор = ограниченное развитие, сложная логистика, разочарование. Этот гайд научит находить идеальные системы за 15 минут сканирования.

## Чек-лист идеальной системы

### Обязательно (без этого не начинайте)

| Критерий | Почему важно | Минимум |
|----------|-------------|---------|
| **Unclaimed статус** | Иначе нельзя заявить | Да |
| **В пределах 15 св.лет от inhabited** | Требование механики | ≤ 15 св.лет |
| **Не permit-locked** | Иначе доступ закрыт | Да |
| **Есть планеты** | Нужны слоты для объектов | 3+ тела |

### Желательно (влияет на потенциал)

| Критерий | Идеально | Хорошо | Плохо |
|----------|----------|--------|-------|
| **Тип звезды** | K, G | F, M | Neutron, WD, BH |
| **Планеты** | 8+ | 5–7 | 1–2 |
| **Rocky bodies** | 2+ с кольцами | 1 с кольцами | 0 |
| **HMC планеты** | 2+ с геологией | 1 с геологией | 0 |
| **Water Worlds** | 1 terraformable | 1 обычный | 0 |
| **Резервы** | Pristine | Major | Low/Depleted |

### Бонусы (делают систему уникальной)

- **Кольца на Rocky body** → Resource Extraction Sites
- **Terraformable Water World** → Tourism + Population
- **Geological signals** → Refinery бонус
- **Biological signals** → Exploration / Tourism
- **Близость к Neutron star** → Быстрые путешествия

## Пошаговый поиск

### Шаг 1: Найти anchor-систему

1. Откройте **Galaxy Map**
2. Включите фильтр **«Inhabited Systems»**
3. Найдите систему на **границе Bubble** или вашей мини-Bubble
4. Запомните координаты

### Шаг 2: Поиск в радиусе 15 св.лет

1. Переключитесь на **«Unclaimed Systems»**
2. Ищите в радиусе 15 св.лет от anchor
3. Сканируйте каждую кандидатку FSS

### Шаг 3: Быстрая оценка (FSS)

| Что смотреть | За сколько секунд | Что значит |
|--------------|-------------------|------------|
| Тип звезды | 2 сек | K/G = хорошо, иначе skip |
| Количество тел | 5 сек | 5+ = продолжаем, 3-4 = возможно, 1-2 = skip |
| Кольца | 10 сек | Есть = отлично |
| Terraformable | 15 сек | Есть = бонус |

### Шаг 4: Детальное сканирование (если прошла отбор)

1. Прилетите в систему
2. Отсканируйте **Discovery Scanner**
3. Откройте **System Map** и изучите каждое тело
4. Проверьте **Planetary Information**:
   - Composition (для ресурсов)
   - Signals (геология/биология)
   - Terraformable status

### Шаг 5: Проверка слотов

1. Откройте **Galaxy Map → System Colonisation view**
2. Выберите систему
3. Посмотрите **иконки слотов**:
   - **+** = доступный слот
   - **Флаг** = слот для Primary Port
   - Чем больше слотов — тем лучше

## Типы систем по назначению

### Тип A: Промышленная

**Цель:** Производство CMM Composite, Refinery, Industrial

**Идеальные условия:**
- Rocky body с Pristine reserves
- Geological signals
- 2+ HMC планеты
- Много слотов

**Что строить:**
- Refinery Hub
- Industrial Settlement (Large)
- Mining Outpost
- Planetary Port на Rocky body

### Тип B: Туристическая

**Цель:** Высокий доход от пассажиров

**Идеальные условия:**
- Terraformable Water World
- Красивые виды (туманности, кольца)
- Высокий SoL потенциал

**Что строить:**
- Tourism Settlement (Large)
- Exploration Hub
- Luxury Starport (Ocellus/Dodec)
- Communication Station

### Тип C: Военная

**Цель:** Stackable massacre missions, высокая безопасность

**Идеальные условия:**
- Близость к Conflict Zones
- Возможность Military-экономики

**Что строить:**
- Military Settlement (Large)
- Military Hub
- Military Outpost
- Starport с высоким Security

### Тип D: Исследовательская

**Цель:** High Tech, продажа данных, Universal Cartographics

**Идеальные условия:**
- Необычная звезда (Wolf-Rayet, T Tauri)
- Интересные планеты
- Далеко от Bubble (для продажи данных)

**Что строить:**
- Scientific Settlement (Large)
- Scientific Hub
- Research Station
- High Tech Hub

## Красные флаги (пропускайте)

| Проблема | Почему плохо |
|----------|-------------|
| **Только 1-2 планеты** | Мало слотов, нет развития |
| **Нет Rocky/HMC** | Нет добычи, нет Refinery |
| **White Dwarf primary** | Опасно, мало слотов |
| **14.9 св.лет от inhabited** | Сложно достичь, нет запаса |
| **Permit-locked** | Просто нельзя |
| **Уже Claimed** | Кто-то успел раньше |

## Инструменты для поиска

| Инструмент | Как использовать |
|------------|-----------------|
| **EDSM** | Поиск систем по параметрам |
| **Spansh** | Маршруты, neutron highway |
| **Inara** | Проверка статуса системы |
| **ED Colonisation Planner** | Загрузите скан — получите рекомендации |

## Оценка

Идеальная система — это баланс между логистикой (близость к Bubble), потенциалом (планеты, ресурсы) и вашими целями. Не гонитесь за «идеалом» — хорошая система в 5 св.лет лучше идеальной в 14.9. Помните: вы можете иметь **неограниченное количество** колоний, так что первую можно использовать для обучения.$c$,
    v_cat_colonization, v_author_id, v_author_id, 'published', false, 0, 1, NOW(), NOW()
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO v_article_id;

  IF v_article_id IS NOT NULL THEN
    INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
    VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed', NOW());
  END IF;

  -- ============================================================
  -- 3. НОВАЯ СТАТЬЯ: Экономика колонии и BGS
  -- ============================================================
  INSERT INTO public.wiki_articles (title, slug, content, category_id, author_id, last_editor_id, status, is_featured, view_count, version, created_at, updated_at)
  VALUES (
    'Экономика колонии и BGS',
    'ekonomiya-kolonii-i-bgs',
    $c$# Экономика колонии и BGS

**Тип:** Колонизация / Механика
**Сложность:** Средний–Высокий
**Время чтения:** 12 минут

## Описание

Экономика колонии — это не просто цифры. Это живой организм, который определяет, какие товары продаются на ваших рынках, какие миссии доступны пилотам и как быстро растёт ваше население. Понимание BGS (Background Simulation) позволяет создавать системы, которые приносят **пассивный доход** и служат якорем для сообщества.

## Шесть столпов экономики

Каждый объект влияет на 6 параметров:

| Параметр | Что делает | Как повысить |
|----------|-----------|--------------|
| **Security** | Уровень безопасности | Military объекты, Starports |
| **Tech Level** | Технологический уровень | Scientific/High Tech объекты |
| **Wealth** | Богатство | Commercial, Tourism, Refinery |
| **Standard of Living (SoL)** | Пассажирские миссии, tourism | Agricultural, Civilian объекты |
| **Development Level** | Уровень развития | Рост населения, BGS |
| **Population** | Население | Starports, Planetary Port |

## Как работает влияние объектов

### Принцип близости

- Объекты **ближе к планете** = **сильнее влияние**
- Объекты **дальше от Starport** = **слабое рыночное соединение**
- Экономика объекта влияет на рынки портов **на том же теле**

### Пример

```
Планета A (Rocky body, Pristine)
├── Orbital: Coriolis Starport (Slot 0) ← РЫНОК
├── Orbital: Mining Outpost (Slot 1)    ← Влияет на Coriolis
├── Orbital: Refinery Hub (Slot 2)      ← Влияет слабее
└── Surface: Large Extraction Settlement  ← Влияет на Coriolis

Планета B (Water World)
├── Orbital: Ocellus Starport (Slot 0)  ← Свой рынок
└── Orbital: Tourism Settlement           ← Влияет на Ocellus
```

## Создание CMM Composite

CMM Composite — **ключевой товар** для колонизации. Без него сложно строить Tier 2-3 объекты.

### Способ 1: Rocky body + Refinery

1. Найдите **Rocky body** с **Pristine reserves**
2. Постройте **Planetary Port (Civilian)** или **Planetary Outpost (Civilian)**
3. Добавьте **Refinery Hub** на поверхности
4. Убедитесь, что Refinery в **топ-2 экономик** системы

### Способ 2: HMC + Refinery

1. Найдите **High Metal Content** body
2. Постройте **Planetary Port (Civilian)**
3. Добавьте **Refinery Hub**
4. Если есть geological signals — может потребоваться **2+ Refinery Hub**

### Проверка

- Откройте рынок на Starport
- Посмотрите **Commodities → CMM Composite**
- Если есть в продаже — Refinery работает
- Если нет — добавьте ещё Refinery-объектов

## Government Type и рынок

| Government | Эффект на рынок | Особенности |
|------------|----------------|-------------|
| **Anarchy** | Все товары легальны | Низкая безопасность, пиратство |
| **Corporate** | Баланс | Средние цены, стабильность |
| **Democracy** | Высокий SoL | Больше пассажирских миссий |
| **Dictatorship** | Высокая безопасность | Низкий SoL, строгий контроль |
| **Theocracy** | Ограничения на товары | Некоторые товары illegal |

**Важно:** Если government type считает товар **illegal** — он **не появится** на рынке, даже если экономика подходит.

## BGS-циклы и состояния

### Как работает BGS в колониях

1. Каждая система имеет **фракцию-владельца** (та, у которой куплен клейм)
2. Фракция может находиться в разных **состояниях (states)**
3. Состояния меняются каждый **tick** (ежедневно)

### Полезные состояния

| State | Эффект | Как вызвать |
|-------|--------|-------------|
| **Boom** | +25% доход, быстрый рост | Торговля, миссии на доход |
| **Expansion** | Расширение в соседние системы | Высокое влияние, население |
| **Investment** | Бонусы к строительству | Продажа товаров, доходы |
| **Civil Liberty** | Высокий SoL | Миссии на безопасность |

### Вредные состояния

| State | Эффект | Как избежать |
|-------|--------|--------------|
| **Bust** | -25% доход, замедление | Не допускайте дефицита товаров |
| **Civil Unrest** | Низкая безопасность | Поддерживайте Security |
| **Famine** | Нет еды, кризис | Стройте Agricultural объекты |
| **Outbreak** | Медицинский кризис | Стройте медицинские объекты |

## Манипуляция BGS

### Для одиночек

1. Выполняйте **миссии** для вашей фракции
2. **Продавайте товары** на рынках вашей системы
3. **Сканируйте** данные и продавайте их
4. Участвуйте в **Conflict Zones** (если Military)

### Для Squadron

1. **Координируйте миссии** — 10 пилотов = 10x эффект
2. **Организуйте торговые рейсы** — массовые продажи товаров
3. **Stackable massacre missions** — Military-экономика + CZ
4. **Bounty hunting** — повышает Security

### Типичная BGS-рутина (30 минут)

```
1. Взять 3 миссии на доставку для вашей фракции
2. Купить товары и доставить
3. Взять 2 миссии на bounty hunting
4. Полететь в RES, заработать 500k+ bounties
5. Сдать миссии и bounties
6. Повторить на следующей системе
```

## Экономические стратегии

### Стратегия 1: Торговый хаб

**Цель:** Максимальный Wealth + Population

**Объекты:**
- Coriolis / Ocellus (Commercial focus)
- Commercial Outpost
- Space Farm
- Civilian Hub

**Результат:** Высокие цены, много миссий, пассивный доход

### Стратегия 2: Промышленный комплекс

**Цель:** CMM Composite + Industrial товары

**Объекты:**
- Asteroid Base (Extraction)
- Industrial Settlement (Large)
- Refinery Hub
- Mining Outpost

**Результат:** Производство ключевых товаров, экспорт в Bubble

### Стратегия 3: Военная база

**Цель:** Stackable massacre missions

**Объекты:**
- Military Settlement (Large)
- Military Hub
- Military Outpost
- Starport с высоким Security

**Результат:** 50–100 млн/час на massacre missions

### Стратегия 4: Научный центр

**Цель:** High Tech + продажа данных

**Объекты:**
- Scientific Settlement (Large)
- Scientific Hub
- Research Station
- Communication Station

**Результат:** Доступ к G5 модулям, высокие цены на данные

## Частые вопросы

### Q: Почему на моём рынке нет товаров?

A: Проверьте:
1. Прошёл ли **первый тик** после постройки?
2. Правильная ли **экономика** (Refinery для CMM)?
3. Не считает ли **government** товар illegal?
4. Достаточно ли **населения**?

### Q: Как быстрее растить население?

A:
1. Стройте объекты с **Population Increase** (Starports, Planetary Port)
2. Поддерживайте **Boom** state
3. Стройте **Agricultural** объекты (SoL → рост населения)
4. Ждите — рост пассивный, но ускоряется активностью

### Q: Можно ли изменить government type?

A: Напрямую — нет. Но можно привезти **Player Minor Faction** с нужным government type и вырастить её влияние до 75%+.

### Q: Что делать, если фракция уходит в Bust?

A:
1. Массово продавайте товары на рынок
2. Выполняйте миссии на доход
3. Избегайте миссий, которые забирают товары из системы
4. Подождите 3–7 дней — BGS самокорректируется

## Оценка

BGS — это «тёмная материя» Elite Dangerous. Она невидима, но определяет всё. Понимание экономики колонии позволяет превратить пустую систему в **процветающий торговый хаб** или **неприступную военную крепость**. Не игнорируйте BGS — это разница между «построил и забыл» и «построил и процветаю».$c$,
    v_cat_colonization, v_author_id, v_author_id, 'published', false, 0, 1, NOW(), NOW()
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO v_article_id;

  IF v_article_id IS NOT NULL THEN
    INSERT INTO public.wiki_revisions (article_id, content, editor_id, revision_number, change_summary, created_at)
    VALUES (v_article_id, (SELECT content FROM public.wiki_articles WHERE id = v_article_id), v_author_id, 1, 'Initial seed', NOW());
  END IF;

END
$seed$;
