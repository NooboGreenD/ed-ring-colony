# Mobile shell, manifesto alignment and equipped themes

## Changes

- Center the manifesto block itself, not only its text. Preserve line breaks;
  long words/URLs wrap instead of displacing the block.
- At widths up to 1024px, use a separate mobile shell: compact header,
  persistent five-item bottom dock, and a grouped two-column navigation sheet.
  Existing routes and translations are retained; Wiki and other sections are
  available through Menu. Desktop sidebar remains above 1024px.
- The menu sheet locks background scroll, makes background content inert,
  traps keyboard focus, closes on Escape/navigation/desktop resize, and restores
  focus to the opener. Hidden drawer links are not keyboard-focusable.
- Use safe-area insets and dynamic viewport height; reserve space for the dock.
  Larger touch controls and 16px form text avoid tiny targets and iOS input zoom.
- Adjust home hero/stats/actions, shop grids and fitting room, account heading,
  squadron grids, Wiki columns, station filters, notification popover and map
  viewport sizing. Wide tab strips scroll locally rather than stretching pages.
- Theme variables drive mobile panels and navigation, preserving the HUD style.

## Theme bug

Previously `invalidateCosmetics()` deleted cached data and notified hooks, but
hooks only requested data when the list of user IDs changed. This left an
already-mounted HUD provider without fresh equipment until reload. Concurrent
old responses could also overwrite newer equipment; failed requests were cached
as successful empty equipment, and the preview listener reset its override when
its effect was recreated.

Invalidation now marks data stale, immediately schedules requests for subscribed
IDs and keeps the current skin pending success. Per-user revisions reject late
responses from before an equip. In-flight requests are deduplicated. Failures
retain the last successful state and retry after a short cooldown; mounted hooks
also refresh expired data. Requests and API responses are `no-store`.

The provider subscribes to auth once, rejects stale initialization after an auth
change, keeps preview lifecycle independent of equipment fetches, and clears old
custom CSS effect variables on theme changes. Logout removes the skin. Equip
buttons in the shop and account serialize rapid clicks to avoid overlapping
mutations. Purchases/ownership and equipped-state persistence remain server-side;
there is no localStorage shortcut that could equip an unowned theme.

## Verification

- `npm run typecheck`
- `npm test -- cosmetics menu-i18n atlas-ui station-search-ui billing-and-shop`
- `npx playwright test tests/browser/mobile-shell.spec.ts` with a dev server
  (`npm run dev -- --hostname 0.0.0.0`). Optional
  `PLAYWRIGHT_CHROMIUM_EXECUTABLE` selects a locally installed Chromium.

Browser tests cover centered manifesto and navigation at 320/390/768/1024/1280px,
menu focus/resize, phone station filters and shop preview → equip → reload →
unequip with mocked API state. DOM tests cover stale responses, server failure,
preview restoration, CSS effect cleanup, logout/login and unequip. No production
billing database is modified by tests.

This is a shared-shell and primary-page redesign, not a claim that every admin,
3D map interaction, chat or long-data state has been audited on real phones.
Follow-up device acceptance should include iOS Safari/Android Chrome, landscape,
software keyboard, large system fonts, authenticated notifications and long
squadron/project names. Existing detailed-tool responsive rules remain in place.
No database migration is required.
