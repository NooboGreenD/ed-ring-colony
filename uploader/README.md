# Colonial Helper

Standalone desktop uploader for **ED Ring Colony**.

## Что делает

- Загружает журналы Elite Dangerous на сайт
- Отслеживает маршрут полёта (NavRoute.json / CSV)
- **Live-watcher**: автоматически читает новые строки из Journal.*.log
- **Инфографика пилота**: отдельная вкладка с живыми карточками CMDR, корабля, маршрута, груза, экономики, текущей сессии и подключённых сервисов
- **HUD Overlay**: плавающие окна поверх Elite Dangerous
  - Блок маршрута (текущая / следующая система, прогресс)
  - Блок статуса (подключение, watcher, лог процесса)
  - Настройки: прозрачность, шрифт, позиция, видимость блоков
  - Перетаскивание мышью, F12 — показать/скрыть

## Установка

```bash
pip install -r requirements.txt
python colonial_helper.py
```

## Сборка .exe

```bash
pip install pyinstaller
python build_exe.py
```

## Использование

1. Введите API токен (из профиля на сайте)
2. Укажите папку журналов Elite Dangerous
3. Загрузите логи вручную или включите Watcher
4. Во вкладке **Оверлей** настройте HUD и включите его
5. Играйте в Borderless Windowed — оверлей будет поверх игры

## Версия 2.0.0 и загрузка Journal

Uploader 2.0 использует идемпотентную обработку Journal-файлов с сохранением
byte-offset рядом с пользовательским конфигом:

```text
.colonial_helper_journal_offsets.json
```

При первом запуске watcher выполняет reconciliation всей доступной истории,
а затем продолжает с сохранённых позиций. При ротации Journal позиция
сбрасывается. В progress bar отображаются процент по байтам, число файлов,
прочитанный объём и имя текущего файла.

На ED Ring Colony отправляются два независимых типа данных:

- доставки игрока (`ColonisationContribution`, `CargoDepot`, FC `MarketSell` и
  безопасные cargo-delta) — в leaderboard deliveries;
- `ColonisationConstructionDepot` — публичные snapshots общего прогресса
  стройплощадки, ресурсы, construction ID и timestamp — в историю прогресса
  проекта. Эти snapshots не увеличивают личный тоннаж командира.

Повторная отправка безопасна: доставки используют `source_hash`, а события
строительства дедуплицируются по пользователю, времени, системе и construction
ID на сервере. Данные EDSM и Inara отправляются отдельно и не смешиваются с
API ED Ring Colony.

## Горячие клавиши

- **F12** — показать / скрыть оверлей
- **Ctrl+O** — включить / выключить оверлей

## Требования

- Windows 10/11
- Elite Dangerous в режиме **Borderless Windowed**
- Python 3.10+ (для запуска из исходников)
