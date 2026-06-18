<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api';
  import type { AppSettings } from '../lib/types';

  let { addToast }: { addToast: (msg: string, type?: string) => void } = $props();

  let settings = $state<AppSettings>({});
  let loading = $state(true);
  let saving = $state(false);

  const fields = [
    { key: 'gh_token', label: 'GitHub Token', type: 'password', section: 'GitHub' },
    { key: 'gh_repo', label: 'GitHub Repository (owner/name)', type: 'text', section: 'GitHub' },
    { key: 'discord_bot_token', label: 'Discord Bot Token', type: 'password', section: 'Discord' },
    { key: 'discord_channel_id', label: 'Discord Channel ID', type: 'text', section: 'Discord' },
    { key: 'telegram_bot_token', label: 'Telegram Bot Token', type: 'password', section: 'Telegram' },
    { key: 'telegram_channel_id', label: 'Telegram Channel ID', type: 'text', section: 'Telegram' },
    { key: 'notifications_enabled', label: 'Notifications Enabled', type: 'text', section: 'Telegram' },
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
    <div class="glass-card"><p class="text-muted">Loading settings...</p></div>
  {:else}
    {#each sections as section}
      <div class="glass-card section-card">
        <h2 class="section-title">{section}</h2>
        {#each fields.filter(f => f.section === section) as field}
          <div class="form-group">
            <label for={field.key}>{field.label}</label>
            <input
              id={field.key}
              type={field.type}
              value={settings[field.key] ?? ''}
              placeholder={field.placeholder || ''}
              oninput={(e) => { settings[field.key] = (e.target as HTMLInputElement).value; }}
            />
          </div>
        {/each}
      </div>
    {/each}

    <div class="glass-card section-card">
      <h2 class="section-title">Stremio Addon</h2>
      <p class="text-muted" style="margin-bottom:0.75rem;">
        Install this addon in Stremio by opening the following URL:
      </p>
      <div class="install-url">
        <code id="addon-url">{addonInstallUrl()}</code>
        <button class="btn btn-sm" onclick={() => {
          navigator.clipboard.writeText(addonInstallUrl());
          addToast('URL copied to clipboard', 'info');
        }}>Copy</button>
      </div>
    </div>

    <div class="save-bar">
      <button class="btn btn-primary" onclick={saveSettings} disabled={saving}>
        {saving ? 'Saving...' : 'Save All Settings'}
      </button>
    </div>
  {/if}
</div>

<style>
  .page { max-width: 700px; margin: 0 auto; }
  .page-title { font-size: 1.5rem; margin-bottom: 0.25rem; }
  .page-subtitle { color: var(--text-secondary); font-size: 0.875rem; margin-bottom: 1.5rem; }
  .section-card { padding: 1.5rem; margin-bottom: 1rem; }
  .section-title { font-size: 0.95rem; color: var(--accent); margin-bottom: 1rem; }
  .save-bar { display: flex; justify-content: flex-end; margin-top: 1rem; }
  .install-url { display: flex; align-items: center; gap: 0.5rem; }
  .install-url code { flex: 1; padding: 0.5rem 0.75rem; background: rgba(0,0,0,0.3); border-radius: var(--radius-sm); font-size: 0.8rem; word-break: break-all; }
  .btn-sm { padding: 0.3rem 0.75rem; font-size: 0.8rem; }
  .text-muted { color: var(--text-muted); font-size: 0.85rem; }
</style>
