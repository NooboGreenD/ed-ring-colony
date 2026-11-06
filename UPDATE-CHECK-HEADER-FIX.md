# «Сервер обновлений недоступен» сразу после установки: длинное тире в заголовке

## Что видел пользователь

После установки Colonial Helper через `Setup.exe` лаунчер открывался, новости
сайта грузились, а в блоке обновлений было:

```
Обновления сейчас недоступны.
Сервер обновлений недоступен: 'latin-1' codec can't encode character
'\u2014' in position 15: ordinal not in range(256)
```

Кнопки «Проверить обновления» и «Установить обновление» (серая) ничего не
меняли: ошибка повторялась при каждой проверке.

## Причина

`\u2014` — это длинное тире `—`, позиция 15 — в строке
`ColonialHelper/— (bundle update)`. Так `bundle_updater._headers()` собирал
`User-Agent`:

```python
f"ColonialHelper/{current or 'dev'} (bundle update)"
```

Свежая установка ещё не имеет указателя версии: `bundle.load_state()` отдаёт
`current = ""`, лаунчер подставляет заглушку `"—"` (см. `launcher_ui.py`,
`LauncherWindow.version`), а `check_updates()` брал именно её:

```python
current = str(state.get("current") or self.version)   # "—"
```

Дальше `requests`/`http.client` кодируют **заголовки** в latin-1 и падают ещё
до отправки запроса — проверяется это одной строкой:

```
>>> http.client.HTTPConnection("example.test").putheader("User-Agent", "ColonialHelper/— (bundle update)")
UnicodeEncodeError: 'latin-1' codec can't encode character '\u2014' in position 15: ordinal not in range(256)
```

Позиция 15 совпадает с жалобой пользователя один в один. `check_for_update()`
по контракту не бросает исключений (проверка идёт из фонового потока), поэтому
`UnicodeEncodeError` превращался в `Сервер обновлений недоступен: {error}`.
Сеть тут была ни при чём: запрос вообще не уходил.

Важно: имя приложения `ED Ring Colony — Colonial Helper` из `installer.py` в
заголовки не попадало и осталось как было — тире в названии окна не трогаем.

## Что изменено

| Файл | Изменение |
|---|---|
| `uploader/http_errors.py` | новые `header_safe()` (типографские знаки → ASCII, остальное не-ASCII отбрасывается) и `header_token()` (короткий токен для версии: `"—"` → пусто → `fallback`). `user_agent()` собирает имя и версию только через них |
| `uploader/bundle_updater.py` | `_headers()` кладёт в `User-Agent` `header_token(current, "dev")`: `ColonialHelper/dev (bundle update)` вместо строки с тире; версия `2.25.2` остаётся в заголовке |
| `uploader/launcher_window.py` | новая `current_version()`: заглушка `"—"` и вообще всё, что не начинается с цифры, превращается в пустую строку — «версия неизвестна». `check_updates()` передаёт в сеть именно её |

Пустая версия — рабочий случай: сервер считает, что ему нечего сравнивать, и
предлагает полный пакет (`plan_update()` скачает все файлы, `apply_update()`
поставит версию и запишет `current`). После первой установки обновления
работают как обычно.

## Тесты

* `uploader/tests/test_bundle_updater.py`
  * `test_headers_are_latin1_clean_even_with_placeholder_version` — `User-Agent`
    кодируется в latin-1 для `"—"`, `""`, `"2.25.1"` и кириллицы;
    `_headers("—")` = `ColonialHelper/dev (bundle update)`.
  * `test_update_check_works_for_a_fresh_install_without_a_version` — сервер-заглушка
    кодирует каждый заголовок в latin-1, как настоящий `http.client`, и проверка
    обновления для `current="—"` всё равно возвращает `ok` с доступной версией.
* `uploader/tests/test_launcher_window.py`
  * `test_fresh_install_checks_update_without_the_dash_placeholder` — окно с
    версией `"—"` спрашивает сервер с пустой версией, а не с заглушкой, и
    включает кнопку «Установить v…».
* `uploader/tests/test_third_party_api.py`
  * `test_user_agent_survives_latin1_with_the_dash_in_the_app_name` — `user_agent()`
    с полным именем приложения даёт `ED Ring Colony - Colonial Helper/2.25.1`,
    `apply_client_headers()` не оставляет в сессии значений вне latin-1.

## Как проверить руками

1. Установить сборку через `Setup.exe` на чистую машину (или удалить
   `%LOCALAPPDATA%\ColonialHelper\app\state.json`, чтобы повторить свежее
   состояние).
2. Открыть лаунчер: вместо «Обновления сейчас недоступны» должен появиться
   ответ сервера — «Установить v<версия>» либо «Установлена последняя версия».
3. Если на экране есть кнопка «Обновить», нажать: версия поставится, а
   `state.json` получит `current`; следующая проверка пойдёт уже с настоящей
   версией.
4. В `logs/launcher.log` не должно быть `UnicodeEncodeError`.

## Кому нужна новая базовая сборка

У пострадавшего пользователя проверка обновлений сломана **в самом exe**: у
него нет установленного пакета, поэтому лаунчер работает из встроенной копии
`app_bundle`, а её `bundle_updater` — тот же с тире. Такому пользователю нужен
новый `Setup.exe` (после этой правки), обычное обновление до него не доедет —
именно поэтому ошибка и была тупиковой.
