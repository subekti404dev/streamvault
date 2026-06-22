<script lang="ts">
  import { api } from '../lib/api';
  import { onSseEvent } from '../lib/events';
  import type { LibraryGroup } from '../lib/types';

  let { addToast }: {
    addToast: (msg: string, type?: string) => void;
  } = $props();

  let activeTab = $state<'movie' | 'series'>('movie');
  let items = $state<LibraryGroup[]>([]);
  let total = $state(0);
  let page = $state(1);
  let limit = 20;
  let loading = $state(true);

  async function loadLibrary() {
    loading = true;
    try {
      const data = await api.getLibrary(activeTab, page, limit);
      items = data.items;
      total = data.total;
    } catch (e: any) {
      addToast(`Failed to load library: ${e.message}`, 'error');
    } finally {
      loading = false;
    }
  }

  function switchTab(tab: 'movie' | 'series') {
    activeTab = tab;
    page = 1;
    loadLibrary();
  }




  const totalPages = $derived(Math.ceil(total / limit));

  $effect(() => {
    loadLibrary();
    const unsub = onSseEvent((event) => {
      if (['job_completed', 'job_retried', 'job_removed'].includes(event.type as string)) {
        loadLibrary();
      }
    });
    return () => unsub();
  });
</script>

<div class="page">
  <h1 class="page-title">Library</h1>
  <p class="page-subtitle">Browse your completed content</p>

  <!-- Tabs -->
  <div class="tabs">
    <button
      class="tab"
      class:active={activeTab === 'movie'}
      onclick={() => switchTab('movie')}
    >
      Movies {#if activeTab === 'movie'}({total}){/if}
    </button>
    <button
      class="tab"
      class:active={activeTab === 'series'}
      onclick={() => switchTab('series')}
    >
      Series {#if activeTab === 'series'}({total}){/if}
    </button>
  </div>

  {#if loading}
    <div class="card"><p class="text-muted">Loading...</p></div>
  {:else if items.length === 0}
    <div class="card">
      <p class="text-muted">No {activeTab === 'movie' ? 'movies' : 'series'} completed yet.</p>
    </div>
  {:else}
    <!-- Grid -->
    <div class="library-grid">
      {#each items as group}
        <div class="library-card">
          <!-- Poster -->
          <a href="#library-detail/{group.imdb_id}" class="poster-link">
            <div class="poster-container">
              {#if group.poster_url}
                <img src={group.poster_url} alt={group.title || 'Poster'} class="poster" />
              {:else}
                <div class="poster placeholder">
                  {group.media_type === 'movie' ? '🎬' : '📺'}
                </div>
              {/if}
            </div>
            <div class="card-title">{group.title || group.imdb_id}</div>
          </a>

          <!-- Episode count for series -->
          {#if group.media_type === 'series'}
            <div class="episode-count">{group.job_count} episodes</div>
          {/if}

        </div>
      {/each}
    </div>

    <!-- Pagination -->
    {#if totalPages > 1}
      <div class="pagination">
        <button
          class="btn btn-sm"
          disabled={page === 1}
          onclick={() => { page--; loadLibrary(); }}
        >
          ◀ Prev
        </button>
        <span class="page-info">Page {page} of {totalPages}</span>
        <button
          class="btn btn-sm"
          disabled={page === totalPages}
          onclick={() => { page++; loadLibrary(); }}
        >
          Next ▶
        </button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .tabs {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
  }

  .tab {
    padding: 0.5rem 1rem;
    border: 1px solid var(--text-secondary);
    background: #1A1A1A;
    color: var(--text-secondary);
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9rem;
  }

  .tab.active {
    background: var(--surface);
    border-color: var(--primary);
    color: var(--primary);
  }

  .library-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 1rem;
  }

  .library-card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem;
    transition: border-color 0.2s;
  }

  .library-card:hover {
    border-color: var(--primary);
  }
  .poster-link {
    display: block;
    text-decoration: none;
    color: inherit;
  }

  .poster-link:hover {
    color: inherit;
  }

  .poster-container {
    aspect-ratio: 2/3;
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 0.5rem;
  }

  .poster {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .poster.placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-secondary);
    font-size: 2.5rem;
  }

  .card-title {
    font-weight: 600;
    font-size: 0.9rem;
    margin-bottom: 0.25rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .episode-count {
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-bottom: 0.5rem;
  }


  .pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    margin-top: 1.5rem;
    padding: 1rem;
  }

  .page-info {
    color: var(--text-muted);
    font-size: 0.9rem;
  }

</style>
