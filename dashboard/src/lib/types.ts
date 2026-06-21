export interface Job {
  id: string;
  imdb_id: string;
  media_type: 'movie' | 'series';
  season?: number | null;
  episode?: number | null;
  title?: string | null;
  poster_url?: string | null;
  magnet_uri?: string | null;
  file_size_bytes?: number | null;
  status: JobStatus;
  current_phase?: string | null;
  progress_pct?: number | null;
  transcode_pct?: number | null;
  upload_pct?: number | null;
  last_checkpoint?: string | null;
  gh_run_id?: string | null;
  video_resolution?: string | null;
  duration_seconds?: number | null;
  error_message?: string | null;
  created_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  updated_at?: string | null;
}

export type JobStatus =
  | 'queued' | 'processing' | 'downloading'
  | 'checkpoint_download' | 'transcoding'
  | 'checkpoint_transcode' | 'uploading'
  | 'completed' | 'failed';

export interface JobEvent {
  id: number;
  job_id: string;
  phase?: string | null;
  event_type: string;
  message?: string | null;
  progress_pct?: number | null;
  created_at?: string | null;
}

export interface SearchResult {
  meta: { title: string; poster?: string | null; year?: number | null };
  torrents: Torrent[];
}

export interface Torrent {
  name: string;
  title: string;
  filename: string;
  size_bytes: number;
  infohash: string;
  magnet_uri: string;
  file_idx: number;
}

export interface QueueList {
  processing: Job[];
  queued: Job[];
  completed: Job[];
  failed: Job[];
}
export interface JobDetail {
  job: Job;
  events: JobEvent[];
  gh_repo?: string | null;
}

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

export interface LibraryDetail {
  imdb_id: string;
  title: string | null;
  poster_url: string | null;
  media_type: string;
  jobs: LibraryJob[];
}

export type AppSettings = Record<string, string>;

export interface StremioCatalogResponse {
  metas: StremioMetaItem[];
}

export interface StremioMetaItem {
  id: string;
  type: 'movie' | 'series';
  name: string;
  poster?: string | null;
  year?: number | null;
  description?: string | null;
  runtime?: string | null;
  imdb_id?: string | null;
}

export interface StremioMetaResponse {
  meta: StremioMetaDetail;
}

export interface StremioMetaDetail extends StremioMetaItem {
  background?: string | null;
  logo?: string | null;
  genres?: string[];
  cast?: string[];
  director?: string[];
  videos?: StremioVideo[];
}

export interface StremioVideo {
  id: string;
  title: string;
  season?: number;
  episode?: number;
  thumbnail?: string;
  released?: string;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  return `${m}m ${s}s`;
}

export function statusLabel(status: JobStatus): string {
  const labels: Record<string, string> = {
    queued: 'Queued',
    processing: 'Starting',
    downloading: 'Downloading',
    checkpoint_download: 'Downloaded',
    transcoding: 'Transcoding',
    checkpoint_transcode: 'Transcoded',
    uploading: 'Uploading',
    completed: 'Completed',
    failed: 'Failed',
  };
  return labels[status] || status;
}

export function statusColor(status: JobStatus): string {
  const colors: Record<string, string> = {
    queued: '#6366f1',
    processing: '#f59e0b',
    downloading: '#3b82f6',
    checkpoint_download: '#10b981',
    transcoding: '#8b5cf6',
    checkpoint_transcode: '#10b981',
    uploading: '#f97316',
    completed: '#10b981',
    failed: '#ef4444',
  };
  return colors[status] || '#6b7280';
}
