# Button Audit — Design System Consistency

## Design System Baseline (`app.css`)

| Class | Properties |
|-------|-----------|
| `.btn` | `display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.6rem 1.25rem; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 0.875rem; font-weight: 600; font-family: 'JetBrains Mono', monospace; cursor: pointer; transition: all 0.15s ease; background: var(--surface); color: var(--text-primary); line-height: 1;` |
| `.btn:hover` | `border-color: var(--accent); background: var(--glass-hover);` |
| `.btn:active` | `transform: scale(0.98);` |
| `.btn:focus-visible` | `outline: 2px solid var(--accent); outline-offset: 2px;` |
| `.btn-primary` | `background: var(--accent); border-color: var(--accent); color: #000000;` |
| `.btn-danger` | `border-color: var(--danger); color: var(--danger);` |
| `.btn-success` | `border-color: var(--success); color: var(--success);` |
| `.btn-secondary` | `background: var(--bg-secondary); border-color: var(--border); color: var(--text-secondary);` |
| `.btn-sm` | `padding: 0.35rem 0.75rem; font-size: 0.8rem;` |
| `.btn-xs` | `padding: 0.2rem 0.5rem; font-size: 0.7rem;` |

---

## Per-File Inventory

### App.svelte

| Button | Classes | Design System? | Notes |
|--------|---------|---------------|-------|
| Connect (login) | `btn btn-primary` + inline style | ✅ | Full-width intentional for login form |
| Hamburger | `.hamburger` | — | Custom nav control, non-btn (fine) |
| Logout (header) | `btn btn-sm` | ✅ | Neutral variant |
| Logout (drawer) | `btn btn-sm` | ✅ | Same |
| Drawer close | `.drawer-close` | — | Custom SVG button (fine) |

### SearchPage.svelte

| Button | Classes | Design System? | Notes |
|--------|---------|---------------|-------|
| Cari (search) | `btn btn-primary` | ✅ | |
| Show/Hide IMDB toggle | `.btn-link` (scoped) | — | Text toggle, non-action pattern (acceptable) |
| Search by IMDB ID | `btn btn-primary` | ✅ | |
| Tab: Movie | `.tab-btn` | — | Tab underline pattern, non-btn (intentional) |
| Tab: Series | `.tab-btn` | — | Same |
| Result card | `.result-card` | — | Full `<button>` card, non-btn (intentional) |
| Search Torrents | `btn btn-primary` | ✅ | |
| Source tab: Torrentio | `.tab-btn` | — | Same tab pattern |
| Source tab: Custom | `.tab-btn` | — | Same |
| Files (torrent) | `btn btn-secondary btn-sm` | ✅ | |
| Add to Queue (torrent) | `btn btn-primary btn-sm` | ✅ | |
| File option (torrent) | `.file-option` | — | Toggle-style selector (fine) |
| Inspect Files (custom) | `btn btn-secondary` | ✅ | |
| Add to Queue (custom) | `btn btn-primary` | ✅ | |
| File option (custom) | `.file-option` | — | Same |

### QueuePage.svelte

| Button | Classes | Design System? | Notes |
|--------|---------|---------------|-------|
| Details (link) | `btn btn-sm` (on `<a>`) | ✅ | `<a>` not `<button>`, but visually consistent |
| Cancel (processing) | `btn btn-sm btn-danger` | ✅ | |
| Cancel (queued) | `btn btn-danger btn-sm` | ✅ | |
| Retry (failed) | `btn btn-success btn-sm` | ✅ | |
| Remove (failed) | `btn btn-danger btn-sm` | ✅ | |

### JobDetailPage.svelte

| Button | Classes | Design System? | Notes |
|--------|---------|---------------|-------|
| Copy HLS URL | `btn btn-sm btn-primary` | ✅ | |
| **Resume** | `btn btn-success mt-2` | ⚠️ **Missing `btn-sm`** | All other action buttons use `btn-sm` |
| **Remove** | `btn btn-danger ml-2` | ⚠️ **Missing `btn-sm`** | Same — should be `btn btn-danger btn-sm ml-2` |

### LibraryPage.svelte

| Button | Classes | Design System? | Notes |
|--------|---------|---------------|-------|
| Tab: Movie | `.tab-btn` | — | Tab underline pattern (intentional) |
| Tab: Series | `.tab-btn` | — | Same |
| Prev / Next | `btn btn-sm` | ✅ | Neutral variant |

### LibraryDetailPage.svelte

| Button | Classes | Design System? | Notes |
|--------|---------|---------------|-------|
| Movie stream header | `.season-header` | — | Collapsible header (intentional) |
| ▶ Play (movie) | `btn btn-xs btn-primary` (on `<a>`) | ✅ | |
| ✗ Delete (movie) | `btn btn-xs btn-danger` | ✅ | |
| Season header | `.season-header` | — | Same collapsible pattern |
| Episode row | `.episode-row` | — | Clickable row (intentional) |
| 🔍 Search | `btn btn-xs` | ✅ | Neutral variant, matches size pattern |
| ▶ Play (episode) | `btn btn-xs btn-primary` (on `<a>`) | ✅ | |
| ✗ Delete (episode) | `btn btn-xs btn-danger` | ✅ | |

### SettingsPage.svelte

| Button | Classes | Design System? | Notes |
|--------|---------|---------------|-------|
| Save Settings | `btn btn-primary` | ✅ | |
| Test Telegram | `btn` | ✅ | Neutral variant |
| Export Data | `btn btn-primary` | ✅ | |
| Import Data | `btn btn-danger` | ✅ | |

---

## Summary (Non-Btn Elements)

Custom elements that intentionally do NOT use `.btn` classes (all correct):

- `.hamburger`, `.drawer-close` — nav controls
- `.tab-btn` — tab underline pattern (SearchPage, LibraryPage)
- `.result-card` — full-card clickable result
- `.file-option` — toggle file selector
- `.btn-link` — text toggle (SearchPage)
- `.season-header`, `.episode-row` — collapsible library sections

---

## Findings to Fix

Only **2** buttons deviate from the design system:

| # | File | Line | Button | Current | Should Be |
|---|------|------|--------|---------|-----------|
| 1 | `JobDetailPage.svelte` | 180 | Resume | `btn btn-success mt-2` | `btn btn-success btn-sm mt-2` |
| 2 | `JobDetailPage.svelte` | 183 | Remove | `btn btn-danger ml-2` | `btn btn-danger btn-sm ml-2` |

Everything else is already consistent.
