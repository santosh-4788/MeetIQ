# UI Design System — OneInsure Connect

Single source of truth: [`frontend/src/styles/theme.css`](../frontend/src/styles/theme.css) (CSS tokens via Tailwind v4 `@theme`) and [`frontend/src/design/tokens.ts`](../frontend/src/design/tokens.ts) (the same values for JS: charts, motion). **Never hard-code a hex value in a component.** Always use a token.

## 1. Brand

| Element | Rule |
|---|---|
| Product name | **OneInsure Connect** (always both words; never "OI Connect" in the UI) |
| Tagline | *Connect. Collaborate. Grow.* |
| Product mark | "Connect ring": an open **C** (connection) carrying a **play/video** glyph, with two cyan **nodes** at the ring ends (participants joining). Navy→electric-blue tile. Component: `<ConnectLogo />` |
| Lock-ups | `variant="full"` (mark + wordmark), `"mark"` (mark only: favicon, collapsed sidebar, mobile), `tone="light"\|"dark"` |
| Parent brand | Official OneInsure logo (`assets/logo/oneinsure/logo-white.png`, from oneinsure.com). Shown as "A OneInsure platform" on the login panel and the sidebar footer. Do not recolour, stretch or crop it. Minimum height 20 px |
| OneInsure orange | Part of the parent logo **only**. Not used in the Connect UI palette, to avoid clashing with the Warning colour |
| Favicon | `frontend/public/favicon.svg` (mark only) |

## 2. Colour

| Token | Hex | Use |
|---|---|---|
| `navy-900` | #102A43 | Sidebar, login brand panel, headings on light surfaces |
| `brand-700` (Enterprise Blue) | #1769AA | Primary button hover, links, active states |
| `brand-500` (Electric Blue) | #2878E5 | Primary actions, focus ring, charts series 1 |
| `cyan-400` (Cyan Accent) | #20C4D8 | Accents, live indicators, chart series 2. **Never** for body text on white (contrast) |
| `canvas` | #F4F7FB | App background |
| `surface` | #FFFFFF | Cards, modals |
| `ink` | #172B4D | Primary text (contrast 13.9:1 on white) |
| `ink-secondary` | #64748B | Secondary text (4.8:1 on white, AA) |
| `ink-muted` | #94A3B8 | Placeholders, disabled, meta only (not for essential info) |
| `line` | #E3E9F2 | Borders, dividers |
| `success` | #16A34A | Completed, connected |
| `warning` | #F59E0B | Pending, reconnecting |
| `danger` | #DC2626 | Errors, recording dot, leave meeting |
| `info` | #0284C7 | Informational |

Each status colour has a `-soft` tint (background) and is always paired with an icon or text, never colour alone.

**Gradients (only three):**
- `--gradient-brand`: navy-900 → brand-500 (login panel, logo tile, hero card)
- `--gradient-accent`: brand-500 → cyan-400 (primary CTA highlight, progress)
- `--gradient-canvas`: very light blue wash (page backgrounds behind auth cards)

**Meeting category colours** (calendar, chips): Internal `#2878E5`, Customer `#0EA5A4`, Training `#7C3AED`, Review `#F59E0B`, Management `#102A43`.

## 3. Typography

**Plus Jakarta Sans Variable** (OFL), self-hosted through `@fontsource-variable`. One family only. Tabular numerals (`tabular-nums`) for KPIs, tables and timers.

| Role | Size / line | Weight |
|---|---|---|
| Display (login hero only) | 40/48 (clamp 30–44) | 700 |
| Page title | 24/32 | 700 |
| Section title | 18/26 | 650 |
| Card heading | 15/22 | 600 |
| Body | 14/22 | 450 |
| Label | 13/18 | 550 |
| Caption / meta | 12/16 | 500 |

Minimum text size is 12 px. Avoid all-caps except for the 11 px tracking-wide "eyebrow" labels.

## 4. Spacing, radius, elevation

- Spacing: 4-pt scale (4, 8, 12, 16, 20, 24, 32, 40, 48). Card padding 20/24, page gutter 24 (16 on mobile).
- Radius: `sm` 8 (inputs, chips), `md` 10 (buttons), `lg` 14 (cards), `xl` 20 (modals, login card), `full` (avatars, pills).
- Shadows: `card` (1 px border + very soft 1–3 px), `raised` (hover), `overlay` (menus/modals). No coloured glows except the primary-button focus ring.
- Breakpoints: `sm` 640, `md` 768, `lg` 1024, `xl` 1280, `2xl` 1536. The sidebar becomes a drawer below `lg`.

## 5. Motion

| Token | Value | Use |
|---|---|---|
| `fast` | 150 ms | hover, press, toggles |
| `base` | 220 ms | dropdowns, tabs, sidebar |
| `slow` | 400 ms | page/card entrance, modals |
| `ease-out` | cubic-bezier(0.22, 1, 0.36, 1) | entrances |
| `ease-in-out` | cubic-bezier(0.65, 0, 0.35, 1) | position changes |

Rules: animate only `transform` and `opacity`. Stagger card entrances by 40 ms (max 8 items). Ambient login animations run at ≥ 12 s cycles. **`prefers-reduced-motion: reduce` disables all ambient and entrance animations** (global CSS rule + Motion's `MotionConfig reducedMotion="user"`). Inside meetings, only state feedback (mic/camera/recording/reconnecting) animates. No decorative motion there.

## 6. Components (inventory)

Built in Phase 1 (prototype): Button, IconButton, TextField, PasswordField, Checkbox, Alert, Card, StatCard (counter), Badge/StatusBadge, Avatar, Skeleton, EmptyState, ErrorState, ConnectLogo, OneInsureLogo, AuthLayout, AppLayout (Sidebar + Header), NetworkIllustration, charts.

Phase 2+: Select/Combobox, DatePicker, TimePicker, Table (TanStack), Pagination, Tabs, Breadcrumbs, Modal, Drawer, Toast, SearchField, MeetingCard, CalendarEvent, VideoControlBar, ParticipantTile, NetworkQualityIndicator, RecordingIndicator.

## 7. Accessibility

WCAG 2.1 AA target. Visible 3 px focus ring (`brand-500` at 35 % alpha). Every icon-only control has an `aria-label` and a tooltip. Form errors are linked with `aria-describedby`. Toasts use `role="status"`. Hit targets are at least 40 px (44 px for meeting controls).

## 8. Dark theme

Optional enhancement for a later phase. Tokens are already named semantically (`surface`, `ink`, `line`), so a dark theme only remaps variables.
