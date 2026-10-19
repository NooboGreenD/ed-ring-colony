# Быстрый старт — Android Monitor

## Вариант 1: Веб-версия (без сборки, 1 минута)

Самая быстрая мобильная админка уже в проекте:

1. Запустите сайт: `npm run dev` или откройте прод
2. Откройте `/m-admin` на телефоне или в браузере
3. Войдите как администратор
4. Готово — 9 вкладок, автообновление каждые 20с, стиль HUD

```
https://edringcolony.ru/m-admin
```

Можно установить как PWA: в Chrome → "Установить приложение".

## Вариант 2: Нативное Android-приложение

> Ошибки сборки после #139 исправлены в web 2.25.2 — см. «Сборка после #139»
> в [README.md](README.md). Проверьте сборку в Android Studio перед раздачей APK.

### Сборка в Android Studio

1. Откройте папку `android-app` в Android Studio Hedgehog+
2. Дождитесь Gradle Sync
3. Запустите на эмуляторе Pixel 7 API 34 или устройстве
4. Введите email/пароль администратора сайта и адрес сайта (поле API BASE URL,
   по умолчанию `https://edringcolony.ru`; для эмулятора с локальным сервером —
   `http://10.0.2.2:3000`, HTTP разрешён только в debug-сборке)
5. Приложение загрузит сводку через `/api/mobile/admin-summary`

### Сборка APK вручную

Скрипта `gradlew` в репозитории нет — один раз создайте его локальным Gradle 8.4+:

```bash
cd android-app
gradle wrapper --gradle-version 8.4
./gradlew assembleDebug
# APK: app/build/outputs/apk/debug/app-debug.apk
# Установите на устройство: adb install app/build/outputs/apk/debug/app-debug.apk
```

### Структура экранов

- **Обзор** — health pills, счётчики, uptime, размер БД, диск, версия
- **Монитор** — Docker, jobs, контент очередь, топ таблиц
- **Биллинг** — выручка, подписки, телеметрия, топ товары
- **Системы** — хабы с цветным бордером, маршрут с прогрессом, галактика
- **Контент** — новости, форум, комменты, Galnet
- **Юзеры** — профили, токены
- **Поддержка** — тикеты
- **Бэкапы** — версия, миграции, updater, логи
- **Auth** — OAuth провайдеры, флаги

Все экраны используют палитру из DESIGN.md: #1e2022, #2a2d30, #3a3d40, #eeeeee, #9ca3af, #e67e22, #3498db, #2ecc71, #e74c3c.

## API для приложения

Приложение использует:

- `POST /api/mobile/auth` — логин, возвращает access_token
- `GET /api/mobile/auth` — проверка роли
- `GET /api/mobile/admin-summary?period=30d` — агрегатор всей админки

Требует роль admin/moderator/support_manager. Токен — Supabase JWT Bearer.

## Безопасность

- Токены в EncryptedSharedPreferences (исключены из бэкапа)
- `usesCleartextTraffic=false`
- Никаких секретов в APK

## Что дальше

- Добавить действия: "Обновить сейчас", "Синхронизировать Galnet"
- Push-уведомления при critical
- Виджет
- Графики

Вопросы — смотрите `MOBILE-ADMIN.md` в корне проекта.
