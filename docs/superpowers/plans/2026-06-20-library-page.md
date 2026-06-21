# Library Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tambah halaman Library untuk browse, putar, dan manage content yang sudah selesai di-transcode.

**Architecture:** Backend API baru `GET /api/v1/library` dan `POST /api/v1/library/{job_id}/requeue`. Frontend Svelte page dengan tabs Movies/Series, poster grid, expandable episodes, dan pagination.

**Tech Stack:** Rust/Axum, Svelte 5, SQLite

---

## File Structure

### Backend (New/Modified)
- `backend/src/api/library.rs` — NEW: library handlers
- `backend/src/api/mod.rs` — MODIFY: add library module
- `backend/src/db/queries.rs` — MODIFY: add library queries
- `backend/src/app.rs` — MODIFY: add library routes

### Frontend (New/Modified)
- `dashboard/src/pages/LibraryPage.svelte` — NEW: library page
- `dashboard/src/App.svelte` — MODIFY: add route + nav
- `dashboard/src/lib/api.ts` — MODIFY: add API methods
- `dashboard/src/lib/types.ts` — MODIFY: add types

---

### Task 1: Backend - Database Queries

**Files:**
- Modify: `backend/src/db/queries.rs`

- [ ] **Step 1: Add LibraryItem struct**

```rust
// Add after existing structs (around line 112)

#[derive(Debug, Serialize)]
pub struct LibraryJob {
    pub id: String,
    pub title: Option<String>,
    pub season: Option<i32>,
    pub episode: Option<i32>,
    pub status: String,
    pub video_resolution: Option<String>,
    pub duration_seconds: Option<f64>,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
pub struct LibraryGroup {
    pub imdb_id: String,
    pub title: Option<String>,
    pub poster_url: Option<String>,
    pub media_type: String,
    pub job_count: i64,
    pub jobs: Vec<LibraryJob>,
}

#[derive(Debug, Serialize)]
pub struct LibraryResponse {
    pub items: Vec<LibraryGroup>,
    pub total: i64,
    pub page: i64,
    pub limit: i64,
}
```

- [ ] **Step 2: Add library queries**

```rust
// Add after existing job queries (around line 255)

pub async fn get_completed_jobs_grouped(
    pool: &SqlitePool,
    media_type: Option<&str>,
    page: i64,
    limit: i64,
) -> AppResult<LibraryResponse> {
    let offset = (page - 1) * limit;

    // Get total count
    let total = if let Some(mt) = media_type {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(DISTINCT imdb_id) FROM jobs WHERE status = 'completed' AND media_type = ?"
        )
        .bind(mt)
        .fetch_one(pool)
        .await?
    } else {
        sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(DISTINCT imdb_id) FROM jobs WHERE status = 'completed'"
        )
        .fetch_one(pool)
        .await?
    };

    // Get grouped items
    let groups = if let Some(mt) = media_type {
        sqlx::query_as::<_, (String, Option<String>, Option<String>, String, i64)>(
            r#"
            SELECT j.imdb_id, j.title, j.poster_url, j.media_type, COUNT(*) as job_count
            FROM jobs j
            WHERE j.status = 'completed' AND j.media_type = ?
            GROUP BY j.imdb_id
            ORDER BY j.title
            LIMIT ? OFFSET ?
            "#
        )
        .bind(mt)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as::<_, (String, Option<String>, Option<String>, String, i64)>(
            r#"
            SELECT j.imdb_id, j.title, j.poster_url, j.media_type, COUNT(*) as job_count
            FROM jobs j
            WHERE j.status = 'completed'
            GROUP BY j.imdb_id
            ORDER BY j.title
            LIMIT ? OFFSET ?
            "#
        )
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await?
    };

    let mut items = Vec::new();
    for (imdb_id, title, poster_url, media_type, job_count) in groups {
        // Get all jobs for this imdb_id
        let jobs = sqlx::query_as::<_, LibraryJob>(
            r#"
            SELECT id, title, season, episode, status, video_resolution, duration_seconds, created_at
            FROM jobs
            WHERE imdb_id = ? AND status = 'completed'
            ORDER BY season, episode
            "#
        )
        .bind(&imdb_id)
        .fetch_all(pool)
        .await?;

        // Fallback poster from cinemeta_cache
        let final_poster = if poster_url.is_some() {
            poster_url
        } else {
            sqlx::query_scalar::<_, Option<String>>(
                "SELECT poster_url FROM cinemeta_cache WHERE imdb_id = ? AND media_type = ?"
            )
            .bind(&imdb_id)
            .bind(&media_type)
            .fetch_optional(pool)
            .await?
            .flatten()
        };

        items.push(LibraryGroup {
            imdb_id,
            title,
            poster_url: final_poster,
            media_type,
            job_count,
            jobs,
        });
    }

    Ok(LibraryResponse { items, total, page, limit })
}

pub async fn requeue_job(pool: &SqlitePool, job_id: &str) -> AppResult<()> {
    sqlx::query("UPDATE jobs SET status = 'queued', updated_at = datetime('now') WHERE id = ?")
        .bind(job_id)
        .execute(pool)
        .await?;
    Ok(())
}
```

- [ ] **Step 3: Run cargo check**

Run: `cd backend && cargo check`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
cd backend && git add src/db/queries.rs && git commit -m "feat: add library queries"
```

---

### Task 2: Backend - Library API Handlers

**Files:**
- Create: `backend/src/api/library.rs`
- Modify: `backend/src/api/mod.rs`

- [ ] **Step 1: Create library.rs**

```rust
// backend/src/api/library.rs

use axum::{Json, extract::{State, Path, Query}};
use serde::Deserialize;
use std::sync::Arc;
use crate::{app::AppState, db::queries, error::AppResult};

#[derive(Debug, Deserialize)]
pub struct LibraryQuery {
    pub page: Option<i64>,
    pub limit: Option<i64>,
    pub r#type: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct RequeueResponse {
    pub job_id: String,
    pub status: String,
}

use serde::Serialize;

pub async fn list_library(
    State(state): State<Arc<AppState>>,
    Query(params): Query<LibraryQuery>,
) -> AppResult<Json<queries::LibraryResponse>> {
    let page = params.page.unwrap_or(1).max(1);
    let limit = params.limit.unwrap_or(20).min(100);
    let media_type = params.r#type.as_deref();

    let response = queries::get_completed_jobs_grouped(&state.db, media_type, page, limit).await?;
    Ok(Json(response))
}

pub async fn requeue_job(
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
) -> AppResult<Json<RequeueResponse>> {
    queries::requeue_job(&state.db, &job_id).await?;

    Ok(Json(RequeueResponse {
        job_id,
        status: "queued".to_string(),
    }))
}
```

- [ ] **Step 2: Update mod.rs**

```rust
// backend/src/api/mod.rs - add library module

pub mod auth;
pub mod callbacks;
pub mod events;
pub mod library;  // ADD THIS
pub mod queue;
pub mod search;
pub mod settings;
pub mod torrent;
```

- [ ] **Step 3: Run cargo check**

Run: `cd backend && cargo check`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
cd backend && git add src/api/library.rs src/api/mod.rs && git commit -m "feat: add library API handlers"
```

---

### Task 3: Backend - Library Routes

**Files:**
- Modify: `backend/src/app.rs`

- [ ] **Step 1: Add library routes**

```rust
// Find the Router section and add library routes
// Around line 50-80 in app.rs

let api = Router::new()
    .route("/auth/verify", post(api::auth::verify_token))
    .route("/settings", get(api::settings::get_settings).put(api::settings::update_settings))
    .route("/search/{imdb_id}", get(api::search::search_imdb))
    .route("/torrent/inspect", post(api::torrent::inspect_torrent))
    .route("/torrent/add", post(api::torrent::add_torrent))
    .route("/queue", get(api::queue::list_jobs).post(api::queue::create_job))
    .route("/queue/{id}", get(api::queue::get_job).delete(api::queue::delete_job))
    .route("/queue/{id}/retry", post(api::queue::retry_job))
    .route("/events", get(api::events::events_handler))
    .route("/callbacks/discord", post(api::callbacks::discord_callback))
    // ADD THESE:
    .route("/library", get(api::library::list_library))
    .route("/library/{job_id}/requeue", post(api::library::requeue_job))
    .route("/telegram/test", post(api::settings::test_telegram_notification))
    .layer(CorsLayer::permissive())
    .with_state(state);
```

- [ ] **Step 2: Run cargo check**

Run: `cd backend && cargo check`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd backend && git add src/app.rs && git commit -m "feat: add library routes"
```

---

### Task 4: Frontend - Types & API

**Files:**
- Modify: `dashboard/src/lib/types.ts`
- Modify: `dashboard/src/lib/api.ts`

- [ ] **Step 1: Add library types**

```typescript
// dashboard/src/lib/types.ts - add after JobDetail interface

export interface LibraryJob {
  id: string;
  title: string | null;
  season: number | null;
  episode: number | null;
  status: string;
  video_resolution: string | null;
  duration_seconds: number | null;
  created_at: string;
}

export interface LibraryGroup {
  imdb_id: string;
  title: string | null;
  poster_url: string | null;
  media_type: string;
  job_count: number;
  jobs: LibraryJob[];
}

export interface LibraryResponse {
  items: LibraryGroup[];
  total: number;
  page: number;
  limit: number;
}
```

- [ ] **Step 2: Add API methods**

```typescript
// dashboard/src/lib/api.ts - add to api object

getLibrary: async (type?: string, page?: number, limit?: number): Promise<LibraryResponse> => {
  const params = new URLSearchParams();
  if (type) params.set('type', type);
  if (page) params.set('page', page.toString());
  if (limit) params.set('limit', limit.toString());
  const qs = params.toString();
  return handleResponse<LibraryResponse>(
    await fetch(`${BASE}/library${qs ? '?' + qs : ''}`, { headers: headers() })
  );
},

requeueJob: async (jobId: string): Promise<{ job_id: string; status: string }> => {
  return handleResponse(
    await fetch(`${BASE}/library/${jobId}/requeue`, {
      method: 'POST',
      headers: headers()
    })
  );
},
```

- [ ] **Step 3: Import types in api.ts**

```typescript
// dashboard/src/lib/api.ts - update import
import type { SearchResult, QueueList, JobDetail, AppSettings, StremioCatalogResponse, StremioMetaResponse, LibraryResponse } from './types';
```

- [ ] **Step 4: Commit**

```bash
cd dashboard && git add src/lib/types.ts src/lib/api.ts && git commit -m "feat: add library types and API methods"
```

---

### Task 5: Frontend - Library Page Component

**Files:**
- Create: `dashboard/src/pages/LibraryPage.svelte`

- [ ] **Step 1: Create LibraryPage.svelte**

```svelte
<script lang="ts">
  import { api } from '../lib/api';
  import type { LibraryGroup, LibraryJob } from '../lib/types';
  import { formatDuration } from '../lib/types';

  let { addToast, navigate }: {
    addToast: (msg: string, type?: string) => void;
    navigate: (e: Event) => void;
  } = $props();

  let activeTab = $state<'movie' | 'series'>('movie');
  let items = $state<LibraryGroup[]>([]);
  let total = $state(0);
  let page = $state(1);
  let limit = 20;
  let loading = $state(true);
  let expandedSeries = $state<Set<string>>(new Set());

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
    expandedSeries.clear();
    loadLibrary();
  }

  function toggleExpand(imdbId: string) {
    if (expandedSeries.has(imdbId)) {
      expandedSeries.delete(imdbId);
    } else {
      expandedSeries.add(imdbId);
    }
    expandedSeries = expandedSeries; // trigger reactivity
  }

  async function requeueJob(jobId: string) {
    try {
      await api.requeueJob(jobId);
      addToast('Job requeued for retranscode', 'success');
      loadLibrary();
    } catch (e: any) {
      addToast(`Requeue failed: ${e.message}`, 'error');
    }
  }

  async function deleteJob(jobId: string) {
    try {
      await api.deleteJob(jobId);
      addToast('Job deleted', 'info');
      loadLibrary();
    } catch (e: any) {
      addToast(`Delete failed: ${e.message}`, 'error');
    }
  }

  const totalPages = $derived(Math.ceil(total / limit));

  $effect(() => {
    loadLibrary();
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
      Movies ({total})
    </button>
    <button
      class="tab"
      class:active={activeTab === 'series'}
      onclick={() => switchTab('series')}
    >
      Series ({total})
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
          <div class="poster-container">
            {#if group.poster_url}
              <img src={group.poster_url} alt={group.title || 'Poster'} class="poster" />
            {:else}
              <div class="poster placeholder">
                {group.media_type === 'movie' ? '🎬' : '📺'}
              </div>
            {/if}
          </div>

          <!-- Title -->
          <div class="card-title">{group.title || group.imdb_id}</div>

          <!-- Episode count for series -->
          {#if group.media_type === 'series'}
            <div class="episode-count">{group.job_count} episodes</div>
          {/if}

          <!-- Actions -->
          <div class="card-actions">
            {#if group.media_type === 'movie'}
              <!-- Movie actions -->
              <a
                href="/proxy/hls/{group.jobs[0]?.id}/master.m3u8"
                target="_blank"
                class="btn btn-sm btn-primary"
              >
                ▶ Play
              </a>
              <button
                class="btn btn-sm"
                onclick={() => requeueJob(group.jobs[0]?.id)}
              >
                ↻ Retranscode
              </button>
              <button
                class="btn btn-sm btn-danger"
                onclick={() => deleteJob(group.jobs[0]?.id)}
              >
                ✗ Delete
              </button>
            {:else}
              <!-- Series actions -->
              <button
                class="btn btn-sm"
                onclick={() => toggleExpand(group.imdb_id)}
              >
                {expandedSeries.has(group.imdb_id) ? '▴ Collapse' : '▾ Episodes'}
              </button>
              <button
                class="btn btn-sm btn-danger"
                onclick={() => {
                  for (const job of group.jobs) {
                    deleteJob(job.id);
                  }
                }}
              >
                ✗ Delete All
              </button>
            {/if}
          </div>

          <!-- Expanded Episodes -->
          {#if group.media_type === 'series' && expandedSeries.has(group.imdb_id)}
            <div class="episodes-list">
              {#each group.jobs as job}
                <div class="episode-row">
                  <span class="episode-badge">
                    S{String(job.season ?? 0).padStart(2, '0')}E{String(job.episode ?? 0).padStart(2, '0')}
                  </span>
                  <span class="episode-info">
                    {job.video_resolution || 'N/A'}
                    {#if job.duration_seconds}
                      · {formatDuration(job.duration_seconds)}
                    {/if}
                  </span>
                  <div class="episode-actions">
                    <a
                      href="/proxy/hls/{job.id}/master.m3u8"
                      target="_blank"
                      class="btn btn-xs btn-primary"
                    >
                      ▶
                    </a>
                    <button
                      class="btn btn-xs"
                      onclick={() => requeueJob(job.id)}
                    >
                      ↻
                    </button>
                    <button
                      class="btn btn-xs btn-danger"
                      onclick={() => deleteJob(job.id)}
                    >
                      ✗
                    </button>
                  </div>
                </div>
              {/each}
            </div>
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
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text);
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9rem;
  }

  .tab.active {
    background: var(--primary);
    border-color: var(--primary);
    color: #000;
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

  .card-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
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

  .episodes-list {
    margin-top: 0.75rem;
    border-top: 1px solid var(--border);
    padding-top: 0.75rem;
  }

  .episode-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0;
    font-size: 0.85rem;
  }

  .episode-badge {
    font-family: monospace;
    color: var(--primary);
    min-width: 60px;
  }

  .episode-info {
    flex: 1;
    color: var(--text-muted);
    font-size: 0.8rem;
  }

  .episode-actions {
    display: flex;
    gap: 0.25rem;
  }
</style>
```

- [ ] **Step 2: Commit**

```bash
cd dashboard && git add src/pages/LibraryPage.svelte && git commit -m "feat: add LibraryPage component"
```

---

### Task 6: Frontend - Routing & Navigation

**Files:**
- Modify: `dashboard/src/App.svelte`

- [ ] **Step 1: Import LibraryPage**

```typescript
// Add import at top (around line 4)
import LibraryPage from './pages/LibraryPage.svelte';
```

- [ ] **Step 2: Add route in main content**

```svelte
<!-- Add route after queue route (around line 160) -->
{:else if currentRoute === 'library'}
  <LibraryPage {addToast} {navigate} />
```

- [ ] **Step 3: Add drawer link**

```svelte
<!-- Add after queue link in drawer (around line 145) -->
<a href="#library" onclick={navigate} class="drawer-link">
  <span>📚</span> Library
</a>
```

- [ ] **Step 4: Add navbar icon button**

```svelte
<!-- Add after queue icon button in navbar (around line 120) -->
<button
  class="nav-icon"
  class:active={currentRoute === 'library'}
  onclick={() => { currentRoute = 'library'; history.replaceState(null, '', '#library'); }}
  title="Library"
>
  📚
</button>
```

- [ ] **Step 5: Commit**

```bash
cd dashboard && git add src/App.svelte && git commit -m "feat: add library route and navigation"
```

---

### Task 7: Smoke Test

- [ ] **Step 1: Build backend**

Run: `cd backend && cargo build`
Expected: No errors

- [ ] **Step 2: Build frontend**

Run: `cd dashboard && npm run build`
Expected: No errors

- [ ] **Step 3: Manual test**

1. Start backend: `cd backend && cargo run`
2. Start frontend: `cd dashboard && npm run dev`
3. Open browser → login → click Library icon
4. Verify: tabs work, grid shows, pagination works
5. Test: expand series → episodes show
6. Test: requeue → job status changes to queued
7. Test: delete → job removed

- [ ] **Step 4: Final commit**

```bash
git add -A && git commit -m "feat: library page complete"
```

---

## Summary

| Task | Description | Est. Time |
|------|-------------|-----------|
| 1 | Backend DB queries | 15 min |
| 2 | Backend API handlers | 10 min |
| 3 | Backend routes | 5 min |
| 4 | Frontend types & API | 10 min |
| 5 | Frontend page component | 30 min |
| 6 | Frontend routing & nav | 10 min |
| 7 | Smoke test | 10 min |
| **Total** | | **~90 min** |
