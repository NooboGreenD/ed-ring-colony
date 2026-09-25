# Мобильная админ-панель и Android-приложение

В проект добавлены два взаимосвязанных продукта для мониторинга сайта с мобильных устройств:

1. **Веб-версия мобильной админки** `/m-admin` — PWA-ready, полностью адаптирована под телефон, в стиле сайта (HUD).
2. **Нативное Android-приложение** `android-app/` — Kotlin + Jetpack Compose, повторяет все пункты админ-панели.

Оба используют единый бэкенд-агрегатор `/api/mobile/admin-summary`.

---

## 1. Веб-версия `/m-admin`

### Что это
Отдельная страница Next.js, оптимизированная под мобильные устройства. Может использоваться:
- напрямую в браузере телефона,
- как WebView внутри Android-приложения (fallback),
- как PWA (установка на домашний экран через `manifest-mobile.json`).

### Дизайн
Сохранён стиль из `DESIGN.md`:
- Цвета: `#1e2022` bg, `#2a2d30` panel, `#3a3d40` line, `#eeeeee` text, `#9ca3af` muted, `#e67e22` orange, `#3498db` cyan, `#2ecc71` green, `#e74c3c` red
- Шрифты: `ui-monospace` для лейблов/статов, `Segoe UI` для контента, uppercase + letter-spacing 2px
- Компоненты: flat, без теней, без скруглений >4px, border 1px solid
- Навигация: bottom bar 9 вкладок в стиле HUD, активная — оранжевый акцент + полупрозрачный фон

### Вкладки (по пунктам админки)
| Админка | `/m-admin` таб | Что показывает |
|---|---|---|
| Dashboard | Обзор | Health pills (APP/DB/DISK/VER), счётчики профилей/хабов/маршрута/новостей/тикетов/галактики, приложение (uptime/node/rss/heap), БД (size/latency/largest), диск (used/free + прогресс), версия (current/upstream/ahead/migrations), биллинг кратко |
| Мониторинг | Монитор | Docker контейнеры (state/health/restart), фоновые задачи (last/next/error), контент и переводы (translate configured/pending/queue/lastSync), топ таблиц БД с прогресс-барами |
| Биллинг | Биллинг | Выручка, транзакции, avg check, ARPU, active subs, churn, телеметрия (пилоты/системы/постройки/тоннаж/тикеты/tokens), топ товары |
| Хабы/Маршрут/Каталог | Системы | Хабы с цветным бордером по статусу, маршрут с прогресс-барами, галактика total systems + пояснение |
| Контент/Новости/Форум/Комменты | Контент | Последние новости (title/date/status), форум/посты/комменты/Galnet счётчики |
| Управление | Юзеры | Всего профилей, API tokens, ссылка на полную админку |
| Техподдержка | Поддержка | Открытых/всего тикетов |
| Бэкапы/Обновление | Бэкапы | Current/upstream/ahead/updater connected/active, миграции, последние бэкапы |
| Авторизация | Auth | Провайдеры OAuth, флаги app_flags |

### API
- `GET /api/mobile/admin-summary?period=30d` — агрегатор, требует admin роль, возвращает overview/monitor/billing/lists/content/flags/health
- `GET /api/mobile/auth` — проверка сессии и роли
- `POST /api/mobile/auth` — логин email/password → access_token

### Как открыть
```
https://your-domain.com/m-admin
```
Требует авторизацию как администратор. В preview (e2b.app, localhost) доступен без Supabase как CMDR Admin (Preview).

---

## 2. Android-приложение `android-app/`

### Стек
- Kotlin 1.9.22, Gradle 8.4, Android Gradle Plugin 8.2.2
- Min SDK 26, Target 34, Compile 34
- Jetpack Compose + Material3 (кастом тема)
- Navigation Compose (9 экранов)
- Retrofit2 + OkHttp + Gson
- EncryptedSharedPreferences для токенов
- Coroutines

### Структура
```
android-app/
  app/
    src/main/
      AndroidManifest.xml
      java/com/edringcolony/monitor/
        MainActivity.kt — Scaffold + TopBar + BottomNav + Auth + Auto-refresh
        EDApplication.kt
        data/
          local/TokenManager.kt — EncryptedSharedPreferences
          model/AdminSummary.kt — все модели (Overview, Health, Hub, Route, News, Billing, MonitorSnapshot, Container, Job, etc)
          network/ApiService.kt, AuthInterceptor.kt, RetrofitClient.kt
          repository/MonitorRepository.kt
        ui/
          theme/Color.kt, Type.kt, Theme.kt — палитра из DESIGN.md
          components/StatusPill.kt, StatCard.kt, LoadingView.kt
          screens/LoginScreen.kt, DashboardScreen.kt, MonitorScreen.kt, BillingScreen.kt, SystemsScreen.kt + Content/Users/Support/Backup/Auth
          navigation/BottomNav.kt, NavGraph.kt
      res/
        values/strings.xml, colors.xml, themes.xml
        drawable/ic_launcher_background/foreground.xml
        mipmap-*/ic_launcher.xml
  build.gradle.kts, settings.gradle.kts, gradle.properties
```

### Экраны (9)
Каждый экран — `@Composable` с `LazyColumn`, `HudCard`, `StatCard`, `StatusPill`, `LevelBadge`, прогресс-барами.

- **DashboardScreen** — health pills + stats grid 2x3 + App/DB/Disk/Version карточки
- **MonitorScreen** — Docker контейнеры с цветным левым бордером, jobs с ошибками, content pipeline, топ таблиц с прогресс-барами
- **BillingScreen** — revenue grid, telemetry grid, топ товары
- **SystemsScreen** — хабы (name/system_name/status pill), маршрут (sort_order + progress bar), галактика
- **ContentScreen** — новости (title/date/status), форум счётчики
- **UsersScreen** — профили/tokens
- **SupportScreen** — тикеты
- **BackupScreen** — версия проекта, бэкапы
- **AuthScreen** — провайдеры, флаги

### Логин
`LoginScreen` принимает email, password, baseUrl. Делает `POST /api/mobile/auth`, сохраняет токены в EncryptedSharedPreferences, затем грузит `/api/mobile/admin-summary`.

### Автообновление
Как и веб-панель мониторинга — каждые 20 секунд (`delay(20000)` в `LaunchedEffect`).

### Сборка APK
```bash
cd android-app
./gradlew assembleDebug   # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease # release (нужен keystore)
```

Для локальной разработки с `npm run dev`:
- В эмуляторе baseUrl = `http://10.0.2.2:3000`
- На устройстве в той же Wi-Fi — `http://192.168.x.x:3000`

### Безопасность
- Токен в EncryptedSharedPreferences, исключён из backup (backup_rules.xml, data_extraction_rules.xml)
- `usesCleartextTraffic=false`
- Все запросы с Bearer
- API требует admin роль

### Дальнейшее развитие
- Push через FCM при critical статусе (опрос /api/status)
- Виджет с overall статусом
- Кнопки действий: "Обновить сейчас", "Синхронизировать Galnet", "Добить переводы" (POST на существующие admin API)
- Графики (MPAndroidChart)
- Room cache для offline
- Biometric login

---

## 3. Интеграция с существующей админкой

Новая мобильная версия не ломает существующую `/admin`:
- `/admin` остаётся десктопной (sidebar + таблицы)
- `/m-admin` — мобильная, bottom nav, карточки вместо таблиц
- Оба используют одни и те же API (`/api/admin/monitor`, `/api/admin/billing/stats` и т.д.), но `/m-admin` предпочитает агрегатор `/api/mobile/admin-summary` для экономии запросов

Ссылки:
- Из `/m-admin` есть кнопки "Открыть полную админку" → `/admin?tab=...`
- Из `/admin` можно добавить баннер "Открыть мобильную версию" → `/m-admin` (опционально)

---

## 4. Тестирование

### Веб-версия
```bash
npm run dev
# открыть http://localhost:3000/m-admin
# логин как админ, проверить 9 вкладок, refresh, 20s auto-refresh
```

### Android
```bash
# Открыть android-app в Android Studio
# Sync Gradle
# Run на эмуляторе Pixel 7 API 34
# Ввести email/password админа и baseUrl
# Проверить все 9 экранов, pull-to-refresh (кнопка ↻ в topbar), logout
```

### API
```bash
curl -H "Authorization: Bearer <token>" https://your-domain.com/api/mobile/admin-summary?period=30d | jq
```

---

## 5. Файлы, добавленные в PR

- `src/app/api/mobile/admin-summary/route.ts` — агрегатор
- `src/app/api/mobile/auth/route.ts` — auth для приложения
- `src/app/m-admin/layout.tsx` — metadata + viewport + PWA manifest link
- `src/app/m-admin/page.tsx` — мобильная админка (React, ED стиль, 9 вкладок, auto-refresh)
- `public/manifest-mobile.json` — PWA манифест
- `android-app/` — полный Android проект (Kotlin + Compose)
- `MOBILE-ADMIN.md` — этот документ

---

## Скриншоты (описание, т.к. эмулятор не доступен в CI)

- **Login**: тёмный фон #1e2022, карточка #2a2d30 с оранжевым бордером, логотип E на оранжевом фоне, поля email/password/baseUrl, кнопка "ВОЙТИ" с оранжевым бордером
- **Dashboard**: topbar #1a1c1e с брендом и overall pill, health pills row, stats grid 2 колонки (Командиры, Хабы, Маршрут, Новости, Тикеты, Галактика), карточки Приложение/БД/Диск/Версия с monospace лейблами
- **Monitor**: Docker контейнеры с зелёным/красным левым бордером, jobs с warning pills и ошибками на жёлтом фоне, контент с pending count, топ таблиц с cyan→orange градиентом прогресс-бара
- **Billing**: revenue grid, telemetry grid, топ товары список
- **Systems**: хабы список с цветным бордером (planned=muted, building=orange, done=green), маршрут с тонким прогресс-баром
- **Bottom Nav**: 9 иконок HUD (◧◍₿⬡☰👤🎧💾🔒) + 4-буквенный лейбл, активная — оранжевый текст на полупрозрачном оранжевом фоне, неактивная — muted

---

## Лицензия
MIT, как и основной проект.
