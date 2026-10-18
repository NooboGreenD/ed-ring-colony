# 3D-карта галактики: слои и подключение

> Обновлено 18.10.2026 (сайт 2.21.0). Раньше здесь лежала заготовка «как
> встроить `AtlasMarkers` в `GalaxyMap.tsx`» — это давно сделано, поэтому файл
> описывает, как карта устроена сейчас.

`GalaxyMap` (default export `index.ts`) — клиентский компонент на three.js +
React Three Fiber. Его используют две страницы:

* **`/map`** (`src/app/map/page.tsx`) — карта кольца колонизации: хабы,
  маршрут, пилоты, авианосцы, туманности, регионы, «Все системы ⚗»;
* **`/atlas`** (`src/app/atlas/page.tsx`) — та же карта рядом с вкладками
  Atlas; вкладки передают в неё свои слои через свойства.

Начало координат — Sagittarius A*, ось Z перевёрнута под three.js
(`GalaxyRegionBoundaries.tsx`, `RingZone.tsx`).

## Свойства `GalaxyMap`

| Свойство | Кто передаёт | Что рисуется |
|---|---|---|
| `focusSystem` | Atlas, поиск | Подлёт камеры к системе |
| `atlasCandidates` | Atlas «Поиск» | `AtlasMarkers` — найденные миры |
| `squadronRouteSystems`, `showOnlyMainRoute` | Atlas «Маршрут» | Маршрут проекта эскадрильи |
| `noMarketSystems`, `marketResults` | Atlas «Рынок» | `NoMarketMarkers`, `MarketResultMarkers` |
| `powerplay` (`GalaxyMapPowerplay`) | Atlas «PowerPlay» (`usePowerplayLayer`) | `PowerplayPoints` + `PowerplaySystemCard` |
| `factions` (`GalaxyMapFactions`) | Atlas «Фракции» (`useFactionsLayer`) | `FactionPoints` + `FactionSystemCard` |

Прогресс любого поиска Atlas (кольцо, коридор A→B, куб, точки, «луч»
сканирования) карта получает не через свойства, а через общий канал
`src/lib/atlasSearchProgress.ts` (`useAtlasSearchProgress`) → `SearchProgressLayer`.

## Слои

| Файл | Слой | Данные |
|---|---|---|
| `GalaxyScene.tsx` | Сцена: камера, подлёт (`FocusTarget`), сборка всех слоёв, общий выбор точек (`layerPick`) | — |
| `GalaxyBackground.tsx`, `GalaxyPlane.tsx`, `StarField.tsx` | Фон: плоскость галактики и звёздное поле | текстура `public/ed3d/spiral_joe.png`, частицы по карте высот (`src/lib/ed3dCanon.ts`) |
| `NebulaField.tsx`, `NebulaCard.tsx` | Туманности (объёмы по OpenNGC) и карточка | `src/lib/galaxyNebulae.ts`, `nebulaClouds.ts` |
| `GalacticRegions.tsx`, `GalaxyRegionBoundaries.tsx`, `GalaxyRegionMarkers.tsx` | 42 региона кодекса: границы и подписи | `src/lib/galacticRegions.json` |
| `RingZone.tsx` | Оранжевый пояс кольца колонизации (прозрачная труба) | константы кольца |
| `LandmarkMarkers.tsx` | Ориентиры Sol, Colonia, Sagittarius A*; клик — по экранной цели ~25–30 px, а не по свечению | `LANDMARKS` в `src/lib/ed3dCanon.ts` |
| `HubMarkers.tsx` | Хабы колонизации | `GET /api/hubs` |
| `RouteLine.tsx`, `RouteMarkers.tsx` | Общий маршрут кольца (до 20 000+ систем; интерактивных маркеров — ограниченное число) | `GET /api/route` |
| `PilotMarkers.tsx` | Пилоты, разрешившие показ позиции | `GET /api/map/pilots` |
| `CarrierMarkers.tsx`, `CarrierGlyph.tsx`, `CarrierLayerControls.tsx`, `CarrierSystemCard.tsx` | «Авианосцы»: значок как в игре, фильтры «мой / эскадрилья / другие» и «Drake / Javelin», список систем, карточка | `GET /api/map/carriers` ([FLEET-CARRIERS.md](../../../FLEET-CARRIERS.md)) |
| `AllSystemsPoints.tsx` | «Все системы ⚗»: облако точек каталога, `MapClickLayer` (выбор без raycast по облаку), `SelectedStarRing` | `GET /api/galaxy/all-systems` ([SPANSH-IMPORT.md](../../../SPANSH-IMPORT.md)) |
| `AtlasMarkers.tsx` | Кандидаты поиска миров | свойство `atlasCandidates` |
| `NoMarketMarkers.tsx`, `MarketResultMarkers.tsx` | Результаты поиска рынка | свойства вкладки «Рынок» |
| `PowerplayPoints.tsx`, `PowerplayGlyph.tsx`, `PowerplaySystemCard.tsx` | Системы держав PowerPlay: цвет — держава, форма — состояние | свойство `powerplay` ([POWERPLAY.md](../../../POWERPLAY.md)) |
| `FactionPoints.tsx`, `FactionSystemCard.tsx` | Системы минорных фракций: цвет — принадлежность или выбранная фракция | свойство `factions` ([FACTIONS.md](../../../FACTIONS.md)) |
| `SearchProgressLayer.tsx` | Процесс поиска Atlas | `atlasSearchProgress` |

Слои PowerPlay, «Фракции» и «Все системы» — это одно облако `THREE.Points`
со своим шейдером на десятки тысяч точек. Встроенный raycast three.js по
такому облаку подвешивает вкладку, поэтому клики разбирает `MapClickLayer`
(`extraPoints`), а слои отдают ему свои точки через `layerPick`.

## Как добавить слой

1. Данные — отдельный маршрут API и хук в `src/hooks/` (по образцу
   `usePowerplayLayer.ts` / `useFactionsLayer.ts`): загрузка, фильтр, выбранная
   точка, статус `idle | loading | ready | empty | error`.
2. Свойство `GalaxyMap` с готовыми точками и колбэком выбора (по образцу
   `GalaxyMapPowerplay` / `GalaxyMapFactions`), без запросов внутри карты.
3. Отрисовка — компонент слоя в этой папке; кликабельность — через
   `MapClickLayer`, а не через raycast облака.
4. Карточка выбранной системы — отдельный компонент `…SystemCard.tsx`
   поверх канваса.
5. Тесты — по образцу `scripts/tests/powerplay-ui.test.mjs` и
   `scripts/tests/factions-ui.test.mjs`.
