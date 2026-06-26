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
  let inspectingTorrent = $state<string | null>(null);
  let inspectedTorrents = $state<Record<string, { files: {index: number; name: string; size_bytes: number}[]; name: string; selectedIdx: number }>>({});
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

  const availableSeasons = $derived(() => {
    if (!seriesMeta?.videos) return [];
    return [...new Set(seriesMeta.videos
      .map(v => v.season)
      .filter((s): s is number => s != null)
    )].sort((a, b) => a - b);
  });

  const availableEpisodes = $derived(() => {
    if (!seriesMeta?.videos) return [];
    return seriesMeta.videos
      .filter(v => v.season === season)
      .sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
  });

  function handleSeasonChange(newSeason: number) {
    season = newSeason;
    episode = 1;
  }

  onMount(async () => {
    try {
      const settings = await api.getSettings();
      metadataBaseUrl = settings['stremio_metadata_url'] || DEFAULT_METADATA_URL;
    } catch (e) {
      metadataBaseUrl = DEFAULT_METADATA_URL;
    }

    // Check for prefill from route params
    const imdbParam = routeParams?.imdb_id;
    const typeParam = routeParams?.type;
    const seasonParam = routeParams?.season ? Number(routeParams.season) : undefined;
    const episodeParam = routeParams?.episode ? Number(routeParams.episode) : undefined;

    if (imdbParam) {
      imdbId = imdbParam;
      if (typeParam) mediaType = typeParam as 'movie' | 'series';
      if (seasonParam) season = seasonParam;
      if (episodeParam) episode = episodeParam;
      showImdbSearch = true;
      await handleImdbSearch();
    }
  });
  // React to routeParams changes (e.g., from Library detail navigation)
  let prevPrefillKey = $state('');
  $effect(() => {
    const key = JSON.stringify(routeParams);
    if (key !== prevPrefillKey && routeParams?.imdb_id) {
      prevPrefillKey = key;
      imdbId = routeParams.imdb_id;
      if (routeParams.type) mediaType = routeParams.type as 'movie' | 'series';
      if (routeParams.season) season = Number(routeParams.season);
      if (routeParams.episode) episode = Number(routeParams.episode);
      showImdbSearch = true;
      handleImdbSearch();
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
        torrent_name: inspectedTorrents[torrent.infohash]?.name || (torrent.filename ?? ""),
        file_idx: inspectedTorrents[torrent.infohash]?.selectedIdx ?? torrent.file_idx,
        file_size_bytes: torrent.size_bytes,
      });
      addToast(`Added to queue: ${result?.meta.title || selectedItem?.name}`, 'success');
    } catch (e: any) {
      addToast(`Failed: ${e.message}`, 'error');
    }
  }

  async function inspectTorrentFiles(infohash: string, torrent: Torrent) {
    inspectingTorrent = infohash;
    try {
      const resp = await api.inspectTorrent(infohash);
      // Match Torrentio's file_idx or filename to pre-select the right file
      let matchedIdx = torrent.file_idx;
      if (torrent.filename) {
        const byName = resp.files.findIndex(f => f.name.endsWith(torrent.filename) || torrent.filename.endsWith(f.name));
        if (byName >= 0) matchedIdx = resp.files[byName].index;
      }
      inspectedTorrents = { [infohash]: { files: resp.files, name: resp.name, selectedIdx: matchedIdx } };
    } catch (e: any) {
      addToast(`Inspect failed: ${e.message}`, 'error');
    } finally {
      inspectingTorrent = null;
    }
  }

  function parseMagnet(uri: string): { infohash: string; name: string } {
    const hashMatch = uri.match(/btih:([a-fA-F0-9]{40})/i);
    const infohash = hashMatch ? hashMatch[1].toLowerCase() : '';
    const dnMatch = uri.match(/[?&]dn=([^&]+)/);
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
        torrent_name: "",
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
        <div>
          <h2>{selectedItem.name}</h2>
          {#if selectedItem.year}
            <span class="badge">{selectedItem.year}</span>
          {/if}
          <span class="badge ml-2">{selectedItem.type}</span>
        </div>
      </div>
    </div>

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
        <button class="btn btn-primary" onclick={() => { pushView(); handleImdbSearch(); }} disabled={loading}>
          {loading ? 'Searching...' : 'Search Torrents'}
        </button>
      </div>
    {/if}
  {/if}

  {#if result}
    <div class="meta-card">
      <div class="meta-content">
        {#if result.meta.poster}
          <img src={result.meta.poster} alt={result.meta.title} class="poster" />
        {/if}
        <div>
          <h2>{result.meta.title}</h2>
          {#if result.meta.year}
            <span class="badge">{result.meta.year}</span>
          {/if}
        </div>
      </div>
    </div>

    <!-- Source tabs -->
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
        <h3 class="mt-4 mb-3 text-secondary">
          {result.torrents.length} torrent source(s)
        </h3>
        <div class="torrent-list">
          {#each result.torrents as torrent}
            <div class="torrent-item">
              <div class="torrent-info">
                <span class="torrent-name">{torrent.name}</span>
                <span class="torrent-title">{torrent.title}</span>
                <span class="torrent-size">{formatBytes(torrent.size_bytes)}</span>
              </div>
              <div class="torrent-actions">
                <button class="btn btn-secondary btn-sm" onclick={() => inspectTorrentFiles(torrent.infohash, torrent)} disabled={inspectingTorrent === torrent.infohash}>
                  {inspectingTorrent === torrent.infohash ? '...' : 'Files'}
                </button>
                <button class="btn btn-primary btn-sm" onclick={() => addToQueue(torrent)}>
                  Add to Queue
                </button>
              </div>
            </div>
            {#if inspectedTorrents[torrent.infohash]?.files}
              <div class="file-list torrent-file-list">
                <h4 class="files-heading">
                  {inspectedTorrents[torrent.infohash].files.length} file(s) in <span class="files-torrent-name">{inspectedTorrents[torrent.infohash].name}</span>
                </h4>
                {#each inspectedTorrents[torrent.infohash].files as file}
                  <button
                    type="button"
                    class="file-option {inspectedTorrents[torrent.infohash].selectedIdx === file.index ? 'selected' : ''}"
                    onclick={() => {
                      inspectedTorrents = {
                        ...inspectedTorrents,
                        [torrent.infohash]: { ...inspectedTorrents[torrent.infohash], selectedIdx: file.index }
                      };
                    }}
                  >
                    <span class="file-radio {inspectedTorrents[torrent.infohash].selectedIdx === file.index ? 'active' : ''}"></span>
                    <div class="file-info">
                      <span class="file-name">{file.name}</span>
                      <span class="file-size">{formatBytes(file.size_bytes)}</span>
                    </div>
                  </button>
                {/each}
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    {:else}
      <!-- Custom Magnet tab -->
      <div class="custom-magnet-section">
        <div class="form-group">
          <label for="custom-magnet">Magnet URI</label>
          <textarea
            id="custom-magnet"
            bind:value={customMagnet}
            placeholder="magnet:?xt=urn:btih:..."
            rows="3"
            oninput={handleMagnetInput}
          ></textarea>
        </div>
        {#if parseMagnet(customMagnet).infohash}
          <p class="infohash-text">
            Infohash: <code>{parseMagnet(customMagnet).infohash}</code>
          </p>
          <div class="form-group">
            <label for="custom-title-2">Title (optional)</label>
            <input id="custom-title-2" type="text" bind:value={customTitle} placeholder={result.meta.title} />
          </div>
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
  {/if}
</div>

<style>
  .page {
    max-width: 900px;
    margin: 0 auto;
  }

  .page-title {
    font-family: 'JetBrains Mono', monospace;
    font-weight: 700;
    font-size: 1.25rem;
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

.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

@media (max-width: 639px) {
  .grid-2 {
    grid-template-columns: 1fr;
  }
}

  .search-bar {
    display: flex;
    gap: 0.5rem;
  }

  .search-bar input {
    flex: 1;
    border-color: var(--border-light);
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
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    padding: 0.5rem;
    transition: color 0.15s ease;
  }

  .btn-link:hover {
    color: var(--accent-hover);
  }

  .imdb-search {
    margin-top: 1.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--border);
  }

  .meta-card {
    margin-top: 1rem;
    padding: 1.5rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
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
    border: 1px solid var(--border);
  }

  .meta-content h2 {
    font-family: 'JetBrains Mono', monospace;
    font-weight: 600;
    font-size: 1.1rem;
  }

  .search-tabs {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0;
    margin-top: 1rem;
    border-bottom: 1px solid var(--border);
  }

  .results-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 1rem;
    margin-top: 1rem;
  }

  .result-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
    transition: all 0.15s ease;
    overflow: hidden;
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
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .torrent-actions {
    display: flex;
    gap: 0.5rem;
    flex-shrink: 0;
  }

  .torrent-file-list {
    margin-top: 0;
    margin-bottom: 0.75rem;
    padding: 0.75rem 1.25rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-top: none;
    border-radius: 0 0 var(--radius) var(--radius);
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
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .torrent-item:hover {
    border-color: var(--accent);
  }

  .torrent-info {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }

  .torrent-name {
    font-weight: 600;
    font-size: 0.875rem;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  .torrent-title {
    color: var(--text-secondary);
    font-size: 0.8rem;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  .source-tabs {
    display: flex;
    gap: 0;
    border-bottom: 2px solid var(--border);
    margin-top: 1.5rem;
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
    max-height: 400px;
    overflow-y: auto;
  }

  .file-option {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: all 0.15s ease;
    text-align: left;
    color: var(--text-primary);
    width: 100%;
    font-family: inherit;
    font-size: inherit;
  }

  .file-option:hover {
    border-color: var(--accent);
  }

  .file-option.selected {
    border-color: var(--accent);
  }

  .file-radio {
    width: 18px;
    height: 18px;
    min-width: 18px;
    border-radius: 50%;
    border: 2px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s ease;
  }

  .file-radio.active {
    border-color: var(--accent);
  }

  .file-radio.active::after {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
  }

  .file-info {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }

  .file-name {
    font-size: 0.85rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .file-size {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .btn-secondary {
    padding: 0.5rem 1rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    cursor: pointer;
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    transition: all 0.15s ease;
  }

  .btn-secondary:hover:not(:disabled) {
    border-color: var(--accent);
  }

  .btn-secondary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .error-card {
    margin-top: 1rem;
    padding: 1rem;
    background: var(--surface);
    border: 1px solid var(--danger);
    border-radius: var(--radius);
  }

  .error-card p {
    color: var(--danger);
    font-size: 0.85rem;
  }

  .season-episode-card {
    margin-top: 1rem;
    padding: 1.5rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .no-torrents-card {
    margin-top: 1rem;
    padding: 1.5rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .infohash-text {
    color: var(--text-muted);
    margin-bottom: 0.75rem;
    font-size: 0.8rem;
  }

  .magnet-hint {
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .files-heading {
    margin: 1rem 0 0.75rem;
    color: var(--text-secondary);
    font-size: 0.85rem;
    font-weight: 500;
  }

  .files-torrent-name {
    color: var(--text-primary);
  }

  textarea {
    font-family: monospace;
    resize: vertical;
  }

  @media (max-width: 639px) {
    .search-bar {
      flex-direction: column;
    }

    .search-bar button {
      width: 100%;
      justify-content: center;
      min-height: 44px;
    }

    .results-grid {
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    }
    .torrent-item {
      flex-direction: column; gap: 0.75rem;
    }
    .torrent-actions { width: 100%; }
    .torrent-actions .btn { flex: 1; justify-content: center; }
  }
  /* ponytail: utility classes replacing Tailwind conventions */
  :global(.flex) { display: flex; }
  :global(.gap-2) { gap: 0.5rem; }
  :global(.gap-3) { gap: 0.75rem; }
  :global(.ml-2) { margin-left: 0.5rem; }
  :global(.mt-3) { margin-top: 0.75rem; }
  :global(.mt-4) { margin-top: 1rem; }
  :global(.mb-3) { margin-bottom: 0.75rem; }
  :global(.mb-4) { margin-bottom: 1rem; }
  :global(.mt-6) { margin-top: 1.5rem; }
  :global(.text-center) { text-align: center; }
  :global(.p-8) { padding: 2rem; }
</style>
