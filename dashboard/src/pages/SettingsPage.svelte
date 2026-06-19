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
    <div class="glass-card"><p class="text-muted">Loading settings...</p></div>
  {:else}
    {#each sections as section}
      <div class="glass-card section-card">
        {#each fields.filter(f => f.section === section) as field}
          <div class="form-group">
            <label for={field.key}>{field.label}</label>
            {#if field.type === 'checkbox'}
              <label class="toggle-switch">
                <input
                  type="checkbox"
                  id={field.key}
                  checked={settings[field.key] === 'true' || settings[field.key] === '1'}
                  onchange={(e) => {
                    settings[field.key] = (e.target as HTMLInputElement).checked ? 'true' : 'false';
                  }}
                />
                <span class="toggle-slider"></span>
              </label>
            {:else}
              <input
                id={field.key}
                type={field.type}
                value={settings[field.key] ?? ''}
                placeholder={field.placeholder || ''}
                oninput={(e) => { settings[field.key] = (e.target as HTMLInputElement).value; }}
              />
            {/if}
          </div>
        {/each}
        {#if section === 'Telegram'}
          <button class="btn btn-sm btn-test" onclick={testTelegram} disabled={testing}>
            {testing ? 'Sending...' : '📨 Test Notification'}
          </button>
        {/if}
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
.toggle-switch { position: relative; display: inline-block; width: 44px; height: 24px; cursor: pointer; }
.toggle-switch input { opacity: 0; width: 0; height: 0; }
.toggle-slider { position: absolute; inset: 0; background: rgba(255,255,255,0.1); border-radius: 24px; transition: 0.2s; }
.toggle-slider::before { content: ''; position: absolute; height: 18px; width: 18px; left: 3px; bottom: 3px; background: white; border-radius: 50%; transition: 0.2s; }
.toggle-switch input:checked + .toggle-slider { background: var(--accent); }
.toggle-switch input:checked + .toggle-slider::before { transform: translateX(20px); }
.page { max-width: 700px; margin: 0 auto; }
.page-title { font-size: 1.5rem; margin-bottom: 0.25rem; }
.page-subtitle { color: var(--text-secondary); font-size: 0.875rem; margin-bottom: 1.5rem; }
.section-card { padding: 1.5rem; margin-bottom: 1rem; }
.section-title { font-size: 0.95rem; color: var(--accent); margin-bottom: 1rem; }
.save-bar { display: flex; justify-content: flex-end; margin-top: 1rem; }
.install-url { display: flex; align-items: center; gap: 0.5rem; }
.install-url code { flex: 1; padding: 0.5rem 0.75rem; background: rgba(0,0,0,0.3); border-radius: var(--radius-sm); font-size: 0.8rem; word-break: break-all; }
.btn-sm { padding: 0.3rem 0.75rem; font-size: 0.8rem; }
.btn-test { margin-top: 0.75rem; background: rgba(44, 168, 255, 0.15); color: var(--accent); border: 1px solid rgba(44, 168, 255, 0.3); }
.btn-test:hover:not(:disabled) { background: rgba(44, 168, 255, 0.25); }
.text-muted { color: var(--text-muted); font-size: 0.85rem; }
</style>
