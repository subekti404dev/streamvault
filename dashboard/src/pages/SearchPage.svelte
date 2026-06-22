<script lang="ts">
  import { api } from '../lib/api';
  import { onMount } from 'svelte';
  import type { SearchResult, Torrent, StremioMetaItem, StremioMetaDetail } from '../lib/types';
  import { formatBytes } from '../lib/types';

const DEFAULT_METADATA_URL = 'https://aiometadatafortheweebs.midnightignite.me/stremio/43031d18-5fb4-40dc-9d73-cce34062e999';
  let { addToast, routeParams }: { addToast: (msg: string, type?: string) => void; routeParams?: Record<string, string> } = $props();

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
  let customMagnet = $state('');
  let customTitle = $state('');
  let customAdding = $state(false);
  let sourceTab = $state<'torrentio' | 'custom'>('torrentio');
  let searchTab = $state<'movie' | 'series'>('movie');
  let inspecting = $state(false);
  let inspectedFiles = $state<{index: number; name: string; size_bytes: number}[]>([]);
  let selectedFileIdx = $state(0);
  let torrentName = $state('');
  let seriesMeta = $state<StremioMetaDetail | null>(null);
  const movieResults = $derived(
    catalogResults.filter(item => item.type === 'movie')
  );
  const seriesResults = $derived(
    catalogResults.filter(item => item.type === 'series')
  );

  // View stack for back navigation
  function pushView() {
    history.pushState(null, '');
  }

  // popstate: back through sub-views
  $effect(() => {
    const onPop = () => {
      if (result) {
        result = null;
      } else if (selectedItem) {
        selectedItem = null;
        seriesMeta = null;
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  });

  onMount(async () => {
    // Pre-fill parameters from route (e.g., routed from library-detail)
    if (routeParams?.imdb_id) {
      imdbId = routeParams.imdb_id;
    }
    if (routeParams?.type) {
      mediaType = routeParams.type;
    }
    if (routeParams?.season) {
      season = parseInt(routeParams.season, 10) || 1;
    }
    if (routeParams?.episode) {
      episode = parseInt(routeParams.episode, 10) || 1;
    }

    // Load settings for metadata URL
    try {
      const settings = await api.getSettings();
      metadataBaseUrl = settings['stremio_metadata_url'] || DEFAULT_METADATA_URL;
    } catch {
      metadataBaseUrl = DEFAULT_METADATA_URL;
    }

    // Auto-search if pre-filled
    if (routeParams?.imdb_id) {
      await handleImdbSearch();
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
    pushView();
    selectedItem = item;
    loading = true;
    result = null;
    try {
      const response = await api.getTorrents(item.type, item.id, metadataBaseUrl);
      result = {
        meta: { ...item, title: item.name },
        torrents: response.torrents,
      };
      if (item.type === 'series') {
        try {
          seriesMeta = await api.getStremioMetaDetail('series', item.id, metadataBaseUrl);
        } catch {
          seriesMeta = null;
        }
      } else {
        seriesMeta = null;
      }
    } catch (e: any) {
      error = e.message || 'Failed to load torrents';
    } finally {
      loading = false;
    }
  }

  async function handleImdbSearch() {
    if (!imdbId.trim()) return;
    loading = true;
    error = '';
    result = null;
    catalogResults = [];
    selectedItem = null;
    try {
      const response = await api.getTorrents(mediaType, imdbId.trim(), metadataBaseUrl);
      const metaResponse = await api.getStremioMeta(mediaType, imdbId.trim(), metadataBaseUrl);
      result = {
        meta: metaResponse.meta,
        torrents: response.torrents,
      };
      if (mediaType === 'series' && result.torrents.length > 0) {
        result.torrents = result.torrents.filter(t => t.season === season && t.episode === episode);
      }
    } catch (e: any) {
      error = `Failed: ${e.message}`;
    } finally {
      loading = false;
    }
  }

  function parseMagnet(uri: string): { infohash: string; name: string } {
    const ihMatch = uri.match(/btih:([a-fA-F0-9]{40})/);
    const dnMatch = uri.match(/dn=([^&]+)/);
    const infohash = ihMatch ? ihMatch[1] : '';
    const name = dnMatch ? decodeURIComponent(dnMatch[1].replace(/\+/g, ' ')) : '';
    return { infohash, name };
  }

  function handleMagnetInput() {
    const parsed = parseMagnet(customMagnet);
    if (!customTitle && parsed.name) {
      customTitle = parsed.name;
    }
  }

  async function inspectMagnet() {
    const parsed = parseMagnet(customMagnet);
    if (!parsed.infohash) {
      addToast('Invalid magnet URI', 'error');
      return;
    }
    inspecting = true;
    inspectedFiles = [];
    selectedFileIdx = 0;
    try {
      const resp = await api.inspectTorrent(parsed.infohash);
      inspectedFiles = resp.files;
      torrentName = resp.name;
      if (!customTitle) customTitle = resp.name;
    } catch (e: any) {
      addToast(`Inspect failed: ${e.message}`, 'error');
    } finally {
      inspecting = false;
    }
  }

  async function addCustomToQueue() {
    const parsed = parseMagnet(customMagnet);
    if (!parsed.infohash) {
      addToast('Invalid magnet URI', 'error');
      return;
    }
    customAdding = true;
    try {
      const title = customTitle.trim() || result?.meta.title || selectedItem?.name || parsed.name || `Custom (${parsed.infohash.slice(0, 8)})`;
      await api.addToQueue({
        imdb_id: imdbId.trim() || 'custom',
        media_type: mediaType,
        season: mediaType === 'series' ? season : null,
        episode: mediaType === 'series' ? episode : null,
        title: title,
        poster_url: result?.meta.poster || selectedItem?.poster || null,
        magnet_uri: customMagnet.trim(),
        infohash: parsed.infohash,
        torrent_name: title,
        file_idx: selectedFileIdx,
        file_size_bytes: inspectedFiles[selectedFileIdx]?.size_bytes || 0,
      });
      addToast(`Added to queue: ${title}`, 'success');
      customMagnet = '';
      inspectedFiles = [];
      selectedFileIdx = 0;
    } catch (e: any) {
      addToast(`Failed: ${e.message}`, 'error');
    } finally {
      customAdding = false;
    }
  }
</script>

<div class="page">
  <h1 class="page-title">Search</h1>
  <p class="page-subtitle">Search for movies and series by title or IMDB ID</p>

  <div class="search-form">
    <div class="search-bar">
      <input type="text" bind:value={query} placeholder="Cari IMDB ID atau judul..." onkeydown={(e) => e.key === 'Enter' && handleQuerySearch()} />
      <button class="btn btn-primary" onclick={handleQuerySearch} disabled={loading || !query.trim()}>
        {loading ? 'Searching...' : 'Cari'}
      </button>
    </div>
    
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
            <input type="text" id="imdb" bind:value={imdbId} placeholder="tt1234567" />
          </div>
          <div class="form-group">
            <label for="type">Type</label>
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
              <input type="number" id="season" bind:value={season} min="1" />
            </div>
            <div class="form-group">
              <label for="episode">Episode</label>
              <input type="number" id="episode" bind:value={episode} min="1" />
            </div>
          </div>
        {/if}

        <button class="btn btn-primary" onclick={handleImdbSearch} disabled={loading || !imdbId.trim()}>
          Cari IMDB
        </button>
      </div>
    {/if}
  </div>

  {#if error}
    <div class="error-card">
      <p>{error}</p>
    </div>
  {/if}

  {#if catalogResults.length > 0 && !selectedItem}
    {#if movieResults.length > 0 && seriesResults.length > 0}
      <div class="search-tabs">
        <button
          class="tab-btn"
          class:active={searchTab === 'movie'}
          onclick={() => searchTab = 'movie'}
        >
          Movies ({movieResults.length})
        </button>
        <button
          class="tab-btn"
          class:active={searchTab === 'series'}
          onclick={() => searchTab = 'series'}
        >
          Series ({seriesResults.length})
        </button>
      </div>
    {/if}

    <div class="results-grid">
      {#each (searchTab === 'movie' ? movieResults : seriesResults) as item}
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

  {#if selectedItem && !result}
    <div class="meta-card">
      <div class="meta-content">
        {#if selectedItem.poster}
          <img src={selectedItem.poster} alt={selectedItem.name} class="poster" />
        {/if}
        <div class="meta-info">
          <h2>{selectedItem.name}</h2>
          {#if selectedItem.year}<span class="badge">{selectedItem.year}</span>{/if}
          {#if selectedItem.description}<p class="mt-2 text-secondary">{selectedItem.description.slice(0, 200)}{selectedItem.description.length > 200 ? '...' : ''}</p>{/if}
        </div>
      </div>
      <button class="btn btn-primary" onclick={handleImdbSearch} disabled={loading}>{loading ? 'Loading...' : 'Load Torrents'}</button>
    </div>
  {/if}

  {#if result}
    <div class="meta-card">
      <div class="meta-content">
        {#if result.meta.poster}
          <img src={result.meta.poster} alt={result.meta.title} class="poster" />
        {:else}
          <div class="poster-placeholder"></div>
        {/if}
        <div class="meta-info">
          <h2>{result.meta.title}</h2>
          {#if result.meta.year}<span class="badge">{result.meta.year}</span>{/if}
          {#if seriesMeta}
            <div class="series-seasons">
              {#each seriesMeta.videos?.filter(v => v.season != null).map(v => v.season!).filter((s, i, a) => a.indexOf(s) === i).sort((a, b) => a - b) as s}
                <span class="badge">S{s}</span>
              {/each}
            </div>
          {/if}
        </div>
      </div>

      <div class="source-tabs">
        <button
          class="tab-btn {sourceTab === 'torrentio' ? 'active' : ''}"
          onclick={() => sourceTab = 'torrentio'}
        >
          Torrentio ({result.torrents.length})
        </button>
        <button
          class="tab-btn {sourceTab === 'custom' ? 'active' : ''}"
          onclick={() => sourceTab = 'custom'}
        >
          Custom Magnet
        </button>
      </div>

      {#if sourceTab === 'torrentio'}
        {#if result.torrents.length === 0}
          <div class="no-torrents-card">
            <p class="text-muted">No torrents found for this title.</p>
          </div>
        {:else}
          <div class="torrent-list">
            {#each result.torrents as torrent}
              <div class="torrent-card">
                <div class="torrent-info">
                  <span class="torrent-name">{torrent.name}</span>
                  <div class="torrent-meta">
                    <span class="badge">{torrent.seeder ?? 0} seeds</span>
                    <span class="badge">{torrent.quality || 'Unknown'}</span>
                    {#if torrent.size_bytes}
                      <span class="badge">{formatBytes(torrent.size_bytes)}</span>
                    {/if}
                  </div>
                </div>
                <button
                  class="btn btn-primary btn-sm"
                  onclick={() => addToQueue(torrent)}
                >
                  + Queue
                </button>
              </div>
            {/each}
          </div>
        {/if}
      {:else}
        <div class="custom-magnet-section">
          <div class="form-group">
            <label for="magnet">Magnet URI</label>
            <textarea id="magnet" bind:value={customMagnet} oninput={handleMagnetInput} rows="3" placeholder="magnet:?xt=urn:btih:..."></textarea>
          </div>
          <div class="form-group">
            <label for="ctitle">Title (optional)</label>
            <input type="text" id="ctitle" bind:value={customTitle} placeholder={result.meta.title || 'Enter title'} />
          </div>
          {#if mediaType === 'series'}
            <div class="grid-2">
              <div class="form-group">
                <label for="s">Season</label>
                <input type="number" id="s" bind:value={season} min="1" />
              </div>
              <div class="form-group">
                <label for="ep">Episode</label>
                <input type="number" id="ep" bind:value={episode} min="1" />
              </div>
            </div>
          {/if}
          {#if parseMagnet(customMagnet).infohash}
          <div class="flex gap-3 mb-4">
            <button class="btn btn-secondary" onclick={inspectMagnet} disabled={inspecting}>
              {inspecting ? 'Inspecting...' : 'Inspect Files'}
            </button>
            {#if inspectedFiles.length > 0}
              <button
                class="btn btn-primary"
                onclick={addCustomToQueue}
                disabled={customAdding}
              >
                {customAdding ? 'Adding...' : 'Add to Queue'}
              </button>
            {/if}
          </div>
          {:else}
            <p class="magnet-hint">Paste a valid magnet URI to inspect files</p>
          {/if}

          {#if inspectedFiles.length > 0}
            <h4 class="files-heading">
              {inspectedFiles.length} file(s) in <span class="files-torrent-name">{torrentName}</span>
            </h4>
            <div class="file-list">
              {#each inspectedFiles as file}
                <button
                  type="button"
                  class="file-option {selectedFileIdx === file.index ? 'selected' : ''}"
                  onclick={() => selectedFileIdx = file.index}
                >
                  <span class="file-radio {selectedFileIdx === file.index ? 'active' : ''}"></span>
                  <div class="file-info">
                    <span class="file-name">{file.name}</span>
                    <span class="file-size">{formatBytes(file.size_bytes)}</span>
                  </div>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
  </div>
{/if}
</div>

<style>
  .page { max-width: 1200px; margin: 0 auto; }
  .page-title {
    font-size: 1.75rem;
    font-weight: 700;
    color: var(--text-primary);
    margin-bottom: 0.25rem;
  }
  .page-subtitle {
    color: var(--text-secondary);
    font-size: 0.875rem;
    margin-bottom: 1.5rem;
  }
  .search-form {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.5rem;
  }
  .search-bar {
    display: flex;
    gap: 1rem;
  }
  .search-bar input {
    flex: 1;
  }
  .advanced-toggle {
    margin-top: 1rem;
  }
  .btn-link {
    background: none;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
  }
  .btn-link:hover {
    color: var(--accent-hover);
  }
  .imdb-search {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
  }
  .grid-2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }
  .form-group {
    margin-bottom: 1rem;
  }
  .form-group label {
    display: block;
    margin-bottom: 0.5rem;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    color: var(--text-secondary);
  }
  .form-group input, .form-group select, .form-group textarea {
    width: 100%;
  }
  .error-card {
    background: rgba(255, 68, 102, 0.1);
    border: 1px solid var(--danger);
    border-radius: var(--radius);
    padding: 1rem;
    margin-top: 1rem;
  }
  .error-card p { color: var(--danger); }

  .results-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 1rem;
    margin-top: 1rem;
  }
  .result-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    cursor: pointer;
    transition: border-color 0.15s;
    text-align: left;
    color: var(--text-primary);
    padding: 0;
    font-family: inherit;
    font-size: inherit;
  }
  .result-card:hover {
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
    background: var(--bg-secondary);
  }
  .result-info {
    padding: 0.75rem;
  }
  .result-title {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-weight: 600;
    font-size: 0.85rem;
    margin-bottom: 0.5rem;
    line-height: 1.3;
  }
  .result-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .meta-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.5rem;
    margin-top: 1rem;
  }
  .meta-content {
    display: flex;
    gap: 1.5rem;
    margin-bottom: 1rem;
  }
  .meta-content .poster {
    width: 120px;
    height: 180px;
    object-fit: cover;
    border-radius: var(--radius-sm);
    flex-shrink: 0;
  }
  .poster-placeholder {
    width: 120px;
    height: 180px;
    background: var(--bg-secondary);
    border-radius: var(--radius-sm);
    flex-shrink: 0;
  }
  .meta-info h2 {
    font-size: 1.25rem;
    margin-bottom: 0.5rem;
  }
  .meta-info p {
    font-size: 0.85rem;
    line-height: 1.4;
  }
  .series-seasons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin-top: 0.5rem;
  }
  .mt-2 { margin-top: 0.5rem; }
  .text-secondary { color: var(--text-secondary); }

  .source-tabs {
    display: flex;
    border-bottom: 1px solid var(--border);
    margin-bottom: 1rem;
  }
  .tab-btn {
    padding: 0.75rem 1.25rem;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    font-weight: 600;
    transition: all 0.15s ease;
    margin-bottom: -2px;
  }
  .tab-btn:hover {
    color: var(--text-primary);
  }
  .tab-btn.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  .search-tabs {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0;
    margin-top: 1rem;
    border-bottom: 1px solid var(--border);
  }

  .custom-magnet-section {
    margin-top: 1rem;
    padding: 1.5rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .file-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .file-option {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
    text-align: left;
    color: var(--text-primary);
    font-family: inherit;
    font-size: 0.875rem;
    width: 100%;
    transition: border-color 0.15s;
  }
  .file-option:hover {
    border-color: var(--accent);
    background: var(--glass-hover);
  }
  .file-option.selected {
    border-color: var(--accent);
    background: rgba(245, 197, 24, 0.05);
  }
  .file-radio {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 2px solid var(--border);
    flex-shrink: 0;
  }
  .file-radio.active {
    border-color: var(--accent);
    background: var(--accent);
    box-shadow: 0 0 0 2px var(--bg-primary) inset;
  }
  .file-info {
    flex: 1;
    min-width: 0;
  }
  .file-name {
    display: block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 0.85rem;
    margin-bottom: 0.15rem;
  }
  .file-size {
    font-size: 0.75rem;
    color: var(--text-muted);
  }
  .files-heading {
    margin: 1rem 0 0.5rem;
    font-size: 0.85rem;
    color: var(--text-secondary);
  }
  .files-torrent-name {
    color: var(--text-muted);
    font-weight: normal;
  }
  .magnet-hint {
    color: var(--text-muted);
    font-size: 0.85rem;
    text-align: center;
    padding: 1rem 0;
  }

  .no-torrents-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 2rem;
    text-align: center;
  }
  .torrent-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .torrent-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 1rem;
    background: var(--bg-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .torrent-info {
    flex: 1;
    min-width: 0;
  }
  .torrent-name {
    display: block;
    font-size: 0.85rem;
    margin-bottom: 0.3rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .torrent-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }

  .flex { display: flex; }
  .gap-3 { gap: 0.75rem; }
  .mb-4 { margin-bottom: 1rem; }
  .mb-3 { margin-bottom: 0.75rem; }
  .mt-6 { margin-top: 1.5rem; }
  .btn { 
    padding: 0.5rem 1rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-primary);
    cursor: pointer;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    font-weight: 600;
  }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #000;
  }
  .btn-secondary {
    background: var(--surface);
    border-color: var(--border);
    color: var(--text-primary);
  }
  .btn-sm { padding: 0.3rem 0.6rem; font-size: 0.7rem; }
  
  :global(.p-8) { padding: 2rem; }
</style>
