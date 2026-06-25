<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import type { AppSettings } from '../lib/types';

  let { addToast }: { addToast: (msg: string, type?: string) => void } = $props();

  let settings = $state<AppSettings>({});
  let loading = $state(true);
  let saving = $state(false);
  let testing = $state(false);
  let exporting = $state(false);
  let importing = $state(false);
  let importFile = $state<File | null>(null);

  const fields = [
    { key: 'gh_token', label: 'GitHub Token', type: 'password', section: 'GitHub' },
    { key: 'gh_repo', label: 'GitHub Repository (owner/name)', type: 'text', section: 'GitHub' },
    { key: 'discord_bot_token', label: 'Discord Bot Token', type: 'password', section: 'Discord' },
    { key: 'discord_channel_id', label: 'Discord Channel ID (single, fallback)', type: 'text', section: 'Discord' },
    { key: 'discord_channel_ids', label: 'Discord Channel IDs (comma-separated for parallel)', type: 'text', section: 'Discord', placeholder: '111,222,333,444,555' },
    { key: 'telegram_bot_token', label: 'Telegram Bot Token', type: 'password', section: 'Telegram' },
    { key: 'telegram_channel_id', label: 'Telegram Channel ID', type: 'text', section: 'Telegram' },
    { key: 'notifications_enabled', label: 'Telegram Notifications', type: 'checkbox', section: 'Telegram' },
    { key: 'torrentio_base_url', label: 'Torrentio Proxy URL', type: 'text', section: 'Torrentio' },
    { key: 'public_base_url', label: 'Public Base URL', type: 'text', section: 'Stremio' },
    { key: 'stremio_addon_id', label: 'Custom Addon ID', type: 'text', section: 'Stremio' },
    { key: 'stremio_addon_name', label: 'Custom Addon Name', type: 'text', section: 'Stremio' },
    { key: 'stremio_movie_catalog_name', label: 'Movie Catalog Name', type: 'text', section: 'Stremio', placeholder: 'Movies' },
    { key: 'stremio_series_catalog_name', label: 'Series Catalog Name', type: 'text', section: 'Stremio', placeholder: 'Series' },
    { key: 'stremio_metadata_url', label: 'Metadata Addon URL', type: 'text', section: 'Stremio', placeholder: 'https://aiometadatafortheweebs.midnightignite.me/stremio/43031d18-5fb4-40dc-9d73-cce34062e999' },
  ];

  const sections = [...new Set(fields.map(f => f.section))];

  onMount(async () => {
    try {
      settings = await api.getSettings();
    } catch (e: any) {
      addToast(`Failed to load settings: ${e.message}`, 'error');
    } finally {
      loading = false;
    }
  });

  async function saveSettings() {
    saving = true;
    try {
      await api.updateSettings(settings);
      addToast('Settings saved', 'success');
    } catch (e: any) {
      addToast(`Failed to save: ${e.message}`, 'error');
    } finally {
      saving = false;
    }
  }

  async function testTelegram() {
    testing = true;
    try {
      await api.testTelegramNotification();
      addToast('Test notification sent! Check Telegram', 'success');
    } catch (e: any) {
      addToast(`Test failed: ${e.message}`, 'error');
    } finally {
      testing = false;
    }
  }

  async function exportData() {
    exporting = true;
    try {
      const token = localStorage.getItem('streamvault_token');
      const r = await fetch('/api/v1/export', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok) throw new Error(`Export failed: ${r.status}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `streamvault-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      addToast('Backup downloaded', 'success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addToast(`Export failed: ${msg}`, 'error');
    } finally {
      exporting = false;
    }
  }

  async function importData() {
    if (!importFile) return;
    if (!confirm('This will replace ALL existing data. Continue?')) return;
    importing = true;
    try {
      const text = await importFile.text();
      const token = localStorage.getItem('streamvault_token');
      const r = await fetch('/api/v1/import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: text,
      });
      const result = await r.json();
      if (!r.ok) throw new Error(result.error ?? `Import failed: ${r.status}`);
      const c = result.imported;
      addToast(`Imported: ${c.jobs} jobs, ${c.hls_chunks} chunks, ${c.app_settings} settings`, 'success');
      importFile = null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addToast(`Import failed: ${msg}`, 'error');
    } finally {
      importing = false;
    }
  }

  function publicUrl(): string {
    return settings['public_base_url'] || (window.location.origin + window.location.pathname.replace(/\/$/, ''));
  }

  function addonInstallUrl(): string {
    return `${publicUrl()}/manifest.json`;
  }
</script>

<div class="page">
  <h1 class="page-title">Settings</h1>
  <p class="page-subtitle">Configure integrations and preferences</p>

  {#if loading}
    <div class="settings-section"><p class="text-muted">Loading settings...</p></div>
  {:else}
    <form onsubmit={(e) => { e.preventDefault(); saveSettings(); }}>
      {#each sections as section}
        <div class="settings-section">
          <h2 class="section-title">{section}</h2>
          {#each fields.filter(f => f.section === section) as field}
            <div class="form-group">
              <label for={field.key}>{field.label}</label>
              {#if field.key === 'notifications_enabled'}
                <label class="toggle" for={field.key}>
                  <input
                    type="checkbox"
                    id={field.key}
                    checked={settings[field.key] === 'true' || settings[field.key] === '1'}
                    onchange={(e) => settings[field.key] = e.currentTarget.checked ? 'true' : 'false'}
                  />
                  <span class="toggle-slider"></span>
                  <span class="toggle-label">
                    {settings[field.key] === 'true' || settings[field.key] === '1' ? 'On' : 'Off'}
                  </span>
                </label>
              {:else if field.type === 'checkbox'}
                <input type="checkbox" id={field.key} checked={settings[field.key] === 'true' || settings[field.key] === '1'} onchange={(e) => settings[field.key] = e.currentTarget.checked ? 'true' : 'false'} />
              {:else}
                <input type={field.type} id={field.key} bind:value={settings[field.key]} placeholder={field.placeholder ?? ''} />
              {/if}
            </div>
          {/each}
        </div>
      {/each}

      <div class="settings-actions">
        <button type="submit" class="btn btn-primary" disabled={loading || saving}>{saving ? 'Saving...' : 'Save Settings'}</button>
        <button type="button" class="btn" onclick={testTelegram} disabled={testing}>{testing ? 'Testing...' : 'Test Telegram'}</button>
      </div>
    </form>

    <div class="addon-info">
      <span class="detail-label">Stremio Addon URL</span>
      <code>{addonInstallUrl()}</code>
    </div>

    <div class="settings-section">
      <h2 class="section-title">Backup & Restore</h2>
      <div class="settings-actions">
        <button type="button" class="btn btn-primary" onclick={exportData} disabled={exporting}>
          {exporting ? 'Exporting...' : '↥ Export Data'}
        </button>
        <span class="text-muted" style="align-self:center">Download all data as JSON</span>
      </div>
      <div class="form-group">
        <label for="import-file">Import backup file</label>
        <input type="file" id="import-file" accept=".json" onchange={(e) => { importFile = e.currentTarget.files?.[0] ?? null; }} />
      </div>
      <div class="settings-actions">
        <button type="button" class="btn btn-danger" onclick={importData} disabled={importing || !importFile}>
          {importing ? 'Importing...' : '↧ Import Data'}
        </button>
        <span class="text-muted" style="align-self:center">WARNING: replaces all existing data</span>
      </div>
    </div>
  {/if}
</div>
<style>
.page { max-width: 800px; margin: 0 auto; }

.page-title {
  font-family: 'JetBrains Mono', monospace;
  font-weight: 700; font-size: 1.25rem; margin-bottom: 0.25rem;
}

.page-subtitle {
  color: var(--text-secondary); font-size: 0.875rem; margin-bottom: 1.5rem;
}

.settings-section {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 1.5rem; margin-bottom: 1rem;
}

.section-title {
  font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; font-weight: 600;
  color: var(--accent); text-transform: uppercase; letter-spacing: 0.05em;
  margin-bottom: 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border);
}

.settings-actions { display: flex; gap: 0.75rem; margin-top: 1rem; }

.addon-info {
  margin-top: 1.5rem; padding: 1rem;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  display: flex; flex-direction: column; gap: 0.5rem;
}


/* ── Toggle Switch ── */
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.75rem;
  cursor: pointer;
  user-select: none;
}

.toggle input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: relative;
  width: 44px;
  height: 24px;
  background: var(--border);
  border-radius: 12px;
  transition: background 0.2s ease;
}

.toggle-slider::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 20px;
  height: 20px;
  background: var(--text-secondary);
  border-radius: 50%;
  transition: transform 0.2s ease, background 0.2s ease;
}

.toggle input:checked + .toggle-slider {
  background: var(--accent);
}

.toggle input:checked + .toggle-slider::after {
  transform: translateX(20px);
  background: var(--surface);
}

.toggle-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.toggle input:checked ~ .toggle-label {
  color: var(--accent);
}

.addon-info code {
  background: var(--bg-primary); padding: 0.5rem 0.75rem;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  font-family: 'JetBrains Mono', monospace; font-size: 0.8rem;
  color: var(--text-primary); word-break: break-all;
}

.detail-label {
  font-family: 'JetBrains Mono', monospace; font-size: 0.7rem;
  color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em;
}

.text-muted { color: var(--text-muted); font-size: 0.85rem; }

@media (max-width: 639px) {
  .settings-actions { flex-direction: column; }
  .settings-actions button { width: 100%; justify-content: center; min-height: 44px; }
}
</style>
