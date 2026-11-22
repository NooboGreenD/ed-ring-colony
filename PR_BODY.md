fix: страница пилота — полностью пересобрана, убраны все точки отказа

Страница /cmdr/[name]/ships не открывалась из-за Server Component,
который падал с 500 ошибкой. Причины:

1. createClient() вызывал cookies() из next/headers — мог падать при проблемах с сессией
2. createClient() НЕ был в try/catch — любая ошибка роняла всю страницу
3. Клиентские компоненты (Tr, CmdrProfileHeader, CmdrProfileName) в Server Component
4. shipImageUrlFromStorage() зависела от publicOrigin() и getPublicSupabaseUrl()

Исправлено:
- Убраны все клиентские компоненты — чистый серверный рендеринг
- Убран createClient() — только createServiceClient() в try/catch
- Весь рендер обёрнут в try/catch — при любой ошибке показывается страница с сообщением, а не пустой экран
- Картинки через прямой относительный URL /api/supabase/storage/v1/object/public/ship-images/...
- Простой текст вместо <Tr k="..."> компонентов

tsc --noEmit пройден без ошибок.