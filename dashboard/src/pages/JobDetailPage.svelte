<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import { connectSSE, onSseEvent } from '../lib/events';
  import type { Job, JobEvent } from '../lib/types';
  import { statusLabel, statusColor, formatDuration } from '../lib/types';

  let { id, addToast }: {
    id: string;
    addToast: (msg: string, type?: string) => void;
  } = $props();

  let job = $state<Job | null>(null);
  let events = $state<JobEvent[]>([]);
  let loading = $state(true);

  async function loadJob() {
    try {
      const data = await api.getJob(id);
      job = data.job;
      events = data.events;
    } catch (e: any) {
      addToast(`Failed to load job: ${e.message}`, 'error');
    } finally {
      loading = false;
    }
  }

  async function retryJob() {
    try {
      await api.retryJob(id);
      addToast('Job requeued for retry', 'success');
      loadJob();
    } catch (e: any) {
      addToast(`Retry failed: ${e.message}`, 'error');
    }
  }

  async function deleteJob() {
    try {
      await api.deleteJob(id);
      addToast('Job removed', 'info');
      job = null;
    } catch (e: any) {
      addToast(`Delete failed: ${e.message}`, 'error');
    }
  }

  $effect(() => {
    if (id) loadJob();
    const unsub = onSseEvent((event) => {
      if (event.job_id === id && ['job_progress', 'job_completed', 'job_failed', 'job_retried'].includes(event.type as string)) {
        loadJob();
      }
    });
    return () => unsub();
  });

  function formatTime(t: string | null | undefined): string {
    if (!t) return '-';
    return new Date(t).toLocaleString();
  }

  function eventIcon(type: string): string {
    const icons: Record<string, string> = { status_change: '○', progress: '▶', checkpoint: '💾', error: '✗' };
    return icons[type] || '•';
  }

  function eventColor(type: string): string {
    const colors: Record<string, string> = { status_change: '#6366f1', progress: '#3b82f6', checkpoint: '#10b981', error: '#ef4444' };
    return colors[type] || '#64748b';
  }
</script>

<div class="page">
  <a href="#queue" class="back-link">← Back to Queue</a>

  {#if loading}
    <div class="glass-card"><p class="text-muted">Loading...</p></div>
  {:else if !job}
    <div class="glass-card"><p class="text-muted">Job not found or removed.</p></div>
  {:else}
    <div class="glass-card job-header-card">
      <div class="job-title-row">
        <div>
          <h1>{job.title || job.imdb_id}</h1>
          <div class="job-meta">
            <span class="badge" style="background: rgba(99,102,241,0.2); color: var(--accent);">
              {job.media_type}
            </span>
            {#if job.media_type === 'series' && job.season != null && job.episode != null}
              <span class="badge" style="background: rgba(139,92,246,0.2); color: #a78bfa;">
                S{String(job.season).padStart(2,'0')}E{String(job.episode).padStart(2,'0')}
              </span>
            {/if}
            {#if job.video_resolution}
              <span class="badge" style="background: rgba(16,185,129,0.2); color: var(--success);">{job.video_resolution}</span>
            {/if}
            {#if job.duration_seconds}
              <span class="badge" style="background: rgba(245,158,11,0.2); color: #fbbf24;">{formatDuration(job.duration_seconds)}</span>
            {/if}
          </div>
        </div>
        <span class="status-badge" style="background: {statusColor(job.status)}20; color: {statusColor(job.status)};">
          {statusLabel(job.status)}
        </span>
      </div>
    </div>

    {#if job.status === 'failed'}
      <div class="glass-card error-card">
        <h3>Error Details</h3>
        <p>{job.error_message || 'Unknown error'}</p>
        <div style="margin-top:0.75rem;">
          <p class="text-muted" style="font-size:0.8rem;">
            Last checkpoint: {job.last_checkpoint || 'None'} &mdash; 
            Will resume from this point on retry.
          </p>
          <button class="btn btn-success" onclick={retryJob}>Retry from Checkpoint</button>
          <button class="btn btn-danger" onclick={deleteJob} style="margin-left:0.5rem;">Remove</button>
        </div>
      </div>
    {/if}

    {#if ['processing','downloading','transcoding','uploading','checkpoint_download','checkpoint_transcode'].includes(job.status)}
      <div class="glass-card">
        <h3>Progress</h3>
        <div class="phase-block">
          <div class="phase-row">
            <span>Download</span>
            <div class="progress-bar"><div class="progress-fill" style="width:{job.progress_pct ?? 0}%; background:#3b82f6;"></div></div>
            <span>{job.progress_pct ?? 0}%</span>
          </div>
          <div class="phase-row">
            <span>Transcode</span>
            <div class="progress-bar"><div class="progress-fill" style="width:{job.transcode_pct ?? 0}%; background:#8b5cf6;"></div></div>
            <span>{job.transcode_pct ?? 0}%</span>
          </div>
          <div class="phase-row">
            <span>Upload</span>
            <div class="progress-bar"><div class="progress-fill" style="width:{job.upload_pct ?? 0}%; background:#f97316;"></div></div>
            <span>{job.upload_pct ?? 0}%</span>
          </div>
        </div>
      </div>
    {/if}

    <div class="glass-card">
      <h3>Details</h3>
      <div class="detail-grid">
        <div><span class="detail-label">IMDB ID</span><span>{job.imdb_id}</span></div>
        <div><span class="detail-label">Status</span><span>{statusLabel(job.status)}</span></div>
        <div><span class="detail-label">Created</span><span>{formatTime(job.created_at)}</span></div>
        <div><span class="detail-label">Started</span><span>{formatTime(job.started_at)}</span></div>
        <div><span class="detail-label">Completed</span><span>{formatTime(job.completed_at)}</span></div>
        <div><span class="detail-label">Checkpoint</span><span>{job.last_checkpoint || 'None'}</span></div>
        {#if job.file_size_bytes}
          <div><span class="detail-label">Size</span><span>{(job.file_size_bytes / 1e9).toFixed(2)} GB</span></div>
        {/if}
      </div>
    </div>

    <div class="glass-card">
      <h3>Event Timeline</h3>
      {#if events.length === 0}
        <p class="text-muted">No events yet.</p>
      {:else}
        <div class="timeline">
          {#each events as event}
            <div class="timeline-item">
              <div class="timeline-dot" style="background:{eventColor(event.event_type)};"></div>
              <div class="timeline-content">
                <div class="timeline-header">
                  <span class="timeline-event" style="color:{eventColor(event.event_type)};">
                    {eventIcon(event.event_type)} {event.event_type}
                  </span>
                  <span class="timeline-time">{formatTime(event.created_at)}</span>
                </div>
                {#if event.message}
                  <p class="timeline-message">{event.message}</p>
                {/if}
                {#if event.progress_pct != null}
                  <div class="progress-bar" style="margin-top:0.3rem; max-width:200px;">
                    <div class="progress-fill" style="width:{event.progress_pct}%;"></div>
                  </div>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .page { max-width: 800px; margin: 0 auto; }
  .back-link { color: var(--text-secondary); text-decoration: none; font-size: 0.875rem; display: inline-block; margin-bottom: 1rem; }
  .back-link:hover { color: var(--text-primary); }
  .glass-card { padding: 1.25rem; margin-bottom: 1rem; }

  .job-title-row { display: flex; justify-content: space-between; align-items: flex-start; }
  .job-title-row h1 { font-size: 1.3rem; margin-bottom: 0.5rem; }
  .job-meta { display: flex; gap: 0.4rem; flex-wrap: wrap; }
  .status-badge { padding: 0.3rem 0.75rem; border-radius: 999px; font-size: 0.8rem; font-weight: 600; white-space: nowrap; }
  .error-card { border-color: rgba(239,68,68,0.3); }
  .error-card h3 { color: var(--danger); margin-bottom: 0.5rem; }
  .phase-block { display: flex; flex-direction: column; gap: 0.75rem; margin-top: 0.75rem; }
  .phase-row { display: flex; align-items: center; gap: 0.75rem; font-size: 0.85rem; }
  .phase-row span:first-child { min-width: 80px; color: var(--text-secondary); }
  .phase-row .progress-bar { flex: 1; }
  .phase-row span:last-child { min-width: 40px; text-align: right; color: var(--text-secondary); }
  .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-top: 0.75rem; }
  .detail-grid > div { display: flex; flex-direction: column; gap: 0.15rem; }
  .detail-label { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .timeline { position: relative; margin-top: 0.75rem; padding-left: 1rem; }
  .timeline-item { display: flex; gap: 0.75rem; padding-bottom: 1rem; position: relative; }
  .timeline-item:last-child { padding-bottom: 0; }
  .timeline-dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 4px; flex-shrink: 0; }
  .timeline-content { flex: 1; }
  .timeline-header { display: flex; justify-content: space-between; }
  .timeline-event { font-size: 0.8rem; font-weight: 500; }
  .timeline-time { font-size: 0.75rem; color: var(--text-muted); }
  .timeline-message { font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.15rem; }
  .text-muted { color: var(--text-muted); }
</style>
