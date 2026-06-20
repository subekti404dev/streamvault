<script lang="ts">
  import { api } from '../lib/api';
  import { onSseEvent } from '../lib/events';
  import type { Job } from '../lib/types';
  import { statusLabel, formatBytes, formatDuration } from '../lib/types';

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
      if (['job_created', 'job_started', 'job_progress', 'job_checkpoint', 'job_completed', 'job_failed', 'job_retried', 'job_removed'].includes(event.type as string)) {
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
    <div class="card"><p class="text-muted">Loading...</p></div>
  {:else}
    {#if processing.length > 0}
      <h2 class="section-title">Processing</h2>
      {#each processing as job}
        <div class="job-card" style="border-left-color: #00E5A0;">
          <div class="job-header">
            <div>
              <strong>{job.title || job.imdb_id}</strong>
              {#if job.media_type === 'series' && job.season != null && job.episode != null}
                <span class="badge episode-badge">S{String(job.season).padStart(2,'0')}E{String(job.episode).padStart(2,'0')}</span>
              {/if}
              <span class="badge">
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
            <div style="display:flex; gap:0.5rem;">
              <a href="#job/{job.id}" onclick={navigate} class="btn btn-sm">Details</a>
              <button class="btn btn-sm btn-danger" onclick={() => deleteJob(job.id)}>Cancel</button>
            </div>
          </div>
        </div>
      {/each}
    {/if}

    {#if queued.length > 0}
      <h2 class="section-title">Queued ({queued.length})</h2>
      {#each queued as job, i}
        <div class="job-card" style="border-left-color: #F5C518;">
          <div class="job-header">
            <div>
              <span class="queue-pos">#{i + 1}</span>
              <strong>{job.title || job.imdb_id}</strong>
              {#if job.media_type === 'series' && job.season != null && job.episode != null}
                <span class="badge episode-badge">S{String(job.season).padStart(2,'0')}E{String(job.episode).padStart(2,'0')}</span>
              {/if}
              {#if job.file_size_bytes}
                <span class="text-muted">{formatBytes(job.file_size_bytes)}</span>
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
        <div class="job-card" style="border-left-color: #4488FF;">
          <div class="job-header">
            <div>
              <span class="badge">✓</span>
              <strong>{job.title || job.imdb_id}</strong>
              {#if job.media_type === 'series' && job.season != null && job.episode != null}
                <span class="badge episode-badge">S{String(job.season).padStart(2,'0')}E{String(job.episode).padStart(2,'0')}</span>
              {/if}
              {#if job.video_resolution}
                <span class="text-muted">{job.video_resolution}</span>
              {/if}
              {#if job.duration_seconds}
                <span class="text-muted">{formatDuration(job.duration_seconds)}</span>
              {/if}
            </div>
          </div>
          <div style="display:flex; gap:0.5rem;">
            <a href="#job/{job.id}" onclick={navigate} class="btn btn-sm">Details</a>
            <a
              href="/proxy/hls/{job.id}/master.m3u8"
              target="_blank"
              class="btn btn-sm btn-primary"
              title="Open HLS stream"
            >▶ Play</a>
            <button class="btn btn-sm btn-danger" onclick={() => deleteJob(job.id)}>Delete</button>
          </div>
        </div>
      {/each}
    {/if}

    {#if failed.length > 0}
      <h2 class="section-title">Failed ({failed.length})</h2>
      {#each failed as job}
        <div class="job-card failed">
          <div class="job-header">
            <div>
              <span class="badge">✗</span>
              <strong>{job.title || job.imdb_id}</strong>
              {#if job.error_message}
                <span class="text-muted">{job.error_message}</span>
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
      <div class="card">
        <p class="text-muted">No jobs yet. Search for a title and add it to the queue!</p>
      </div>
    {/if}
  {/if}
</div>

<style>
  .page { max-width: 900px; margin: 0 auto; }

  .page-title {
    font-family: 'JetBrains Mono', monospace;
    font-weight: 700; font-size: 1.25rem; margin-bottom: 0.25rem;
  }

  .page-subtitle {
    color: var(--text-secondary); font-size: 0.875rem; margin-bottom: 1.5rem;
  }

  .section-title {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem; font-weight: 600;
    margin: 1.5rem 0 0.75rem;
    color: var(--text-secondary);
    text-transform: uppercase; letter-spacing: 0.05em;
  }

  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 1.25rem; margin-bottom: 1rem;
  }

  .job-card {
    background: var(--surface); border: 1px solid var(--border);
    border-left: 3px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem 1.25rem; margin-bottom: 0.5rem;
  }

  .job-card.failed {
    border-color: var(--danger); border-left-color: var(--danger);
  }

  .job-header {
    display: flex; align-items: center; justify-content: space-between;
  }

  .job-header strong {
    font-family: 'JetBrains Mono', monospace; font-size: 0.9rem;
  }

  .phase-indicator {
    display: flex; align-items: center; gap: 0.75rem; margin-top: 1rem;
  }

  .phase { flex: 1; }

  .phase-label {
    display: flex; justify-content: space-between;
    font-family: 'JetBrains Mono', monospace; font-size: 0.7rem;
    color: var(--text-secondary); margin-bottom: 0.3rem;
  }

  .phase-arrow {
    color: var(--text-muted); font-size: 1rem; padding-bottom: 0.5rem;
  }

  .job-footer {
    display: flex; justify-content: space-between; align-items: center;
    margin-top: 0.75rem; padding-top: 0.5rem;
    border-top: 1px solid var(--border);
    font-size: 0.8rem; color: var(--text-muted);
  }

  .queue-pos {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px;
    border: 1px solid var(--accent); border-radius: var(--radius-sm);
    color: var(--accent);
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem; font-weight: 600;
    margin-right: 0.4rem;
  }

  .episode-badge {
    border-color: #555555; color: var(--text-secondary); margin-left: 0.4rem;
  }

  @media (max-width: 639px) {
    .job-footer {
      flex-direction: column; gap: 0.5rem; align-items: flex-start;
    }
  }
</style>
