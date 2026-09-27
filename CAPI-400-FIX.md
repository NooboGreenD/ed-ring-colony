# «Подключение фиктивное»: CAPI /profile → HTTP 400

Симптом из отчёта: в Colonial Helper (uploader) кнопка **«Подключить
Frontier»** отрабатывает, браузер показывает «авторизация завершена», приложение
пишет «Frontier подключён», но нажатие **«Обновить досье»** даёт

```
Досье не обновлено: CAPI /profile: HTTP 400
```

Ниже — почему так происходит, что исправлено в коде и что сделать пилоту.

---

## 1. Что на самом деле значит HTTP 400 у Frontier

`400` от `companion.orerve.net` — это **не** «кривой запрос». Тело ответа:

```
Please Visit the store to purchase Elite: Dangerous.
```

То есть: «за учётной записью, которой выдан этот токен, игра не числится».
Так отвечают в двух ситуациях:

1. **Токен выдан не той платформе.** Игра куплена в Steam или Epic, а
   авторизация запрашивалась только для аккаунта магазина Frontier.
2. **Известный сбой Frontier с Epic-привязками** —
   [issues.frontierstore.net/issue-detail/21258](https://issues.frontierstore.net/issue-detail/21258):
   OAuth и `/me` работают, любой вызов CAPI отвечает 400. Обычно проходит само
   за несколько дней; помогает перепривязка Epic ↔ Frontier и вход в игру.

Ключевой момент: **OAuth в обоих случаях проходит полностью**. Токен настоящий,
`/decode` и `/me` на него отвечают. Именно поэтому привязка выглядит рабочей.

## 2. Причины в нашем коде

| # | Причина | Где было | Следствие |
|---|---------|----------|-----------|
| 1 | `audience=frontier` жёстко зашит | `uploader/companion_api.py`, `src/lib/capi/oauth.ts` | Пилот со Steam/Epic получал токен учётки магазина → CAPI 400 |
| 2 | Статус «подключён» ставился по факту наличия токена | `colonial_helper.py:_capi_refresh_status` | Нерабочая привязка выглядела рабочей |
| 3 | Ошибка показывалась как `HTTP 400` | `companion_api.CompanionClient._get` | Ни причины, ни подсказки |
| 4 | Заголовок `User-Agent: python-requests/2.x` | тот же `_get` | Frontier просит формат `EDCD-[A-Za-z]+-[.0-9]+` |
| 5 | Профиль разбирался по «плоским» полям | `profile_to_stats()` | Даже при 200 в досье уезжало только имя: CAPI отдаёт `commander.credits`, `commander.rank.*`, `lastSystem.name`, `ship.shipName` |
| 6 | Выгрузка шла через несуществующий `self.api_client` | `colonial_helper.py` (10 мест) | Досье/сканы/статистика молча не отправлялись, поток досье падал с `AttributeError` уже ПОСЛЕ ответа Frontier |
| 7 | Legacy-галактика не запрашивалась | `companion_api.py` | Пилот в Horizons 3.8 не получал данных вовсе |

Для сравнения: EDMC запрашивает `audience=frontier,steam,epic` — один запрос
на все три платформы, дальше Frontier сам показывает нужный способ входа.

## 3. Что изменено

### Colonial Helper (`uploader/`)

```
Подключить Frontier
   └─ audience = frontier,steam,epic   (или выбранная платформа)
        └─ токен сохранён
             └─ СРАЗУ проверка /profile   ← новое
                  ├─ 200 → «Frontier подключён и проверен (CMDR …)»
                  └─ 400 → «Связь не подтверждена: Frontier не видит купленную
                            Elite Dangerous…» + подсказка, что делать
```

* `DEFAULT_AUDIENCE = "frontier,steam,epic"`, в настройках — список
  **«Где куплена игра»** (Авто / Frontier / Steam / Epic / Xbox / PlayStation),
  сохраняется как `frontier_audience` в `~/.colonial_helper.json`.
* `CompanionClient.verify()` — единственный источник зелёного статуса;
  результат пишется рядом с токенами (`verified_at`, `verified_cmdr`,
  `last_error`, `last_hint`), поэтому после перезапуска видно реальное
  состояние.
* `describe_capi_error()` — перевод кодов: 400 (не та платформа + сбой Epic),
  401/403/422 (переподключиться), 418 (техобслуживание), 429 (лимит ~1 запрос
  в минуту), 204 (зайдите в игру), 5xx (временный сбой).
* `User-Agent: EDCD-ColonialHelper-<версия>` во всех запросах к Frontier
  (`/auth`, `/token`, `/decode`, `/me`, CAPI).
* Разбор профиля понимает настоящую структуру CAPI и «плоскую» форму.
* При 400/404 на Live запрос повторяется на `legacy-companion.orerve.net`.
* `self.api_client` стал свойством-псевдонимом `self.api` — выгрузка досье,
  сканов и статистики пилота снова работает.

### Сайт (`src/`)

* `normalizeAudience()` принимает список через запятую; по умолчанию —
  `frontier,steam,epic`. На `/account/capi` добавлен вариант **«Определить
  автоматически»** (выбран по умолчанию).
* `CapiError` получил вид `no_entitlement` для 400: вместо «Companion API
  ответил ошибкой 400» пользователю показывается объяснение и что делать.
  Повторять такой запрос и обновлять токен бессмысленно — это не сбой сети.

## 4. Что сделать пилоту

1. Обновить Colonial Helper до **2.12.1** (кнопка «Проверить обновления»).
2. В настройках приложения выбрать **«Где куплена игра»**: Steam, Epic или
   Frontier. Если не уверены — оставить «Авто».
3. Нажать **«Отключить»**, затем **«Подключить Frontier»**. На странице входа
   Frontier нажать кнопку своей платформы (**Steam** / **Epic**), а не входить
   почтой, если игра куплена там.
4. Дождаться строки «Frontier подключён и проверен (CMDR …)». Если вместо неё
   появилась красная строка — в ней написана причина и что делать.

Если и после этого 400:

* откройте <https://user.frontierstore.net/user/info> → **Linked Thirdparty
  Accounts** и проверьте, что Steam/Epic привязан; при сомнениях отвяжите и
  привяжите заново, запустив игру из лаунчера;
* один раз зайдите в игру — CAPI отдаёт профиль только после входа;
* для Epic-аккаунтов возможен сбой на стороне Frontier (issue 21258):
  повторите через сутки-двое.

## 5. Как проверить руками

```bash
# 1. Токен на месте?
cat ~/.colonial_helper_capi.json | python -m json.tool

# 2. Чей это токен и какая платформа
curl -s -H "Authorization: Bearer <access_token>" \
     -H "User-Agent: EDCD-ColonialHelper-2.12.1" \
     https://auth.frontierstore.net/me

# 3. Что именно отвечает CAPI (тело важнее кода)
curl -i -H "Authorization: Bearer <access_token>" \
     -H "User-Agent: EDCD-ColonialHelper-2.12.1" \
     https://companion.orerve.net/profile
```

`400 Please Visit the store to purchase Elite: Dangerous` в третьем запросе
означает ровно то, что описано выше: токен принадлежит учётке без игры.

## 6. Тесты

```bash
# приложение
python -m unittest discover -s uploader/tests -q      # 1203 теста
python -m unittest uploader.tests.test_capi_link -v   # 34 теста этой правки

# сайт
node --test scripts/tests/capi-pkce.test.mjs
node --test scripts/tests/capi-journal.test.mjs
npm test
```

Покрыто: выбор платформы и нормализация `audience`, формат User-Agent, разбор
кодов CAPI, фоллбэк на Legacy, различие «токен сохранён» ↔ «связь работает»,
разбор настоящего ответа `/profile`, поведение кнопки «Обновить досье»
(успех → выгрузка на сайт; 400 → причина в статусе и никакой выгрузки).
