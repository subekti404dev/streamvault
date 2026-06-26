<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import type { LibraryDetail, LibraryJob, StremioVideo } from '../lib/types';
  import { formatDuration } from '../lib/types';
  import { getToken } from '../lib/api';

  function hlsUrl(jobId: string): string {
    const token = getToken();
    const base = `/proxy/hls/${jobId}/master.m3u8`;
    return token ? `${base}?token=${token}` : base;
  }

  let { id, addToast }: {
    id: string;
    addToast: (msg: string, type?: string) => void;
  } = $props();

  let detail = $state<LibraryDetail | null>(null);
  let loading = $state(true);
  let expandedSeasons = $state<Set<number>>(new Set([1]));
  let expandedEpisodes = $state<Set<string>>(new Set());
  let showMovieStreams = $state(false);
  let seriesVideos = $state<StremioVideo[]>([]);
  let metadataBaseUrl = $state('');

  const DEFAULT_METADATA_URL = 'https://aiometadatafortheweebs.midnightignite.me/stremio/43031d18-5fb4-40dc-9d73-cce34062e999';

  onMount(async () => {
    try {
      const settings = await api.getSettings();
      metadataBaseUrl = settings['stremio_metadata_url'] || DEFAULT_METADATA_URL;
    } catch {
      metadataBaseUrl = DEFAULT_METADATA_URL;
    }
    try {
      detail = await api.getLibraryItem(id);
      if (detail.media_type === 'series' && detail.jobs.length > 0) {
        const firstSeason = detail.jobs[0]?.season ?? 1;
        expandedSeasons = new Set([firstSeason]);
        await loadSeriesVideos();
      }
    } catch (e: any) {
      addToast(`Failed to load detail: ${e.message}`, 'error');
    } finally {
      loading = false;
    }
  });

  async function loadSeriesVideos() {
    if (!detail || detail.media_type !== 'series') return;
    try {
      const metaResponse = await api.getStremioMeta('series', detail.imdb_id, metadataBaseUrl);
      seriesVideos = metaResponse.meta.videos || [];
    } catch {
      seriesVideos = [];
    }
  }

  function toggleSeason(season: number) {
    const next = new Set(expandedSeasons);
    if (next.has(season)) next.delete(season);
    else next.add(season);
    expandedSeasons = next;
  }

  function toggleEpisode(season: number, episode: number) {
    const key = `${season}-${episode}`;
    const next = new Set(expandedEpisodes);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expandedEpisodes = next;
  }

  function getSeasons(): number[] {
    if (!detail) return [];
    const fromJobs = detail.jobs.map(j => j.season).filter((s): s is number => s != null);
    const fromVideos = seriesVideos.map(v => v.season).filter((s): s is number => s != null);
    return [...new Set([...fromJobs, ...fromVideos])].sort((a, b) => a - b);
  }

  function getEpisodesForSeason(season: number): LibraryJob[] {
    if (!detail) return [];
    return detail.jobs
      .filter(j => j.season === season)
      .sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
  }
  function getAllEpisodeJobs(season: number, episode: number): LibraryJob[] {
    if (!detail) return [];
    return detail.jobs.filter(j => j.season === season && j.episode === episode);
  }

  function getVideosForSeason(season: number): StremioVideo[] {
    return seriesVideos
      .filter(v => v.season === season)
      .sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
  }

  function isEpisodeCompleted(season: number, episode: number): boolean {
    if (!detail) return false;
    return detail.jobs.some(j => j.season === season && j.episode === episode);
  }

  function getEpisodeJob(season: number, episode: number): LibraryJob | undefined {
    if (!detail) return undefined;
    return detail.jobs.find(j => j.season === season && j.episode === episode);
  }

  function navigateToSearch(season: number, episode: number) {
    window.location.hash = `#search?imdb_id=${detail?.imdb_id}&type=series&season=${season}&episode=${episode}`;
  }

  async function requeueJob(jobId: string) {
    try {
      await api.requeueJob(jobId);
      addToast('Job requeued', 'success');
      detail = await api.getLibraryItem(id);
    } catch (e: any) {
      addToast(`Requeue failed: ${e.message}`, 'error');
    }
  }
  async function deleteJob(jobId: string) {
    if (!confirm('Are you sure you want to delete this?')) return;
    try {
      await api.deleteJob(jobId);
      if (detail?.media_type === 'movie') {
        window.location.hash = '#library';
        return;
      }
      detail = await api.getLibraryItem(id);
    } catch (e: any) {
      addToast(`Delete failed: ${e.message}`, 'error');
    }
  }
</script>

<div class="page">
  <a href="#library" class="back-link">
    ← Back to Library
  </a>

  {#if loading}
    <div class="card"><p class="text-muted">Loading...</p></div>
  {:else if !detail}
    <div class="card"><p class="text-muted">Item not found</p></div>
  {:else}
    <div class="detail-header">
      <div class="poster-container">
        {#if detail.poster_url}
          <img src={detail.poster_url} alt={detail.title || 'Poster'} class="poster" />
        {:else}
          <div class="poster placeholder">
            {detail.media_type === 'movie' ? '🎬' : '📺'}
          </div>
        {/if}
      </div>
      <div class="detail-info">
        <h1>{detail.title || detail.imdb_id}</h1>
        <div class="meta-badges">
          <span class="badge">{detail.media_type === 'movie' ? 'Movie' : 'Series'}</span>
          {#if detail.media_type === 'series'}
            <span class="badge">{detail.jobs.length} episodes completed</span>
          {/if}
        </div>
      </div>
    </div>
    {#if detail.media_type === 'movie' && detail.jobs.length > 0}
      <div class="season-section" style="margin-bottom:1.5rem">
        <button class="season-header" onclick={() => showMovieStreams = !showMovieStreams}>
          <span class="season-title">
            Streams
            <span class="episode-count">({detail.jobs.length} sources)</span>
          </span>
          <span class="season-toggle">{showMovieStreams ? '▴' : '▸'}</span>
        </button>
        {#if showMovieStreams}
        <div class="episodes-list">
          {#each detail.jobs as job, i}
            <div class="episode-row">
              <span class="episode-badge">{job.video_resolution ?? `Q${i + 1}`}</span>
              <span class="episode-title">{job.torrent_name ?? 'Unknown'}</span>
              <div class="episode-actions">
                <a href={hlsUrl(job.id)} target="_blank" class="btn btn-sm btn-primary">▶ Play</a>
                <button class="btn btn-sm btn-danger" onclick={() => deleteJob(job.id)}>✗ Delete</button>
              </div>
            </div>
          {/each}
        </div>
        {/if}
      </div>
    {/if}

    {#if detail.media_type === 'series'}
      <div class="seasons-list">
        {#each getSeasons() as season}
          <div class="season-section">
            <button class="season-header" onclick={() => toggleSeason(season)}>
              <span class="season-title">
                Season {season}
                <span class="episode-count">({getEpisodesForSeason(season).length} completed)</span>
              </span>
              <span class="season-toggle">{expandedSeasons.has(season) ? '▴' : '▸'}</span>
            </button>

            {#if expandedSeasons.has(season)}
              <div class="episodes-list">
                {#each getVideosForSeason(season) as video}
                  {@const ep = video.episode ?? 0}
                  {@const completed = isEpisodeCompleted(season, ep)}
                  {@const epKey = `${season}-${ep}`}
                  {@const epJobs = getAllEpisodeJobs(season, ep)}
                  <button class="episode-row" class:completed onclick={() => toggleEpisode(season, ep)}>
                    <span class="episode-badge">E{String(ep).padStart(2, '0')}</span>
                    <span class="episode-title">{video.title}</span>
                    <span class="episode-info">
                      {#if completed}
                        {epJobs.length} source{epJobs.length !== 1 ? 's' : ''}
                        {#if getEpisodeJob(season, ep)?.duration_seconds}
                          · {formatDuration(getEpisodeJob(season, ep)?.duration_seconds ?? 0)}
                        {/if}
                      {:else}
                        <span class="text-muted">Not transcoded</span>
                      {/if}
                    </span>
                    <span class="episode-actions">
                      {#if completed}
                        <span class="season-toggle">{expandedEpisodes.has(epKey) ? '▴' : '▸'}</span>
                      {:else}
                        <button class="btn btn-sm" onclick={(e) => { e.stopPropagation(); navigateToSearch(season, ep); }}>🔍 Search</button>
                      {/if}
                    </span>
                  </button>
                  {#if completed && expandedEpisodes.has(epKey)}
                    <div class="stream-sublist">
                      {#each epJobs as epJob}
                        <div class="stream-row">
                          <span class="stream-icon">└</span>
                          <span class="stream-badge">{epJob.video_resolution ?? 'SD'}</span>
                          <span class="stream-name">{epJob.torrent_name ?? 'Unknown'}</span>
                          <span class="stream-duration">{epJob.duration_seconds ? formatDuration(epJob.duration_seconds) : ''}</span>
                          <div class="stream-actions">
                            <a href={hlsUrl(epJob.id)} target="_blank" class="btn btn-sm btn-primary" title={epJob.torrent_name ?? ''}>▶ Play</a>
                            <button class="btn btn-sm btn-danger" onclick={(e) => { e.stopPropagation(); deleteJob(epJob.id); }}>✗ Delete</button>
                          </div>
                        </div>
                      {/each}
                    </div>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .back-link {
    display: inline-block;
    margin-bottom: 1.5rem;
    color: var(--text-muted);
    text-decoration: none;
    font-size: 0.9rem;
  }
  .back-link:hover { color: var(--text-primary); }

  .detail-header {
    display: flex;
    gap: 1.5rem;
    margin-bottom: 1.5rem;
  }

  .poster-container {
    width: 200px;
    flex-shrink: 0;
    aspect-ratio: 2/3;
    border-radius: var(--radius);
    overflow: hidden;
  }

  .poster { width: 100%; height: 100%; object-fit: cover; }
  .poster.placeholder {
    display: flex; align-items: center; justify-content: center;
    background: var(--bg-secondary); font-size: 3rem;
  }

  .detail-info h1 { margin: 0 0 0.5rem 0; }
  .meta-badges { display: flex; gap: 0.5rem; }


  .seasons-list { display: flex; flex-direction: column; gap: 0.5rem; }

  .season-section {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); overflow: hidden;
  }

  .season-header {
    width: 100%; display: flex; justify-content: space-between;
    align-items: center; padding: 0.75rem 1rem;
    background: transparent; border: none; color: var(--text-primary);
    cursor: pointer; text-align: left; font-size: 1rem; font-weight: 600;
  }
  .season-header:hover { background: var(--bg-secondary); }

  .season-title { display: flex; align-items: center; gap: 0.5rem; }
  .episode-count { font-weight: 400; color: var(--text-muted); font-size: 0.85rem; }
  .season-toggle { font-size: 1.2rem; color: var(--text-muted); }

  .episodes-list { border-top: 1px solid var(--border); }

  .episode-row {
    width: 100%; display: flex; align-items: center; gap: 0.75rem;
    padding: 0.5rem 1rem; border: none; border-bottom: 1px solid var(--border);
    background: #1A1A1A; color: var(--text-primary);
    font-family: 'JetBrains Mono', monospace; font-size: 0.85rem;
    cursor: pointer; text-align: left;
  }
  .episode-row:hover { background: #252525; }
  .episode-row:last-child { border-bottom: none; }

  .episode-badge {
    font-family: 'JetBrains Mono', monospace; color: var(--accent); min-width: 40px;
  }

  .episode-title {
    flex: 1; font-size: 0.9rem;
  }

  .episode-info {
    color: var(--text-muted); font-size: 0.85rem; min-width: 120px;
    text-align: right;
  }

  .episode-actions { display: flex; gap: 0.25rem; }

  /* ── Stream sublist (tree view) ── */
  .stream-sublist {
    border-top: 1px solid var(--border);
    background: rgba(0, 0, 0, 0.15);
  }
  .stream-row {
    display: flex; align-items: center; gap: 0.5rem;
    padding: 0.4rem 1rem 0.4rem 2rem;
    border-bottom: 1px solid var(--border);
    font-size: 0.85rem;
  }
  .stream-row:last-child { border-bottom: none; }
  .stream-icon {
    font-family: 'JetBrains Mono', monospace;
    color: var(--text-muted); font-size: 0.75rem;
    min-width: 16px;
  }
  .stream-badge {
    font-family: 'JetBrains Mono', monospace;
    color: var(--accent); font-size: 0.75rem;
    min-width: 48px;
  }
  .stream-name {
    flex: 1; color: var(--text-secondary);
  }
  .stream-duration {
    color: var(--text-muted); font-size: 0.8rem;
    min-width: 60px; text-align: right;
  }
  .stream-actions { display: flex; gap: 0.25rem; }

  @media (max-width: 639px) {
    .detail-header {
      flex-direction: column; align-items: center; text-align: center;
    }
    .poster-container { width: 140px; }
    .episode-row {
      flex-wrap: wrap; gap: 0.35rem; padding: 0.5rem;
    }
    .episode-badge { min-width: 32px; }
    .episode-info { min-width: unset; }
    .episode-actions { margin-left: auto; }
    .stream-row {
      flex-wrap: wrap; gap: 0.35rem; padding: 0.4rem 0.5rem 0.4rem 1rem;
    }
    .stream-name { min-width: unset; }
  }
</style>
