<script lang="ts">
  import { getToken, clearToken } from './lib/api';
  import { sseConnected, connectSSE, disconnectSSE } from './lib/events';
  import SearchPage from './pages/SearchPage.svelte';
  import QueuePage from './pages/QueuePage.svelte';
  import JobDetailPage from './pages/JobDetailPage.svelte';
  import SettingsPage from './pages/SettingsPage.svelte';
  import Toast from './lib/Toast.svelte';

  let currentRoute = $state('search');
  let routeParams = $state<Record<string, string>>({});
  let token = $state(getToken() ?? '');
  let showLogin = $derived(!token);
  let loginInput = $state('');
  let loginError = $state('');
  let toasts = $state<Array<{id: number; message: string; type: string}>>([]);
  let toastId = 0;

  function addToast(message: string, type: string = 'info') {
    toasts = [...toasts, { id: ++toastId, message, type }];
  }

  function dismissToast(id: number) {
    toasts = toasts.filter(t => t.id !== id);
  }

  function navigate(e: Event) {
    const target = e.currentTarget as HTMLAnchorElement;
    e.preventDefault();
    const href = target.getAttribute('href') ?? '';
    const [route, ...rest] = href.slice(1).split('/');
    currentRoute = route || 'search';
    routeParams = {};
    if (rest.length > 0) {
      routeParams = { id: rest[0] };
    }
    history.replaceState(null, '', window.location.pathname + href);
  }

  function handleLogin() {
    if (!loginInput.trim()) {
      loginError = 'Please enter your auth token';
      return;
    }
    localStorage.setItem('streamvault_token', loginInput.trim());
    token = loginInput.trim();
    showLogin = false;
    loginError = '';
  }

  function handleLogout() {
    clearToken();
    token = '';
    showLogin = true;
    disconnectSSE();
    currentRoute = 'search';
  }

  $effect(() => {
    if (token) {
      connectSSE();
    }
    return () => disconnectSSE();
  });

  // Global keyboard shortcut: Escape to dismiss last toast
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape' && toasts.length > 0) {
      toasts = toasts.slice(0, -1);
    }
  }
</script>

<svelte:window onkeydown={onKeyDown} />

{#if showLogin}
  <div class="login-screen">
    <div class="login-card glass">
      <h1>StreamVault</h1>
      <p class="subtitle">Personal Media Streaming Pipeline</p>
      <form onsubmit={(e) => { e.preventDefault(); handleLogin(); }}>
        <div class="form-group">
          <label for="token">Auth Token</label>
          <input
            id="token"
            type="password"
            bind:value={loginInput}
            placeholder="Enter your dashboard auth token"
          />
        </div>
        {#if loginError}
          <p class="error">{loginError}</p>
        {/if}
        <button type="submit" class="btn btn-primary" style="width:100%">
          Connect
        </button>
      </form>
    </div>
  </div>
{:else}
  <nav class="nav glass">
    <div class="nav-inner">
      <a href="#search" onclick={navigate} class="nav-brand">StreamVault</a>
      <div class="nav-links">
        <a href="#search" onclick={navigate} class="nav-link" class:active={currentRoute === 'search'}>Search</a>
        <a href="#queue" onclick={navigate} class="nav-link" class:active={currentRoute === 'queue'}>Queue</a>
        <a href="#settings" onclick={navigate} class="nav-link" class:active={currentRoute === 'settings'}>Settings</a>
      </div>
      <div class="nav-right">
        <span class="connection-dot" class:connected={$sseConnected} class:disconnected={!$sseConnected}></span>
        <button class="btn btn-sm" onclick={handleLogout}>Logout</button>
      </div>
    </div>
  </nav>

  <main class="main-content">
    {#if currentRoute === 'search'}
      <SearchPage {addToast} />
    {:else if currentRoute === 'queue'}
      <QueuePage {addToast} {navigate} />
    {:else if currentRoute === 'job'}
      <JobDetailPage id={routeParams.id || ''} {addToast} {navigate} />
    {:else if currentRoute === 'settings'}
      <SettingsPage {addToast} />
    {/if}
  </main>
{/if}

<Toast {toasts} onDismiss={dismissToast} />

<style>
  .login-screen {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 2rem;
  }

  .login-card {
    max-width: 400px;
    width: 100%;
    padding: 2.5rem;
    text-align: center;
  }

  .login-card h1 {
    font-size: 1.75rem;
    margin-bottom: 0.25rem;
  }

  .subtitle {
    color: var(--text-secondary);
    font-size: 0.9rem;
    margin-bottom: 2rem;
  }

  .error {
    color: var(--danger);
    font-size: 0.8rem;
    margin-bottom: 0.75rem;
  }

  .nav {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 50;
    border-radius: 0;
    border-top: none;
    border-left: none;
    border-right: none;
  }

  .nav-inner {
    max-width: 1200px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 1.5rem;
    padding: 0.75rem 1.5rem;
  }

  .nav-brand {
    font-weight: 700;
    font-size: 1.1rem;
    color: var(--text-primary);
    text-decoration: none;
  }

  .nav-links {
    display: flex;
    gap: 0.25rem;
    flex: 1;
  }

  .nav-link {
    padding: 0.4rem 0.8rem;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    text-decoration: none;
    font-size: 0.875rem;
    transition: all 0.15s ease;
  }

  .nav-link:hover { color: var(--text-primary); background: var(--glass-hover); }
  .nav-link.active { color: var(--accent); background: rgba(99, 102, 241, 0.1); }

  .nav-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .connection-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
  }

  .connection-dot.connected { background: var(--success); box-shadow: 0 0 6px var(--success); }
  .connection-dot.disconnected { background: var(--danger); }

  .btn-sm {
    padding: 0.3rem 0.75rem;
    font-size: 0.8rem;
  }

  .main-content {
    max-width: 1200px;
    margin: 0 auto;
    padding: 5rem 1.5rem 2rem;
  }
</style>
