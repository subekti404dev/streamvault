import type { SearchResult, QueueList, JobDetail, AppSettings, StremioCatalogResponse, StremioMetaResponse } from './types';

const BASE = '/api/v1';

function headers(): Record<string, string> {
  const token = localStorage.getItem('streamvault_token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function handleResponse<T>(r: Response): Promise<T> {
  if (!r.ok) {
    const body = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(body.error || `HTTP ${r.status}`);
  }
  return r.json();
}

export function setToken(token: string) {
  localStorage.setItem('streamvault_token', token);
}

export function getToken(): string | null {
  return localStorage.getItem('streamvault_token');
}

export function clearToken() {
  localStorage.removeItem('streamvault_token');
}

export const api = {
  search: async (imdbId: string, mediaType: string, season?: number, episode?: number): Promise<SearchResult> => {
    const r = await fetch(`${BASE}/search`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ imdb_id: imdbId, media_type: mediaType, season, episode }),
    });
    return handleResponse<SearchResult>(r);
  },

  getQueue: async (): Promise<QueueList> => {
    const r = await fetch(`${BASE}/queue`, { headers: headers() });
    return handleResponse<QueueList>(r);
  },

  getJob: async (id: string): Promise<JobDetail> => {
    const r = await fetch(`${BASE}/queue/${id}`, { headers: headers() });
    return handleResponse<JobDetail>(r);
  },

  addToQueue: async (data: Record<string, unknown>): Promise<{ job_id: string; status: string }> => {
    const r = await fetch(`${BASE}/queue`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(data),
    });
    return handleResponse(r);
  },

  retryJob: async (id: string): Promise<{ job_id: string; status: string }> => {
    const r = await fetch(`${BASE}/queue/${id}/retry`, {
      method: 'POST',
      headers: headers(),
    });
    return handleResponse(r);
  },

  deleteJob: async (id: string): Promise<void> => {
    await fetch(`${BASE}/queue/${id}`, { method: 'DELETE', headers: headers() });
  },

  getSettings: async (): Promise<AppSettings> => {
    const r = await fetch(`${BASE}/settings`, { headers: headers() });
    return handleResponse(r);
  },

  updateSettings: async (settings: AppSettings): Promise<void> => {
    await fetch(`${BASE}/settings`, {
      method: 'PUT',
      headers: headers(),
      body: JSON.stringify(settings),
    });
  },

  searchCatalog: async (query: string, baseUrl: string): Promise<StremioCatalogResponse> => {
    const encodedQuery = encodeURIComponent(query);
    const [movieRes, seriesRes] = await Promise.all([
      fetch(`${baseUrl}/catalog/movie/search.movie/search=${encodedQuery}.json`),
      fetch(`${baseUrl}/catalog/series/search.series/search=${encodedQuery}.json`),
    ]);
    
    const [movieData, seriesData] = await Promise.all([
      movieRes.ok ? movieRes.json() : { metas: [] },
      seriesRes.ok ? seriesRes.json() : { metas: [] },
    ]);
    
    return {
      metas: [...(movieData.metas || []), ...(seriesData.metas || [])],
    };
  },

  getStremioMeta: async (type: string, id: string, baseUrl: string): Promise<StremioMetaResponse> => {
    const encodedId = encodeURIComponent(id);
    const r = await fetch(`${baseUrl}/meta/${type}/${encodedId}.json`);
    if (!r.ok) throw new Error(`Failed to fetch metadata: ${r.statusText}`);
    return r.json();
  },
};
