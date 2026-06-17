<script lang="ts">
  import { api } from '../lib/api';
  import type { SearchResult, Torrent } from '../lib/types';
  import { formatBytes } from '../lib/types';

  let { addToast }: { addToast: (msg: string, type?: string) => void } = $props();

  let imdbId = $state('');
  let mediaType = $state('movie');
  let season = $state(1);
  let episode = $state(1);
  let loading = $state(false);
  let result = $state<SearchResult | null>(null);
  let error = $state('');

  async function handleSearch() {
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
        title: result?.meta.title,
        poster_url: result?.meta.poster,
        magnet_uri: torrent.magnet_uri,
        infohash: torrent.infohash,
        torrent_name: torrent.filename || torrent.title,
        file_idx: torrent.file_idx,
        file_size_bytes: torrent.size_bytes,
      });
      addToast(`Added to queue: ${result?.meta.title}`, 'success');
    } catch (e: any) {
      addToast(`Failed: ${e.message}`, 'error');
    }
  }
</script>

<div class="page">
  <h1 class="page-title">Search</h1>
  <p class="page-subtitle">Search for movies and series by IMDB ID</p>

  <div class="glass-card search-form">
    <div class="grid-2">
      <div class="form-group">
        <label for="imdb">IMDB ID</label>
        <input
          id="imdb"
          type="text"
          bind:value={imdbId}
          placeholder="e.g. tt0903747"
          onkeydown={(e) => e.key === 'Enter' && handleSearch()}
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

    <button class="btn btn-primary" onclick={handleSearch} disabled={loading || !imdbId.trim()}>
      {loading ? 'Searching...' : 'Search'}
    </button>
  </div>

  {#if error}
    <div class="glass-card" style="margin-top:1rem; border-color: rgba(239,68,68,0.3);">
      <p style="color:var(--danger)">{error}</p>
    </div>
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
</style>
