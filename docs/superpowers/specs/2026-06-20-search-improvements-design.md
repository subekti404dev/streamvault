# Search Page Improvements Design

> **Goal:** Perbaiki UX halaman Search — pisahkan hasil pencarian berdasarkan type (movie/series), dan ganti input season/episode manual dengan dropdown picker.

> **Architecture:** Frontend-only changes. Group `catalogResults` by `type` into separate sections. Fetch `StremioMetaDetail.videos` saat pilih series, extract unique seasons → episodes untuk dropdown cascading.

> **Tech Stack:** Svelte 5, existing Stremio API

---

## Feature 1: Search Results Grouping

### Current Behavior
Semua `catalogResults` (movie + series) ditampilkan dalam satu flat grid.

### New Behavior
Hasil dipisah menjadi dua section:
```
┌─────────────────────────────────────┐
│ Movies (5)                          │
│ ┌─────┐ ┌─────┐ ┌─────┐            │
│ │ 🎬  │ │ 🎬  │ │ 🎬  │            │
│ └─────┘ └─────┘ └─────┘            │
├─────────────────────────────────────┤
│ Series (3)                          │
│ ┌─────┐ ┌─────┐ ┌─────┐            │
│ │ 📺  │ │ 📺  │ │ 📺  │            │
│ └─────┘ └─────┘ └─────┘            │
└─────────────────────────────────────┘
```

### Implementation
```typescript
// Derived groups
const movieResults = $derived(
  catalogResults.filter(item => item.type === 'movie')
);
const seriesResults = $derived(
  catalogResults.filter(item => item.type === 'series')
);
```

Jika salah satu kosong, section-nya tidak ditampilkan.

---

## Feature 2: Season/Episode Dropdown Picker

### Current Behavior
User harus input season dan episode secara manual (number input).

### New Behavior
Dropdown cascading:
1. User pilih series → fetch `StremioMetaDetail` (sudah dilakukan di `selectItem`)
2. Extract unique seasons dari `meta.videos`
3. Pilih season → show episodes untuk season tersebut
4. Pilih episode → set value

```
┌─────────────────────────────────────┐
│ Breaking Bad (2008)  [series]       │
├─────────────────────────────────────┤
│ Season: [Season 1 ▾]                │
│ Episode: [S01E01 - Pilot ▾]         │
│                                     │
│ [Search Torrents]                   │
└─────────────────────────────────────┘
```

### Data Flow
```
selectItem(item)
  → getStremioMeta(item.type, item.id)
  → meta.videos = [{ season: 1, episode: 1, title: "Pilot" }, ...]
  → extract unique seasons = [1, 2, 3, 4, 5]
  → season 1 selected → episodes = videos.filter(v => v.season === 1)
  → episode selected → season/episode state updated
```

### State Changes
```typescript
let season = $state(1);
let episode = $state(1);
let seriesMeta = $state<StremioMetaDetail | null>(null); // NEW
let availableSeasons = $derived(/* unique seasons from seriesMeta.videos */);
let availableEpisodes = $derived(/* episodes for selected season */);
```

### UI Behavior
- Dropdown season: `Season 1`, `Season 2`, ...
- Dropdown episode: `S01E01 - Pilot`, `S01E02 - Cat's in the Bag...`, ...
- Season change → reset episode ke 1
- Jika `seriesMeta.videos` kosong/kosong, fallback ke number input

---

## File Structure

### Modified Files
- `dashboard/src/pages/SearchPage.svelte` — grouping + picker
- `dashboard/src/lib/types.ts` — no changes needed (types sudah ada)

### No Backend Changes
Semua data sudah tersedia dari Stremio API.

---

## Implementation Tasks

### Task 1: Search Results Grouping

**Files:**
- Modify: `dashboard/src/pages/SearchPage.svelte`

### Task 2: Season/Episode Picker

**Files:**
- Modify: `dashboard/src/pages/SearchPage.svelte`

### Task 3: Wire Picker to Search

**Files:**
- Modify: `dashboard/src/pages/SearchPage.svelte`

---

## Implementation Plan

### Task 1: Search Results Grouping

**Files:**
- Modify: `dashboard/src/pages/SearchPage.svelte`

- [ ] **Step 1: Add derived groups**

```typescript
// Add after selectedItem declaration (around line 19)

const movieResults = $derived(
  catalogResults.filter(item => item.type === 'movie')
);
const seriesResults = $derived(
  catalogResults.filter(item => item.type === 'series')
);
```

- [ ] **Step 2: Update template to show grouped results**

Replace the single grid (lines 268-291) with two sections:

```svelte
{#if catalogResults.length > 0 && !selectedItem}
  {#if movieResults.length > 0}
    <h3 class="mt-6 mb-3 text-secondary">
      Movies ({movieResults.length})
    </h3>
    <div class="results-grid">
      {#each movieResults as item}
        <button class="result-card" onclick={() => selectItem(item)}>
          {#if item.poster}
            <img src={item.poster} alt={item.name} class="result-poster" />
          {:else}
            <div class="result-poster-placeholder"></div>
          {/if}
          <div class="result-info">
            <span class="result-title">{item.name}</span>
            <div class="result-meta">
              {#if item.year}
                <span class="badge">{item.year}</span>
              {/if}
            </div>
          </div>
        </button>
      {/each}
    </div>
  {/if}

  {#if seriesResults.length > 0}
    <h3 class="mt-6 mb-3 text-secondary">
      Series ({seriesResults.length})
    </h3>
    <div class="results-grid">
      {#each seriesResults as item}
        <button class="result-card" onclick={() => selectItem(item)}>
          {#if item.poster}
            <img src={item.poster} alt={item.name} class="result-poster" />
          {:else}
            <div class="result-poster-placeholder"></div>
          {/if}
          <div class="result-info">
            <span class="result-title">{item.name}</span>
            <div class="result-meta">
              {#if item.year}
                <span class="badge">{item.year}</span>
              {/if}
            </div>
          </div>
        </button>
      {/each}
    </div>
  {/if}
{/if}
```

- [ ] **Step 3: Commit**

```bash
cd dashboard && git add src/pages/SearchPage.svelte && git commit -m "feat: group search results by movie/series"
```

---

### Task 2: Season/Episode Picker

**Files:**
- Modify: `dashboard/src/pages/SearchPage.svelte`

- [ ] **Step 1: Add state for series metadata**

```typescript
// Add after episode declaration (around line 14)

let seriesMeta = $state<StremioMetaDetail | null>(null);
```

- [ ] **Step 2: Add derived for available seasons/episodes**

```typescript
// Add after movieResults/seriesResults

const availableSeasons = $derived(() => {
  if (!seriesMeta?.videos) return [];
  const seasons = [...new Set(seriesMeta.videos
    .map(v => v.season)
    .filter((s): s is number => s != null)
  )].sort((a, b) => a - b);
  return seasons;
});

const availableEpisodes = $derived(() => {
  if (!seriesMeta?.videos) return [];
  return seriesMeta.videos
    .filter(v => v.season === season)
    .sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
});
```

- [ ] **Step 3: Update selectItem to store seriesMeta**

```typescript
// In selectItem function, after line 81

seriesMeta = resolvedType === 'series' ? metaResponse?.meta ?? null : null;
```

Wait, need to refactor selectItem to fetch meta for series:

```typescript
async function selectItem(item: StremioMetaItem) {
  selectedItem = item;
  result = null;
  error = '';
  seriesMeta = null;
  
  let resolvedImdbId = item.id;
  let resolvedType = item.type;
  
  if (item.type === 'series') {
    try {
      loading = true;
      const metaResponse = await api.getStremioMeta(item.type, item.id, metadataBaseUrl);
      resolvedImdbId = metaResponse.meta.imdb_id || item.id;
      seriesMeta = metaResponse.meta;
    } catch (e: any) {
      error = `Failed to fetch metadata: ${e.message}`;
      loading = false;
      return;
    }
  }
  
  imdbId = resolvedImdbId;
  mediaType = resolvedType;
  season = 1;
  episode = 1;
  
  if (resolvedType === 'movie') {
    await handleImdbSearch();
  }
  loading = false;
}
```

- [ ] **Step 4: Add season change handler**

```typescript
function handleSeasonChange(newSeason: number) {
  season = newSeason;
  episode = 1; // reset to first episode
}
```

- [ ] **Step 5: Update template for series picker**

Replace lines 310-326 with:

```svelte
{#if selectedItem.type === 'series'}
  <div class="season-episode-card">
    {#if availableSeasons().length > 0}
      <div class="grid-2">
        <div class="form-group">
          <label for="selected-season">Season</label>
          <select
            id="selected-season"
            value={season}
            onchange={(e) => handleSeasonChange(Number(e.currentTarget.value))}
          >
            {#each availableSeasons() as s}
              <option value={s}>Season {s}</option>
            {/each}
          </select>
        </div>
        <div class="form-group">
          <label for="selected-episode">Episode</label>
          <select
            id="selected-episode"
            value={episode}
            onchange={(e) => episode = Number(e.currentTarget.value)}
          >
            {#each availableEpisodes() as ep}
              <option value={ep.episode ?? 1}>
                S{String(season).padStart(2, '0')}E{String(ep.episode ?? 0).padStart(2, '0')} - {ep.title}
              </option>
            {/each}
          </select>
        </div>
      </div>
    {:else}
      <!-- Fallback: number inputs -->
      <div class="grid-2">
        <div class="form-group">
          <label for="selected-season">Season</label>
          <input id="selected-season" type="number" bind:value={season} min="1" />
        </div>
        <div class="form-group">
          <label for="selected-episode">Episode</label>
          <input id="selected-episode" type="number" bind:value={episode} min="1" />
        </div>
      </div>
    {/if}
    <button class="btn btn-primary" onclick={handleImdbSearch} disabled={loading}>
      {loading ? 'Searching...' : 'Search Torrents'}
    </button>
  </div>
{/if}
```

- [ ] **Step 6: Update IMDB search section for series (lines 241-252)**

Same pattern — use dropdown when seriesMeta available, fallback to input:

```svelte
{#if mediaType === 'series'}
  <div class="grid-2">
    <div class="form-group">
      <label for="season">Season</label>
      {#if availableSeasons().length > 0}
        <select
          id="season"
          value={season}
          onchange={(e) => handleSeasonChange(Number(e.currentTarget.value))}
        >
          {#each availableSeasons() as s}
            <option value={s}>Season {s}</option>
          {/each}
        </select>
      {:else}
        <input id="season" type="number" bind:value={season} min="1" />
      {/if}
    </div>
    <div class="form-group">
      <label for="episode">Episode</label>
      {#if availableEpisodes().length > 0}
        <select
          id="episode"
          value={episode}
          onchange={(e) => episode = Number(e.currentTarget.value)}
        >
          {#each availableEpisodes() as ep}
            <option value={ep.episode ?? 1}>
              E{String(ep.episode ?? 0).padStart(2, '0')} - {ep.title}
            </option>
          {/each}
        </select>
      {:else}
        <input id="episode" type="number" bind:value={episode} min="1" />
      {/if}
    </div>
  </div>
{/if}
```

- [ ] **Step 7: Commit**

```bash
cd dashboard && git add src/pages/SearchPage.svelte && git commit -m "feat: add season/episode dropdown picker for series"
```

---

### Task 3: Smoke Test

- [ ] **Step 1: Build**

Run: `cd dashboard && npm run build`
Expected: No errors

- [ ] **Step 2: Manual test**

1. Search "Breaking Bad" → results split into Movies and Series sections
2. Click series → season/episode dropdowns appear
3. Change season → episodes update
4. Select episode → search works correctly
5. Search movie → works as before
6. IMDB ID search with series → dropdowns work

---

## Summary

| Task | Description | Est. Time |
|------|-------------|-----------|
| 1 | Search results grouping | 10 min |
| 2 | Season/episode picker | 20 min |
| 3 | Smoke test | 5 min |
| **Total** | | **~35 min** |
