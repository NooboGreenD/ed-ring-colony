# ED Ring Colony — Design System & Style Guide

> **Official version for developers and AI tools.**
> Last updated: 2026-08-27 04:06 MSK.
> Applies to all pages: `/`, `/map`, `/squadrons`, `/projects`, `/forum`, `/news`, `/leaderboard`, `/systems`, `/cmdr/[name]`, `/atlas`, `/login`, `/register`, `/account`, `/admin`.

---

## 1. Philosophy

**Dark sci-fi military HUD.** No gradients, no shadows, no rounded corners (except `2px` for functional elements). Flat, brutal, functional. Every pixel serves a purpose.

- **No decorative elements** — every border, every line has a function
- **No shadows** — depth is achieved through color contrast only
- **No rounded corners above 4px** — sharp edges convey precision
- **Monospace for data** — `ui-monospace` for all labels, stats, timestamps
- **Sans-serif for content** — `Segoe UI` for body text

---

## 2. Color Palette

```css
:root {
  --bg:        #1e2022;   /* Main background */
  --panel:     #2a2d30;   /* Card/panel background */
  --panel-hover: #323538; /* Hover state for panels */
  --line:      #3a3d40;   /* Borders, dividers */
  --text:      #eeeeee;   /* Primary text */
  --muted:     #9ca3af;   /* Secondary text, labels */
  --orange:    #e67e22;   /* Primary accent, CTAs, active states */
  --orange-hover: #f39c12; /* Orange hover */
  --cyan:      #3498db;   /* Secondary accent, links, info */
  --green:     #2ecc71;   /* Success, online status */
  --red:       #e74c3c;   /* Error, danger, delete */
}
```

### Usage Rules
| Color | Purpose | Never Use For |
|-------|---------|---------------|
| `--orange` | Primary buttons, active tabs, highlights, links on hover | Error states, success messages |
| `--cyan` | Secondary buttons, info links, map accents | Primary CTAs |
| `--green` | Online status, success confirmations | Warnings |
| `--red` | Delete buttons, errors, validation | Primary actions |
| `--muted` | Labels, timestamps, secondary text | Primary content |
| `--line` | All borders, dividers | Backgrounds |

---

## 3. Typography

### Font Stack
```css
/* Body */
font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;

/* Monospace — labels, stats, timestamps, buttons */
font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
```

### Hierarchy
| Element | Size | Weight | Letter-spacing | Transform | Color |
|---------|------|--------|---------------|-----------|-------|
| H1 (hero) | `clamp(42px, 9vw, 108px)` | 800 | 6px | uppercase | `--text` |
| H2 | 18px | 700 | 2px | uppercase | `--text` |
| H3 | 16px | 600 | 2px | uppercase | `--orange` |
| Body | 14px | 400 | 0 | none | `--text` |
| Label | 11px | 600 | 2px | uppercase | `--muted` |
| Button | 12-13px | 400 | 2-3px | uppercase | `--orange` or `--cyan` |
| Stat number | 26px | 700 | 0 | none | `--orange` |
| Stat label | 11px | 400 | 2px | uppercase | `--muted` |
| Timestamp | 10-11px | 400 | 1-2px | uppercase | `--muted` |

### Rules
- **All headings**: `letter-spacing: 2px`, `text-transform: uppercase`, `margin-top: 0`
- **All labels/stats**: `font-family: ui-monospace`, `letter-spacing: 2px`, `text-transform: uppercase`
- **No font-size below 10px** (except timestamps at 10px)
- **No font-size above 108px** (hero only)

---

## 4. Layout

### Grid System
- **Desktop**: Sidebar (200px) + Main content (flex: 1)
- **Mobile** (< 768px): Sidebar becomes horizontal tabs, hamburger menu
- **Container**: No max-width — content fills available space
- **Padding**: `16px 20px` for main, `24px` for cards

### Z-Index Stack
| Layer | Z-Index | Element |
|-------|---------|---------|
| Background | 0 | Starfield, map canvas |
| Content | 1 | Page content |
| Sidebar | 40 | `.sidebar` |
| Topbar | 50 | `.topbar` |
| Overlay | 55 | `.mobile-overlay` |
| Drawer | 60 | `.sidebar-drawer` |
| Dropdown | 80 | `.user-menu-drop` |

---

## 5. Components

### 5.1 Buttons
```css
.btn {
  font-family: ui-monospace;
  letter-spacing: 3px;
  text-transform: uppercase;
  font-size: 13px;
  padding: 15px 30px;
  border: 1px solid;
  background: transparent;
  border-radius: 2px;
  transition: background 0.2s;
}

.btn-orange { border-color: var(--orange); color: var(--orange); }
.btn-orange:hover { background: rgba(255,157,46,0.12); }

.btn-cyan { border-color: var(--cyan); color: var(--cyan); }
.btn-cyan:hover { background: rgba(45,212,238,0.12); }
```

### 5.2 Cards
```css
.card {
  width: 100%;
  margin: 0 0 20px 0;
  padding: 24px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 4px;  /* ONLY 4px exception for cards */
}
```

### 5.3 Tabs
```css
.tab {
  border: 1px solid var(--line) !important;
  color: var(--muted) !important;
  background: transparent !important;
  border-radius: 2px;
}

.tab:hover {
  background: rgba(255,157,46,0.05) !important;
  color: var(--text) !important;
}

.tab-active {
  border-color: var(--orange) !important;
  color: var(--orange) !important;
}
```

### 5.4 Tables
```css
/* Header */
th {
  font-family: ui-monospace;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--muted);
  font-size: 11px;
  position: sticky;
  top: 0;
  background: var(--panel);
}

/* Cells */
td {
  padding: 9px 10px;
  border-bottom: 1px solid var(--line);
}

/* Hover row */
tr:hover { background: rgba(230,126,34,0.06); }
```

### 5.5 Forms
```css
input, textarea, select {
  margin: 4px 4px 4px 0;
  padding: 9px 12px;
  border-radius: 2px;
  border: 1px solid var(--line);
  background: #25282b;
  color: var(--text);
  font-size: 14px;
}

textarea {
  width: 100%;
  min-height: 140px;
  resize: none;
}
```

### 5.6 Avatars
```css
.avatar {
  width: 72px;
  height: 72px;
  border-radius: 50%;
  object-fit: cover;
  border: 2px solid var(--orange);
}

.avatar-sm {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  object-fit: cover;
  border: 1px solid var(--line);
}
```

### 5.7 Badges
```css
.badge {
  background: var(--orange);
  color: #1e2022;
  font-family: ui-monospace;
  font-size: 11px;
  padding: 5px 12px;
  border-radius: 999px;
  letter-spacing: 1px;
}
```

### 5.8 Chat (SquadronChat component)
```css
/* Message bubble — self */
background: rgba(230,126,34,0.12);
border: 1px solid rgba(230,126,34,0.2);
border-radius: 12px 12px 2px 12px;

/* Message bubble — other */
background: #25282b;
border: 1px solid #2d3033;
border-radius: 12px 12px 12px 2px;

/* @mention highlight */
color: #e67e22;
font-weight: 600;

/* Date separator */
font-size: 11px;
color: #6b7280;
font-family: ui-monospace;
```

---

## 6. Icons

All icons are **custom SVG** in `src/components/Icons.tsx`.

### Icon Spec
- **Size**: 16px default, 12-20px inline
- **Stroke**: 1.5px (thin, precise)
- **Color**: `currentColor` — inherits from parent
- **ViewBox**: `0 0 24 24`
- **No fill** — stroke-only

### Available Icons
| Icon | Purpose |
|------|---------|
| `IconAlliance` | Faction: Alliance |
| `IconEmpire` | Faction: Empire |
| `IconFederation` | Faction: Federation |
| `IconIndependent` | Faction: Independent |
| `IconPower` | Powerplay |
| `IconActivity` | Activity type |
| `IconHomeSystem` | Home system |
| `IconLanguage` | Language |
| `IconTimezone` | Timezone |
| `IconOpenRecruit` | Open recruitment |
| `IconDiscord` | Discord link |
| `IconWebsite` | Website link |
| `IconMembers` | Member count |
| `IconProjects` | Project count |
| `IconDone` | Completed status |
| `IconSquadron` | Squadron nav |
| `IconLeaderboard` | Leaderboard nav |
| `IconSuitable` | Suitable systems |
| `IconNotification` | Notification bell |
| `IconStats` | Statistics |
| `IconAtlas` | Atlas nav |
| `IconSettings` | Settings |
| `IconProfile` | User profile |
| `IconLock` | Locked/officer access |
| `IconNote` | Notes |
| `IconSearch` | Search |
| `IconError` | Error state |
| `IconCheck` | Success check |
| `IconBuilding` | Building status |
| `IconWaiting` | Waiting state |
| `IconUnsubscribe` | Unsubscribe |
| `IconSync` | Sync action |
| `IconDeepSync` | Deep sync |
| `IconHistory` | History |
| `IconArrowRight` | Next/forward |
| `IconArrowLeft` | Back |
| `IconSatellite` | Satellite |
| `IconPin` | Pin |
| `IconExternalLink` | External link |
| `IconSend` | Send message (chat) |
| `IconTrash` | Delete message (chat) |

### Adding New Icons
```tsx
export const IconNewName = (p: IconProps) => wrap(
  <><path d="M12 2..."/></>,
  p
);
```

---

## 7. Animations

### Allowed
| Animation | Duration | Easing | Use Case |
|-----------|----------|--------|----------|
| `background` transition | 0.15-0.2s | ease | Hover states |
| `color` transition | 0.2s | ease | Link hover |
| `opacity` transition | 0.2s | ease | Fade in/out |
| `transform` (translate) | 0.3s | ease | Drawer open |
| `width` (progress bar) | 0.5s | ease | Progress fills |
| `spin` | 1s | linear infinite | Loading spinner |

### Forbidden
- **No box-shadow animations**
- **No blur animations**
- **No scale animations** (except map tooltip pop: 0.2s)
- **No gradient animations**
- **No particle effects** (except Starfield on homepage)

---

## 8. Responsive Breakpoints

| Breakpoint | Behavior |
|------------|----------|
| > 768px | Full desktop: sidebar left, content right |
| <= 768px | Mobile: sidebar hidden, hamburger menu, horizontal tabs, touch targets 44px min |

### Mobile Overrides
- Tables become card stacks (`display: block`)
- `.hero h1` reduces to `clamp(28px, 12vw, 48px)`
- `.stats` moves from absolute to static
- `.sidebar` becomes horizontal flex wrap
- All buttons/links: `min-height: 44px`, `min-width: 44px`

---

## 9. File Structure

```
src/
  app/
    globals.css          # Main stylesheet — ALL styles here
    layout.tsx           # Root layout with topbar, sidebar, footer
    page.tsx             # Homepage
    [route]/
      page.tsx           # Route pages
      layout.tsx         # Optional route layouts
  components/
    Icons.tsx            # ALL icons — no external icon libraries
    SquadronChat.tsx     # Chat component (new)
    NotificationBell.tsx # Notification system
    Sidebar.tsx          # Navigation sidebar
    ...
  types/
    squadron.ts          # Squadron types
    ...
  lib/
    supabaseClient.ts    # Browser Supabase client
    supabaseServer.ts    # Server Supabase client
    ...
supabase/
  migrations/            # SQL migrations
public/
  favicon.ico
  ...
```

---

## 10. Rules for AI/Developers

1. **Never add inline styles** — use CSS classes from `globals.css`
2. **Never add new CSS files** — extend `globals.css` or `forum-extra.css`
3. **Never use CSS-in-JS** — no styled-components, no emotion
4. **Never use external icon libraries** — add to `Icons.tsx`
5. **Never change color palette** — the 9 colors are sacred
6. **Never add shadows** — depth via contrast only
7. **Never add rounded corners above 4px** — sharp edges only
8. **Always use `ui-monospace` for data/labels**
9. **Always use `letter-spacing: 2px` for uppercase text**
10. **Always test mobile** — 768px breakpoint is critical

---

## 11. Squadron Chat Specifics (New)

### Chat Bubbles
- **Self**: `rgba(230,126,34,0.12)` background, `12px 12px 2px 12px` radius
- **Other**: `#25282b` background, `12px 12px 12px 2px` radius
- **Max-width**: 70%
- **Gap between messages**: 8px

### @Mentions
- **Color**: `#e67e22` (same as primary accent)
- **Weight**: 600
- **Autocomplete**: dropdown with avatar + cmdr_name
- **Notification**: `squadron_chat_mention` type in `user_notifications`

### Officer Chat
- **Icon**: `IconLock` (12px) next to tab label
- **Access**: `can_manage_members || can_manage_projects || can_manage_ranks || can_edit_squadron`
- **Disabled state**: `opacity: 0.5`, `cursor: not-allowed`

---

*End of Design System. For questions — refer to `src/app/globals.css` as the single source of truth.*
