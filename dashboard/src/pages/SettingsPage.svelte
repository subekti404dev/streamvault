<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import type { AppSettings } from '../lib/types';

  let { addToast }: { addToast: (msg: string, type?: string) => void } = $props();

  let settings = $state<AppSettings>({});
  let loading = $state(true);
  let saving = $state(false);
  let testing = $state(false);

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
              {#if field.type === 'checkbox'}
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
