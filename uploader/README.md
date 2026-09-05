# Colonial Helper

Standalone desktop uploader for **ED Ring Colony**.

## Что делает

- Загружает журналы Elite Dangerous на сайт
- Отслеживает маршрут полёта (NavRoute.json / CSV)
- **Live-watcher**: автоматически читает новые строки из Journal.*.log
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

## Горячие клавиши

- **F12** — показать / скрыть оверлей
- **Ctrl+O** — включить / выключить оверлей

## Требования

- Windows 10/11
- Elite Dangerous в режиме **Borderless Windowed**
- Python 3.10+ (для запуска из исходников)
