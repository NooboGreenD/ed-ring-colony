# Inara API: заявка на белый список

Inara не пускает в API никакие приложения, кроме внесённых в белый список: без
одобрения **любой** запрос — даже с правильным личным ключом — получает
`{"header": {"eventStatus": 400, "eventStatusText": "This application has no access allowed."}}`.
Ключ при этом действителен, дело именно в имени приложения (`header.appName`),
которое сверяется со списком.

Документ содержит готовый текст заявки администратору Inara (CMDR **Artie**),
порядок действий и проверку результата. Правила взяты из официального
dev-guide: <https://inara.cz/elite/inara-api-devguide/>.

---

## 1. Два имени приложения

Заявка должна содержать **точное** имя так, как оно уходит в запросах. У проекта
их два — это два разных клиента, и в белый список нужно внести оба.

| `appName` | Что это | `appVersion` | `isBeingDeveloped` | События |
|---|---|---|---|---|
| `ED Ring Colony Uploader` | Colonial Helper (десктоп) | реальная версия Helper (`VERSION` в `uploader/colonial_helper.py`, сейчас 2.28.2) | `true` | 7 событий «пилот/груз» (см. §2) |
| `ED Ring Colony` | Сайт проекта (серверные задачи) | версия сайта из `package.json` (сейчас 2.27.9) | `true` | `getCommunityGoalsRecent` (по расписанию), `getCommanderProfile` (только по инициативе пилота) |

Имена и версии — константы: `uploader/inara_api.py`
(`app_name="ED Ring Colony Uploader"`), `src/lib/inara/client.ts`
(`INARA_APP_NAME`, `INARA_APP_VERSION`). Менять их после одобрения нельзя: при
смене имени заявку придётся подавать заново.

## 2. Что именно отправляет Helper

Матрица `INARA_EVENTS` в `uploader/event_dispatch.py` — других событий в Inara
не уходит:

| Событие журнала Elite | Событие Inara API | Что обновляет в профиле |
|---|---|---|
| `Location` | `setCommanderTravelLocation` | текущая система, координаты, тело |
| `FSDJump` | `addCommanderTravelFSDJump` | перелёт в систему |
| `Docked` | `addCommanderTravelDock` | стыковка (станция, MarketID, корабль) |
| `CarrierJump` | `addCommanderTravelCarrierJump` | прыжок авианосца |
| `Touchdown`, `DropShipDeploy` | `addCommanderTravelLand` | посадка на поверхность |
| `MarketBuy` | `addCommanderInventoryCargoItem` | груз в трюме: приход |
| `MarketSell` | `delCommanderInventoryCargoItem` | груз в трюме: расход |

Сайт читает две вещи: `getCommunityGoalsRecent` — витрина целей сообщества,
задача `cg-check` (раз в шесть часов), результат лежит в базе `community_goals`;
`getCommanderProfile` — только по запросу самого пилота из его кабинета
(`POST /api/inara/sync`) и только его личным ключом, автоматических вызовов нет.

## 3. Как выполнены правила dev-guide

| Правило Inara | Как сделано |
|---|---|
| Батчинг: не слать события по одному | `InaraAPI.submit_batch` — до 25 событий в одном запросе; диспетчер копит их ~5 с и отправляет пакетом (`MAX_BATCH`, `BATCH_LINGER` в `uploader/inara_api.py`) |
| Не больше двух запросов в минуту | `MIN_REQUEST_INTERVAL = 30.0`: между запросами к Inara не меньше 30 с (`_flush_inara` в `uploader/event_dispatch.py`) |
| Не повторять уже отправленное | Дедупликация по `(timestamp, event, SystemAddress, BodyID, MarketID)` в диспетчере |
| Кэш на своей стороне для чтения | CG запрашиваются раз в шесть часов и лежат в базе (`community_goals`), профиль — только по запросу пилота, не в цикле |
| Только Live-игра, без Legacy 3.8 и бет | `_inara_game_version_allowed()`: версия из `Fileheader`/`LoadGame`, `3.*`, `alpha`, `beta` не отправляются |
| `eventTimestamp` — настоящий, не старше 30 дней | Берётся из журнала как есть; историческая загрузка по умолчанию **выключена** (`backfill_send_third_party = false`) |
| Не быть «ретранслятором данных» (рынки, фракции, системы, станции) | Из Inara не забираются рынки/фракции/системы — только CG и собственный профиль пилота; чужие данные не собираются |
| Личный ключ — у пилота | Helper хранит ключ локально в своём конфиге; сайт использует один прикладной ключ (`INARA_API_KEY`) только для CG |

## 4. Готовое письмо

Отправлять **на английском** (так отвечает Artie), одним личным сообщением.
Подставить актуальную версию Helper и сайта.

> **Тема:** Inara API whitelist request — ED Ring Colony / ED Ring Colony Uploader
>
> Hello Artie,
>
> I would like to request access to the Inara API for our Elite Dangerous
> colonisation project, ED Ring Colony. It is a website plus a desktop
> companion app, and we need two application identifiers whitelisted.
>
> **1) Application names, exactly as sent in the request header**
>
> - `ED Ring Colony Uploader` — the desktop companion ("Colonial Helper"),
>   current version 2.28.2, `isBeingDeveloped: true`. It uses the commander's
>   own Inara API key, which the pilot enters in the app and which is stored
>   locally on that pilot's machine.
> - `ED Ring Colony` — our website backend, current version 2.27.9,
>   `isBeingDeveloped: true`. It uses one application key for a daily read-only
>   `getCommunityGoalsRecent` call every six hours (the answer is cached in our
>   database), and
>   a pilot's own key only when that pilot asks to refresh their own profile
>   (`getCommanderProfile`); nothing is scheduled per pilot.
>
> If you would prefer a single identifier for both clients, please tell me
> which one and I will use only that name everywhere.
>
> **2) What the application does**
>
> ED Ring Colony helps players coordinate colonisation: construction projects
> and their material needs, fleet carriers and their jump history, a galaxy
> atlas and a community-goal overview. The desktop companion reads the game
> journal (Live only) and uploads colonisation data to our own servers. On top
> of that it forwards a small set of travel and cargo events to Inara with the
> pilot's own key, so a coloniser's Inara profile stays current while they
> hop between construction sites:
>
> - `setCommanderTravelLocation`, `addCommanderTravelFSDJump`,
>   `addCommanderTravelDock`, `addCommanderTravelCarrierJump`,
>   `addCommanderTravelLand` — location, jumps, docking, carrier jumps and
>   surface touchdowns;
> - `addCommanderInventoryCargoItem`, `delCommanderInventoryCargoItem` — cargo
>   loaded or sold.
>
> The website only calls `getCommunityGoalsRecent` (every six hours, cached) and, on
> a pilot's explicit action, `getCommanderProfile` with that pilot's key.
>
> We do not use the API as a data relay: we do not pull markets, minor faction
> influence, star systems or stations from Inara, we do not scrape commander
> data and we never send data on behalf of a pilot who has not provided their
> own key.
>
> **3) Short description for the Inara application list**
>
> ED Ring Colony — a colonisation planner and companion for Elite Dangerous.
> The desktop app keeps your Inara profile up to date with your travel,
> docking and fleet carrier cargo events while you build up the galaxy.
>
> **4) Homepage / download**
>
> - Homepage: <https://edringcolony.ru>
> - Source code and releases: <https://github.com/NooboGreenD/ed-ring-colony>
>
> **Compliance with the API rules**
>
> - Events are batched: up to 25 events per request, and no more than one
>   request every 30 seconds per tool.
> - Only real, new journal events are sent, de-duplicated locally; history is
>   not re-uploaded by default.
> - Only the Live game is supported: journals identified as Legacy 3.8, beta or
>   alpha are skipped, `eventTimestamp` always comes from the journal.
> - Read-only results are cached on our side.
>
> The desktop app is under active development, so `isBeingDeveloped` is `true`
> in both clients. So far every request has been rejected with "This
> application has no access allowed.", so the API has not been used yet. I will
> be glad to answer any questions or provide logs.
>
> Thank you,
> CMDR <ваше имя> (ED Ring Colony)

## 5. Пошагово

0. **Сначала релиз, потом заявка.** В письме описано поведение из этой ветки
   (батчинг, лимит 30 с, отсев Legacy/бета). Выпустите Helper с этими
   изменениями и обновите `VERSION` — иначе письмо будет обещать больше, чем
   делает текущая сборка.
1. **Войти на Inara** под аккаунтом автора проекта (тем, чьё имя будет в
   заявке) и убедиться, что в профиле указан CMDR.
2. **Взять свой API-ключ:** Commander → Settings → API
   (<https://inara.cz/elite/cmdr-settings-api/>). Ключ нужен для проверки после
   одобрения; **в письмо его не вставлять** — это личный секрет.
3. **Открыть профиль Artie:** <https://inara.cz/elite/cmdr/1/> → «Send
   message» (личное сообщение).
4. **Вставить текст из §4**, подставив версии и своё имя CMDR. Тема — как в
   шаблоне, чтобы письмо было легко найти в переписке.
5. **Приложить ссылки** (они уже в письме): сайт и репозиторий с релизами.
   Скриншот блока «Inara API» в Helper (вкладка «Подключение») — по желанию,
   он показывает, что ключ вводит сам пилот.
6. **Ждать.** Фиксированного срока Inara не обещает (по опыту заявок в теме
   API — от нескольких дней до недели); повторять письмо каждый день не нужно.
   Если ответа нет 7–10 дней, вежливо напомнить в том же диалоге (не новым
   письмом) или в публичной теме по API:
   <https://inara.cz/elite/board-thread/7049/>.
7. **До одобрения** ничего настраивать не нужно: запросы всё равно вернут
   `400 This application has no access allowed.` Helper пишет об этом одну
   строку в лог (без повторов — `error_kind = inara_not_whitelisted`,
   `retryable = false`), а задача `cg-check` продолжает наполнять каталог CG из
   других источников. Поле «Inara API key» можно оставить пустым.
8. **После одобрения:** заполнить в Helper «Подключение → Inara API» ключ и имя
   командира, нажать «Сохранить Inara настройки»; статус сменится на
   «Inara: включена». Приложение должно появиться в списке
   <https://inara.cz/elite/inara-api/> с описанием из §4.

## 6. Проверка, что доступ появился

Пока приложение не в списке, любой запрос возвращает `400` в заголовке. После
одобрения тот же запрос даёт `200` и по каждому событию. Проверка из PowerShell
(Windows 10/11), ключ — свой личный:

```powershell
$key = "ВАШ_КЛЮЧ"
$cmdr = "Ваш CMDR"
$body = @{
  header = @{
    appName = "ED Ring Colony Uploader"
    appVersion = "2.28.2"
    isBeingDeveloped = $true
    APIkey = $key
    commanderName = $cmdr
  }
  events = @(@{
    eventName = "getCommanderProfile"
    eventTimestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    eventData = @{ searchName = $cmdr }
  })
} | ConvertTo-Json -Depth 6

Invoke-RestMethod -Uri "https://inara.cz/inapi/v1/" -Method Post `
  -ContentType "application/json" -Body $body | ConvertTo-Json -Depth 8
```

Как читать ответ:

| Ответ | Значение |
|---|---|
| `header.eventStatus = 200`, `events[0].eventStatus = 200` | приложение в белом списке, всё работает |
| `header.eventStatus = 400`, `"This application has no access allowed."` | имя ещё не одобрено (ключ при этом верный) |
| `header.eventStatus = 400`, `"Invalid API key"` | ключ неверный или отозван |
| `events[0].eventStatus = 204` / `202` | мягкая ошибка/предупреждение по самому событию, доступ есть |

## 7. Если откажут

Причины из dev-guide и темы API, на которые чаще всего ссылаются:

- **«Inara API doesn't provide the data you need»** — если приложение
  фактически строится на рынках/фракциях/системах/станциях. В заявке прямо
  сказано, что мы их не запрашиваем; если Artie всё же так решил, стоит
  сократить заявку до событий Helper и убрать сайт.
- **Нет домашней страницы/ссылки, где скачать** — ссылки в письме обязательны и
  должны открываться.
- **Слишком общее описание или «AI-саммари»** — описание должно быть конкретным
  (что делает, какие события, для кого).
- **Спам запросами** — ключ и приложение могут отключить уже после одобрения:
  за это отвечают батчинг и лимит из §3.

После исправления замечания заявку можно подать повторно в том же диалоге —
указав, что именно изменено.

## 8. Что изменено в коде под эти правила

- `uploader/inara_api.py` — пакетная отправка (`submit_batch`), константы
  `MAX_BATCH = 25`, `MIN_REQUEST_INTERVAL = 30`, `BATCH_LINGER = 5`; одиночный
  `submit()` сохранён. Пакет считается успешным, только если Inara приняла
  каждое событие.
- `uploader/event_dispatch.py` — буфер и отдельный поток отправки пакета, лимит
  частоты, отсев Legacy/бета по версии игры из `Fileheader`/`LoadGame`,
  попытка отправить остаток при закрытии Helper'а.
- `src/lib/inara/client.ts` — `appVersion` берётся из `package.json` (а не
  `"1.0"`), `isBeingDeveloped: true`; имя закреплено константой
  `INARA_APP_NAME`.
- `uploader/tests/test_third_party_api.py` — тесты пакета, лимита частоты и
  отсева Legacy/бета.

## 9. Источники

- Dev-guide: <https://inara.cz/elite/inara-api-devguide/>
- Документация API (header, `eventStatus`, лимиты):
  <https://inara.cz/elite/inara-api-docs/>
- Список приложений: <https://inara.cz/elite/inara-api/>
- Ключи командира: <https://inara.cz/elite/cmdr-settings-api/>
- Профиль администратора: <https://inara.cz/elite/cmdr/1/>
