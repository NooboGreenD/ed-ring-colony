# ED Ring Colony — Android Monitor App

Нативное Android-приложение для мониторинга сайта **ED Ring Colony**, полностью повторяющее пункты админ-панели, с адаптацией под мобильные устройства и сохранением фирменного стиля сайта.

## Фирменный стиль (DESIGN.md)
- **Цвета**: `--bg #1e2022`, `--panel #2a2d30`, `--line #3a3d40`, `--text #eeeeee`, `--muted #9ca3af`, `--orange #e67e22`, `--cyan #3498db`, `--green #2ecc71`, `--red #e74c3c`
- **Типографика**: `ui-monospace` для лейблов/статов, `Segoe UI` для контента, `letter-spacing 2px`, `uppercase`
- **Компоненты**: flat, brutal, без теней, без скруглений >4px, границы 1px solid
- **Философия**: Dark sci-fi military HUD

## Что мониторит (по пунктам админки)
| Вкладка админки | Экран в приложении | Данные |
|---|---|---|
| **Dashboard / Overview** | Обзор | Общая сводка: профили, хабы, маршрут, тикеты, галактика |
| **Мониторинг** | Монитор | Приложение (uptime, Node, память), БД (latency, размер), Docker (web/jobs/monitor-agent), фоновые задачи (jobs), диск, контент и переводы, версия проекта |
| **Биллинг и статистика** | Биллинг | Выручка, транзакции, подписки, топ товары, телеметрия проекта (пилоты, системы, постройки, тоннаж) |
| **Хабы / Маршрут / Каталог систем** | Системы | Хабы с координатами, статусами, маршрут с прогрессом, размер каталога Spansh |
| **Контент / Новости / Форум / Комментарии** | Контент | Последние новости, счётчики форума, комментариев, Galnet очередь |
| **Управление пользователями** | Юзеры | Количество профилей, API токенов, ссылка на полную админку |
| **Техподдержка** | Поддержка | Открытые/все тикеты |
| **Бэкапы / Обновление проекта** | Бэкапы | Текущая/ upstream ревизия, миграции, updater статус, логи бэкапов |
| **Авторизация** | Auth | Провайдеры OAuth, флаги app_flags |

## Архитектура Android
- **Language**: Kotlin
- **UI**: Jetpack Compose + Material3 (кастом тема под ED Ring)
- **Navigation**: Navigation Compose + Bottom Navigation (9 вкладок)
- **Network**: Retrofit2 + OkHttp + Gson + Kotlin Coroutines
- **Auth**: Supabase JWT Bearer token (хранится в EncryptedSharedPreferences)
- **DI**: Manual (simple) / Hilt-ready
- **Pattern**: MVVM (ViewModel + Repository + DataSource)

### API Endpoints используемые
- `POST /api/mobile/auth` — логин по email/password → access_token
- `GET /api/mobile/auth` — проверка сессии и роли
- `GET /api/mobile/admin-summary?period=30d` — агрегатор всей админ-панели
- `GET /api/admin/monitor` — детальный снапшот (fallback)
- `GET /api/admin/billing/stats` — биллинг (fallback)

## Сборка

### Требования
- Android Studio Hedgehog+
- JDK 17
- Android SDK 34
- Min SDK 26, Target 34

### Шаги
```bash
# 1. Открыть папку android-app в Android Studio
# 2. Указать URL сайта в local.properties или в TokenManager.kt
#    По умолчанию: https://edringcolony.ru (или ваш NEXT_PUBLIC_SITE_URL)
# 3. Sync Gradle
# 4. Run -> app
```

### Конфигурация URL
В `data/local/TokenManager.kt` или `local.properties`:
```properties
api.base.url=https://your-domain.com
# для эмулятора с локальным dev:
# api.base.url=http://10.0.2.2:3000
```

### Подпись APK
```bash
./gradlew assembleRelease
# APK: app/build/outputs/apk/release/app-release.apk
```

## Web-версия для WebView / PWA
Параллельно реализован мобильный веб-интерфейс `/m-admin` в Next.js:
- Полностью адаптирован под мобильные устройства
- Bottom navigation, карточки, статусы
- Опрашивает `/api/mobile/admin-summary` каждые 20с
- Может быть загружен в WebView Android-приложения как fallback
- PWA-ready с `manifest-mobile.json`

Файлы:
- `src/app/m-admin/page.tsx` — мобильная админка (React, ED стиль)
- `src/app/api/mobile/admin-summary/route.ts` — агрегатор
- `src/app/api/mobile/auth/route.ts` — auth для приложения

## Безопасность
- Токен хранится в EncryptedSharedPreferences (AndroidX Security)
- Все запросы с `Authorization: Bearer <token>`
- API требует роль `admin` / `moderator` / `support_manager`
- Никаких секретов в APK, только URL и anon key (как в веб-клиенте)

## Скриншоты (ожидаемые)
- Dashboard с health pills и статами
- Монитор: Docker контейнеры, jobs, диск прогресс-бар
- Биллинг: выручка, подписки, топ товары
- Системы: хабы с цветными бордерами по статусу
- Bottom nav в стиле HUD (оранжевый акцент для активной вкладки)

## Дальнейшее развитие
- Push-уведомления через Firebase при падении сервиса (используя /api/status)
- Виджет на рабочий стол с overall статусом
- Действие "Обновить сейчас" и "Синхронизировать Galnet" прямо из приложения (вызов /api/admin/monitor/update и /api/admin/galaxy)
- Графики (MPAndroidChart) для выручки и размера БД
- Offline cache с Room

## Лицензия
MIT, как и основной проект.
