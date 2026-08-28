# Colonial Helper

Standalone uploader для ED Ring Colony. Python GUI приложение с live-watcher журналов Elite Dangerous.

## Возможности

- **API Токен** — подключение по токену из профиля сайта
- **Загрузка логов** — выбор и отправка Journal.*.log файлов
- **Live Watcher** — автоматическое отслеживание новых записей в журналах
- **Маршрут** — импорт NavRoute.json / CSV, отметка посещённых систем, экспорт
- **Лог** — цветной терминал с timestamp

## Сборка .exe (Windows)

```bash
# 1. Установить Python 3.11+
# 2. Установить зависимости
pip install -r requirements.txt

# 3. Собрать .exe
python build_exe.py

# Результат: dist/ColonialHelper.exe
```

## Запуск из исходников

```bash
pip install -r requirements.txt
python colonial_helper.py
```

## Структура

- `colonial_helper.py` — главное GUI приложение (ttkbootstrap)
- `api_client.py` — HTTP клиент для API
- `journal_parser.py` — парсер журналов Elite Dangerous
- `route_tracker.py` — трекер маршрута
- `build_exe.py` — скрипт сборки PyInstaller
