<script lang="ts">
  import { api } from '../lib/api';
  import { onSseEvent } from '../lib/events';
  import type { Job, JobEvent } from '../lib/types';
  import { statusLabel, statusColor, formatDuration } from '../lib/types';

  let { id, addToast, navigate }: {
    id: string;
    addToast: (msg: string, type?: string) => void;
    navigate: (e: Event) => void;
  } = $props();

  let job = $state<Job | null>(null);
  let events = $state<JobEvent[]>([]);
  let loading = $state(true);
  let ghRepo = $state<string | null>(null);

  async function loadJob() {
    try {
      const data = await api.getJob(id);
      job = data.job;
      events = data.events;
      ghRepo = data.gh_repo ?? null;
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

  const activeStatuses = new Set([
    'processing', 'downloading', 'checkpoint_download',
    'transcoding', 'checkpoint_transcode', 'uploading',
  ]);

  function isActiveStatus(status: string): boolean {
    return activeStatuses.has(status);
  }

  function githubRunUrl(): string | null {
    if (!job?.gh_run_id || job.gh_run_id === 'pending' || !ghRepo) return null;
    return `https://github.com/${ghRepo}/actions/runs/${job.gh_run_id}`;
  }

  function eventLabel(type: string): string {
    const labels: Record<string, string> = {
      status_change: 'Status',
      progress: 'Progress',
      checkpoint: 'Checkpoint',
      error: 'Error',
    };
    return labels[type] || type.replace(/_/g, ' ');
  }

  function eventMessage(event: JobEvent): string {
    const message = (event.message ?? '').trim().replace(/\s+/g, ' ');
    if (!message) return '';
    return message.length > 180 ? `${message.slice(0, 180)}…` : message;
  }

  function eventIcon(type: string): string {
    const icons: Record<string, string> = { status_change: '●', progress: '▶', checkpoint: '■', error: '✗' };
    return icons[type] || '•';
  }

  function eventColor(type: string): string {
    const colors: Record<string, string> = { status_change: '#6366f1', progress: '#3b82f6', checkpoint: '#10b981', error: '#ef4444' };
    return colors[type] || '#64748b';
  }
</script>

<div class="page">
  <a href="#queue" onclick={navigate} class="back-link">← Back to Queue</a>

  {#if loading}
    <div class="card"><p class="text-muted">Loading...</p></div>
  {:else if !job}
    <div class="card"><p class="text-muted">Job not found or removed.</p></div>
  {:else}
    <div class="card">
      <div class="job-title-row">
        <div>
          <h1>{job.title || job.imdb_id}</h1>
          <div class="job-meta">
            <span class="badge">
              {job.media_type}
            </span>
            {#if job.media_type === 'series' && job.season != null && job.episode != null}
              <span class="badge">
                S{String(job.season).padStart(2,'0')}E{String(job.episode).padStart(2,'0')}
              </span>
            {/if}
            {#if job.video_resolution}
              <span class="badge">{job.video_resolution}</span>
            {/if}
            {#if job.duration_seconds}
              <span class="badge">{formatDuration(job.duration_seconds)}</span>
            {/if}
          </div>
        </div>
        <span class="status-badge" style="background: {statusColor(job.status)}20; color: {statusColor(job.status)};">
          {statusLabel(job.status)}
        </span>
      </div>
    </div>

    {#if job.status === 'completed'}
      <div class="card stream-card">
        <h3>Stream URL</h3>
        <div class="stream-url-box">
          <code>{window.location.origin}/proxy/hls/{job.id}/master.m3u8</code>
          <button
            class="btn btn-sm btn-primary"
            onclick={() => {
              navigator.clipboard.writeText(`${window.location.origin}/proxy/hls/${job!.id}/master.m3u8`);
              addToast('HLS URL copied!', 'success');
            }}
          >
            Copy
          </button>
        </div>
        <p class="text-muted mt-2" style="font-size:0.8rem;">
          Use this URL in any HLS player, or find this title in Stremio with the StreamVault addon installed.
        </p>
      </div>
    {/if}

    {#if job.status === 'failed'}
      <div class="card error-card">
        <h3>Error Details</h3>
        <p>{job.error_message || 'Unknown error'}</p>
        <div class="mt-3">
          {#if job.last_checkpoint}
            <p class="text-muted" style="font-size:0.8rem;">
              Last checkpoint: {job.last_checkpoint}
            </p>
            <p class="text-muted mt-1" style="font-size:0.8rem;">
              Resume from checkpoint -&gt;
              {#if job.last_checkpoint === 'transcode'}
                Skip download &amp; transcode, langsung upload
              {:else}
                Skip download, lanjut transcode
              {/if}
            </p>
          {:else}
            <p class="text-muted" style="font-size:0.8rem;">
              No checkpoint available — will process from start.
            </p>
          {/if}
          <button class="btn btn-success mt-2" onclick={retryJob}>
            Resume from Checkpoint
          </button>
          <button class="btn btn-danger ml-2" onclick={deleteJob}>Remove</button>
        </div>
      </div>
    {/if}

    {#if isActiveStatus(job.status)}
      <div class="card">
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
      {#if job.gh_run_id}
        <div class="ci-card">
          <span class="ci-label">GitHub Actions</span>
          {#if job.gh_run_id === 'pending'}
            <span class="text-muted">CI run is being created…</span>
          {:else if ghRepo}
            <a href={githubRunUrl()} target="_blank" rel="noreferrer" class="ci-link">Open CI run ↗</a>
          {:else}
            <span class="text-muted">GitHub repo not configured</span>
          {/if}
        </div>
      {/if}
    {/if}
    <div class="card">
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
    <div class="card">
      <h3 class="card-title">Logs &amp; Events</h3>
      {#if events.length === 0}
        <p class="text-muted">No logs yet.</p>
      {:else}
        <div class="terminal-log">
          {#each events as event}
            <div class="log-line">
              <span class="log-time">{formatTime(event.created_at)}</span>
              <span class="log-event" style="color:{eventColor(event.event_type)};">
                [{eventLabel(event.event_type)}]
              </span>
              {#if eventMessage(event)}
                <span>{eventMessage(event)}</span>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
<style>
.page { max-width: 900px; margin: 0 auto; }

.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1.25rem; margin-bottom: 1rem;
}

.card-title {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.85rem; font-weight: 600; margin-bottom: 0.75rem;
  color: var(--text-primary);
}

.back-link {
  display: inline-block; font-family: 'JetBrains Mono', monospace;
  font-size: 0.85rem; color: var(--text-secondary); text-decoration: none; margin-bottom: 1rem;
}
.back-link:hover { color: var(--accent); }

.job-title-row { display: flex; justify-content: space-between; align-items: flex-start; }
.job-title-row h1 { font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 1.3rem; margin-bottom: 0.5rem; }
.job-meta { display: flex; gap: 0.4rem; flex-wrap: wrap; }

.status-badge {
  padding: 0.3rem 0.75rem; border: 1px solid var(--border); border-radius: var(--radius-sm);
  font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; font-weight: 600; white-space: nowrap;
}

.stream-card { border-color: var(--success); }
.stream-card h3 { color: var(--success); margin-bottom: 0.75rem; }

.stream-url-box { display: flex; align-items: center; gap: 0.5rem; }
.stream-url-box code {
  flex: 1; background: var(--bg-primary); padding: 0.5rem 0.75rem;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  font-family: 'JetBrains Mono', monospace; font-size: 0.8rem;
  color: var(--text-primary); word-break: break-all;
}

.error-card { border-color: var(--danger); }
.error-card h3 { color: var(--danger); margin-bottom: 0.5rem; }

.phase-block { display: flex; flex-direction: column; gap: 0.75rem; margin-top: 0.75rem; }
.phase-row { display: flex; align-items: center; gap: 0.75rem; font-size: 0.85rem; }
.phase-row span:first-child {
  min-width: 80px; color: var(--text-secondary);
  font-family: 'JetBrains Mono', monospace; font-size: 0.75rem;
}
.phase-row .progress-bar { flex: 1; }
.phase-row span:last-child {
  min-width: 40px; text-align: right; color: var(--text-secondary);
  font-family: 'JetBrains Mono', monospace; font-size: 0.75rem;
}

.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-top: 0.75rem; }
.detail-grid > div { display: flex; flex-direction: column; gap: 0.15rem; }
.detail-label {
  font-family: 'JetBrains Mono', monospace; font-size: 0.7rem;
  color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;
}

.ci-card {
  display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
  margin-top: 1rem; padding: 0.75rem 1rem;
  border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface);
}
.ci-label { font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; font-weight: 600; color: var(--accent); }
.ci-link { color: var(--info); text-decoration: none; font-weight: 600; }
.ci-link:hover { text-decoration: underline; }

/* Terminal log event styling */
.log-time { color: var(--text-muted); margin-right: 0.5rem; }
.log-event { font-weight: 600; margin-right: 0.5rem; }

@media (max-width: 639px) {
  .detail-grid { grid-template-columns: 1fr; }
  .job-title-row { flex-direction: column; gap: 0.5rem; }
  .stream-url-box { flex-direction: column; align-items: stretch; }
}
</style>
