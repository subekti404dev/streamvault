<script lang="ts">
  import { api } from '../lib/api';
  import { onMount } from 'svelte';
  import type { SearchResult, Torrent, StremioMetaItem } from '../lib/types';
  import { formatBytes } from '../lib/types';

  let { addToast }: { addToast: (msg: string, type?: string) => void } = $props();

  let query = $state('');
  let imdbId = $state('');
  let mediaType = $state('movie');
  let season = $state(1);
  let episode = $state(1);
  let loading = $state(false);
  let result = $state<SearchResult | null>(null);
  let error = $state('');
  let catalogResults = $state<StremioMetaItem[]>([]);
  let selectedItem = $state<StremioMetaItem | null>(null);
  let showImdbSearch = $state(false);
  let metadataBaseUrl = $state('');

  onMount(async () => {
    try {
      const settings = await api.getSettings();
      metadataBaseUrl = settings['stremio_metadata_url'] || 'https://aiometadatafortheweebs.midnightignite.me/stremio/43031d18-5fb4-40dc-9d73-cce34062e999';
    } catch (e) {
      metadataBaseUrl = 'https://aiometadatafortheweebs.midnightignite.me/stremio/43031d18-5fb4-40dc-9d73-cce34062e999';
    }
  });

  async function handleQuerySearch() {
    if (!query.trim()) return;
    loading = true;
    error = '';
    catalogResults = [];
    selectedItem = null;
    result = null;
    try {
      const response = await api.searchCatalog(query.trim(), metadataBaseUrl);
      catalogResults = response.metas;
      if (catalogResults.length === 0) {
        error = 'No results found';
      }
    } catch (e: any) {
      error = e.message || 'Search failed';
    } finally {
      loading = false;
    }
  }

  async function selectItem(item: StremioMetaItem) {
    selectedItem = item;
    result = null;
    error = '';
    
    let resolvedImdbId = item.id;
    let resolvedType = item.type;
    
    if (item.type === 'series' && !item.id.startsWith('tt')) {
      try {
        loading = true;
        const metaResponse = await api.getStremioMeta(item.type, item.id, metadataBaseUrl);
        resolvedImdbId = metaResponse.meta.imdb_id || item.id;
      } catch (e: any) {
        error = `Failed to fetch metadata: ${e.message}`;
        loading = false;
        return;
      }
    }
    
    imdbId = resolvedImdbId;
    mediaType = resolvedType;
    
    if (resolvedType === 'movie') {
      await handleImdbSearch();
    }
    loading = false;
  }

  async function handleImdbSearch() {
    if (!imdbId.trim()) return;
    loading = true;
    error = '';
    result = null;
    try {
      result = await api.search(
        imdbId.trim(),
        mediaType,
        mediaType === 'series' ? season : undefined,
        mediaType === 'series' ? episode : undefined,
      );
    } catch (e: any) {
      error = e.message || 'Search failed';
    } finally {
      loading = false;
    }
  }

  async function addToQueue(torrent: Torrent) {
    try {
      const res = await api.addToQueue({
        imdb_id: imdbId.trim(),
        media_type: mediaType,
        season: mediaType === 'series' ? season : null,
        episode: mediaType === 'series' ? episode : null,
        title: result?.meta.title || selectedItem?.name,
        poster_url: result?.meta.poster || selectedItem?.poster,
        magnet_uri: torrent.magnet_uri,
        infohash: torrent.infohash,
        torrent_name: torrent.filename || torrent.title,
        file_idx: torrent.file_idx,
        file_size_bytes: torrent.size_bytes,
      });
      addToast(`Added to queue: ${result?.meta.title || selectedItem?.name}`, 'success');
    } catch (e: any) {
      addToast(`Failed: ${e.message}`, 'error');
    }
  }
</script>

<div class="page">
  <h1 class="page-title">Search</h1>
  <p class="page-subtitle">Search for movies and series by title or IMDB ID</p>

  <div class="glass-card search-form">
    <div class="form-group">
      <label for="query">Search by Title</label>
      <input
        id="query"
        type="text"
        bind:value={query}
        placeholder="e.g. Big Buck Bunny"
        onkeydown={(e) => e.key === 'Enter' && handleQuerySearch()}
      />
    </div>
    <button class="btn btn-primary" onclick={handleQuerySearch} disabled={loading || !query.trim()}>
      {loading ? 'Searching...' : 'Search'}
    </button>
    
    <div class="advanced-toggle">
      <button class="btn-link" onclick={() => showImdbSearch = !showImdbSearch}>
        {showImdbSearch ? 'Hide' : 'Show'} IMDB ID Search
      </button>
    </div>

    {#if showImdbSearch}
      <div class="imdb-search">
        <div class="grid-2">
          <div class="form-group">
            <label for="imdb">IMDB ID</label>
            <input
              id="imdb"
              type="text"
              bind:value={imdbId}
              placeholder="e.g. tt0903747"
              onkeydown={(e) => e.key === 'Enter' && handleImdbSearch()}
            />
          </div>
          <div class="form-group">
            <label for="type">Media Type</label>
            <select id="type" bind:value={mediaType}>
              <option value="movie">Movie</option>
              <option value="series">Series</option>
            </select>
          </div>
        </div>

        {#if mediaType === 'series'}
          <div class="grid-2">
            <div class="form-group">
              <label for="season">Season</label>
              <input id="season" type="number" bind:value={season} min="1" />
            </div>
            <div class="form-group">
              <label for="episode">Episode</label>
              <input id="episode" type="number" bind:value={episode} min="1" />
            </div>
          </div>
        {/if}

        <button class="btn btn-primary" onclick={handleImdbSearch} disabled={loading || !imdbId.trim()}>
          {loading ? 'Searching...' : 'Search by IMDB ID'}
        </button>
      </div>
    {/if}
  </div>

  {#if error}
    <div class="glass-card" style="margin-top:1rem; border-color: rgba(239,68,68,0.3);">
      <p style="color:var(--danger)">{error}</p>
    </div>
  {/if}

  {#if catalogResults.length > 0 && !selectedItem}
    <h3 style="margin-top:1.5rem; margin-bottom:0.75rem; color:var(--text-secondary)">
      {catalogResults.length} result(s)
    </h3>
    <div class="results-grid">
      {#each catalogResults as item}
        <button class="glass-card result-card" onclick={() => selectItem(item)}>
          {#if item.poster}
            <img src={item.poster} alt={item.name} class="result-poster" />
          {:else}
            <div class="result-poster-placeholder"></div>
          {/if}
          <div class="result-info">
            <span class="result-title">{item.name}</span>
            <div class="result-meta">
              {#if item.year}
                <span class="badge" style="background:rgba(99,102,241,0.2);color:var(--accent)">
                  {item.year}
                </span>
              {/if}
              <span class="badge" style="background:rgba(139,92,246,0.2);color:#a78bfa">
                {item.type}
              </span>
            </div>
          </div>
        </button>
      {/each}
    </div>
  {/if}

  {#if selectedItem && !result}
    <div class="glass-card meta-card">
      <div class="meta-content">
        {#if selectedItem.poster}
          <img src={selectedItem.poster} alt={selectedItem.name} class="poster" />
        {/if}
        <div>
          <h2>{selectedItem.name}</h2>
          {#if selectedItem.year}
            <span class="badge" style="background:rgba(99,102,241,0.2);color:var(--accent)">
              {selectedItem.year}
            </span>
          {/if}
          <span class="badge" style="background:rgba(139,92,246,0.2);color:#a78bfa;margin-left:0.5rem">
            {selectedItem.type}
          </span>
        </div>
      </div>
    </div>

    {#if selectedItem.type === 'series'}
      <div class="glass-card" style="margin-top:1rem; padding:1.5rem;">
        <div class="grid-2">
          <div class="form-group">
            <label for="season">Season</label>
            <input id="season" type="number" bind:value={season} min="1" />
          </div>
          <div class="form-group">
            <label for="episode">Episode</label>
            <input id="episode" type="number" bind:value={episode} min="1" />
          </div>
        </div>
        <button class="btn btn-primary" onclick={handleImdbSearch} disabled={loading}>
          {loading ? 'Searching...' : 'Search Torrents'}
        </button>
      </div>
    {/if}
  {/if}

  {#if result}
    <div class="glass-card meta-card">
      <div class="meta-content">
        {#if result.meta.poster}
          <img src={result.meta.poster} alt={result.meta.title} class="poster" />
        {/if}
        <div>
          <h2>{result.meta.title}</h2>
          {#if result.meta.year}
            <span class="badge" style="background:rgba(99,102,241,0.2);color:var(--accent)">
              {result.meta.year}
            </span>
          {/if}
        </div>
      </div>
    </div>

    {#if result.torrents.length === 0}
      <div class="glass-card" style="margin-top:1rem">
        <p class="text-muted">No torrents found for this title.</p>
      </div>
    {:else}
      <h3 style="margin-top:1.5rem; margin-bottom:0.75rem; color:var(--text-secondary)">
        {result.torrents.length} torrent source(s)
      </h3>
      <div class="torrent-list">
        {#each result.torrents as torrent}
          <div class="glass-card torrent-item">
            <div class="torrent-info">
              <span class="torrent-name">{torrent.name}</span>
              <span class="torrent-title">{torrent.title}</span>
              <span class="torrent-size">{formatBytes(torrent.size_bytes)}</span>
            </div>
            <button class="btn btn-primary btn-sm" onclick={() => addToQueue(torrent)}>
              Add to Queue
            </button>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .page {
    max-width: 800px;
    margin: 0 auto;
  }

  .page-title {
    font-size: 1.5rem;
    margin-bottom: 0.25rem;
  }

  .page-subtitle {
    color: var(--text-secondary);
    font-size: 0.875rem;
    margin-bottom: 1.5rem;
  }

  .search-form {
    padding: 1.5rem;
  }

  .advanced-toggle {
    margin-top: 1rem;
    text-align: center;
  }

  .btn-link {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-size: 0.85rem;
    padding: 0.5rem;
    transition: color 0.15s ease;
  }

  .btn-link:hover {
    color: var(--accent-hover);
  }

  .imdb-search {
    margin-top: 1.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--glass-border);
  }

  .meta-card {
    margin-top: 1rem;
    padding: 1.5rem;
  }

  .meta-content {
    display: flex;
    gap: 1rem;
    align-items: center;
  }

  .poster {
    width: 80px;
    height: 120px;
    object-fit: cover;
    border-radius: var(--radius-sm);
  }

  .meta-content h2 {
    font-size: 1.25rem;
  }

  .results-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 1rem;
    margin-top: 1rem;
  }

  .result-card {
    padding: 0;
    cursor: pointer;
    transition: all 0.2s ease;
    overflow: hidden;
  }

  .result-card:hover {
    transform: translateY(-4px);
    border-color: var(--accent);
  }

  .result-poster {
    width: 100%;
    aspect-ratio: 2/3;
    object-fit: cover;
    display: block;
  }

  .result-poster-placeholder {
    width: 100%;
    aspect-ratio: 2/3;
    background: rgba(255, 255, 255, 0.05);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .result-info {
    padding: 0.75rem;
  }

  .result-title {
    display: block;
    font-weight: 600;
    font-size: 0.875rem;
    margin-bottom: 0.5rem;
    line-height: 1.3;
  }

  .result-meta {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .torrent-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .torrent-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.875rem 1.25rem;
  }

  .torrent-info {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .torrent-name {
    font-weight: 600;
    font-size: 0.875rem;
  }

  .torrent-title {
    color: var(--text-secondary);
    font-size: 0.8rem;
  }

  .torrent-size {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .btn-sm {
    padding: 0.35rem 0.75rem;
    font-size: 0.8rem;
    white-space: nowrap;
  }

  .text-muted { color: var(--text-muted); }

  @media (max-width: 768px) {
    .results-grid {
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    }
  }
</style>
