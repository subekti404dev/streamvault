<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { api } from '../lib/api';
  import { connectSSE, onSseEvent } from '../lib/events';
  import type { Job, JobStatus } from '../lib/types';
  import { statusLabel, statusColor, formatBytes, formatDuration } from '../lib/types';

  let { addToast, navigate }: {
    addToast: (msg: string, type?: string) => void;
    navigate: (e: Event) => void;
  } = $props();

  let processing = $state<Job[]>([]);
  let queued = $state<Job[]>([]);
  let completed = $state<Job[]>([]);
  let failed = $state<Job[]>([]);
  let loading = $state(true);

  async function loadQueue() {
    try {
      const data = await api.getQueue();
      processing = data.processing;
      queued = data.queued;
      completed = data.completed;
      failed = data.failed;
    } catch (e: any) {
      addToast(`Failed to load queue: ${e.message}`, 'error');
    } finally {
      loading = false;
    }
  }

  async function retryJob(id: string) {
    try {
      await api.retryJob(id);
      addToast('Job requeued for retry', 'success');
      loadQueue();
    } catch (e: any) {
      addToast(`Retry failed: ${e.message}`, 'error');
    }
  }

  async function deleteJob(id: string) {
    try {
      await api.deleteJob(id);
      addToast('Job removed', 'info');
      loadQueue();
    } catch (e: any) {
      addToast(`Delete failed: ${e.message}`, 'error');
    }
  }

  $effect(() => {
    loadQueue();
    const unsub = onSseEvent((event) => {
      if (['job_created', 'job_started', 'job_progress', 'job_completed', 'job_failed', 'job_retried', 'job_removed'].includes(event.type as string)) {
        loadQueue();
      }
    });
    return () => unsub();
  });

  function getPhaseProgress(job: Job): { download: number; transcode: number; upload: number } {
    return {
      download: job.progress_pct ?? 0,
      transcode: job.transcode_pct ?? 0,
      upload: job.upload_pct ?? 0,
    };
  }
</script>

<div class="page">
  <h1 class="page-title">Queue</h1>
  <p class="page-subtitle">Real-time job monitoring and management</p>

  {#if loading}
    <div class="glass-card"><p class="text-muted">Loading...</p></div>
  {:else}
    {#if processing.length > 0}
      <h2 class="section-title">Processing</h2>
      {#each processing as job}
        <div class="glass-card job-card">
          <div class="job-header">
            <div>
              <strong>{job.title || job.imdb_id}</strong>
              {#if job.media_type === 'series' && job.season != null && job.episode != null}
                <span class="badge episode-badge">S{String(job.season).padStart(2,'0')}E{String(job.episode).padStart(2,'0')}</span>
              {/if}
              <span class="badge" style="background: rgba(245,158,11,0.2); color: #fbbf24; margin-left:0.5rem;">
                {statusLabel(job.status)}
              </span>
            </div>
          </div>
          <div class="phase-indicator">
            <div class="phase">
              <div class="phase-label">
                <span>Download</span>
                <span>{getPhaseProgress(job).download}%</span>
              </div>
              <div class="progress-bar">
                <div class="progress-fill" style="width:{getPhaseProgress(job).download}%; background:#3b82f6;"></div>
              </div>
            </div>
            <div class="phase-arrow">→</div>
            <div class="phase">
              <div class="phase-label">
                <span>Transcode</span>
                <span>{getPhaseProgress(job).transcode}%</span>
              </div>
              <div class="progress-bar">
                <div class="progress-fill" style="width:{getPhaseProgress(job).transcode}%; background:#8b5cf6;"></div>
              </div>
            </div>
            <div class="phase-arrow">→</div>
            <div class="phase">
              <div class="phase-label">
                <span>Upload</span>
                <span>{getPhaseProgress(job).upload}%</span>
              </div>
              <div class="progress-bar">
                <div class="progress-fill" style="width:{getPhaseProgress(job).upload}%; background:#f97316;"></div>
              </div>
            </div>
          </div>
          <div class="job-footer">
            <span class="text-muted">Added {job.created_at ? new Date(job.created_at).toLocaleString() : ''}</span>
            <a href="#job/{job.id}" onclick={navigate} class="btn btn-sm">Details</a>
          </div>
        </div>
      {/each}
    {/if}

    {#if queued.length > 0}
      <h2 class="section-title">Queued ({queued.length})</h2>
      {#each queued as job, i}
        <div class="glass-card job-card">
          <div class="job-header">
            <div>
              <span class="queue-pos">#{i + 1}</span>
              <strong>{job.title || job.imdb_id}</strong>
              {#if job.media_type === 'series' && job.season != null && job.episode != null}
                <span class="badge episode-badge">S{String(job.season).padStart(2,'0')}E{String(job.episode).padStart(2,'0')}</span>
              {/if}
              {#if job.file_size_bytes}
                <span class="text-muted" style="font-size:0.8rem; margin-left:0.5rem;">{formatBytes(job.file_size_bytes)}</span>
              {/if}
            </div>
            <button class="btn btn-danger btn-sm" onclick={() => deleteJob(job.id)}>Cancel</button>
          </div>
        </div>
      {/each}
    {/if}

    {#if completed.length > 0}
      <h2 class="section-title">Completed ({completed.length})</h2>
      {#each completed as job}
        <div class="glass-card job-card">
          <div class="job-header">
            <div>
              <span class="badge" style="background:rgba(16,185,129,0.2);color:var(--success);">✓</span>
              <strong>{job.title || job.imdb_id}</strong>
              {#if job.media_type === 'series' && job.season != null && job.episode != null}
                <span class="badge episode-badge">S{String(job.season).padStart(2,'0')}E{String(job.episode).padStart(2,'0')}</span>
              {/if}
              {#if job.video_resolution}
                <span class="text-muted" style="font-size:0.8rem; margin-left:0.5rem;">{job.video_resolution}</span>
              {/if}
              {#if job.duration_seconds}
                <span class="text-muted" style="font-size:0.8rem;">{formatDuration(job.duration_seconds)}</span>
              {/if}
            </div>
            <a href="#job/{job.id}" onclick={navigate} class="btn btn-sm">Details</a>
          </div>
        </div>
      {/each}
    {/if}

    {#if failed.length > 0}
      <h2 class="section-title">Failed ({failed.length})</h2>
      {#each failed as job}
        <div class="glass-card job-card" style="border-color:rgba(239,68,68,0.3);">
          <div class="job-header">
            <div>
              <span class="badge" style="background:rgba(239,68,68,0.2);color:var(--danger);">✗</span>
              <strong>{job.title || job.imdb_id}</strong>
              {#if job.error_message}
                <span class="text-muted" style="font-size:0.8rem; margin-left:0.5rem;">{job.error_message}</span>
              {/if}
            </div>
            <div style="display:flex; gap:0.5rem;">
              <button class="btn btn-success btn-sm" onclick={() => retryJob(job.id)}>Retry</button>
              <button class="btn btn-danger btn-sm" onclick={() => deleteJob(job.id)}>Remove</button>
            </div>
          </div>
        </div>
      {/each}
    {/if}

    {#if processing.length === 0 && queued.length === 0 && completed.length === 0 && failed.length === 0}
      <div class="glass-card">
        <p class="text-muted" style="text-align:center; padding:2rem;">No jobs yet. Search for a title and add it to the queue!</p>
      </div>
    {/if}
  {/if}
</div>

<style>
  .page { max-width: 900px; margin: 0 auto; }
  .page-title { font-size: 1.5rem; margin-bottom: 0.25rem; }
  .page-subtitle { color: var(--text-secondary); font-size: 0.875rem; margin-bottom: 1.5rem; }
  .section-title { font-size: 1rem; margin: 1.5rem 0 0.75rem; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.05em; }
  .job-card { padding: 1rem 1.25rem; margin-bottom: 0.5rem; }
  .job-header { display: flex; align-items: center; justify-content: space-between; }
  .phase-indicator { display: flex; align-items: center; gap: 0.75rem; margin-top: 1rem; }
  .phase { flex: 1; }
  .phase-label { display: flex; justify-content: space-between; font-size: 0.75rem; color: var(--text-secondary); margin-bottom: 0.3rem; }
  .phase-arrow { color: var(--text-muted); font-size: 1.2rem; padding-bottom: 0.5rem; }
  .job-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 0.75rem; padding-top: 0.5rem; border-top: 1px solid var(--glass-border); font-size: 0.8rem; }
  .queue-pos { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 50%; background: rgba(99,102,241,0.2); color: var(--accent); font-size: 0.7rem; font-weight: 600; margin-right: 0.4rem; }
  .episode-badge { background: rgba(139,92,246,0.2); color: #a78bfa; margin-left: 0.4rem; }
  .btn-sm { padding: 0.3rem 0.75rem; font-size: 0.8rem; white-space: nowrap; }
  .text-muted { color: var(--text-muted); }
</style>
