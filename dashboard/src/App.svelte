<script lang="ts">
  import { getToken, clearToken } from './lib/api';
  import { sseConnected, connectSSE, disconnectSSE } from './lib/events';
  import SearchPage from './pages/SearchPage.svelte';
  import QueuePage from './pages/QueuePage.svelte';
  import JobDetailPage from './pages/JobDetailPage.svelte';
  import SettingsPage from './pages/SettingsPage.svelte';
  import LibraryPage from './pages/LibraryPage.svelte';
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
    closeDrawer();
  }
  let drawerOpen = $state(false);

  function toggleDrawer() { drawerOpen = !drawerOpen; }
  function closeDrawer() { drawerOpen = false; }

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

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (drawerOpen) { closeDrawer(); return; }
      if (toasts.length > 0) { toasts = toasts.slice(0, -1); }
    }
  }
</script>

<svelte:window onkeydown={onKeyDown} />

{#if showLogin}
  <div class="login-screen">
    <div class="login-card">
      <div class="login-brand">
        <svg class="login-icon" width="40" height="40" viewBox="0 0 40 40" fill="none">
          <rect x="2" y="2" width="36" height="36" rx="4" stroke="#F5C518" stroke-width="2" fill="none"/>
          <path d="M12 20h16M20 12v16" stroke="#F5C518" stroke-width="2" stroke-linecap="round"/>
        </svg>
        <h1>StreamVault</h1>
      </div>
      <p class="login-subtitle">Personal Media Streaming Pipeline</p>
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
          <p class="login-error">{loginError}</p>
        {/if}
        <button type="submit" class="btn btn-primary" style="width:100%; justify-content:center;">
          Connect
        </button>
      </form>
    </div>
  </div>
{:else}
  <nav class="nav">
    <div class="nav-inner">
      <button class="hamburger" onclick={toggleDrawer} aria-label="Open menu">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M3 12h18M3 6h18M3 18h18"/>
        </svg>
      </button>
      <a href="#search" onclick={navigate} class="nav-brand">StreamVault</a>
      <div class="nav-links">
        <a href="#search" onclick={navigate} class="nav-link" class:active={currentRoute === 'search'}>Search</a>
        <a href="#queue" onclick={navigate} class="nav-link" class:active={currentRoute === 'queue'}>Queue</a>
        <a href="#library" onclick={navigate} class="nav-link" class:active={currentRoute === 'library'}>Library</a>
        <a href="#settings" onclick={navigate} class="nav-link" class:active={currentRoute === 'settings'}>Settings</a>
      </div>
      <div class="nav-right">
        <span class="connection-dot" class:connected={$sseConnected} class:disconnected={!$sseConnected}></span>
        <button class="btn btn-sm" onclick={handleLogout}>Logout</button>
      </div>
    </div>
  </nav>

  {#if drawerOpen}
    <div class="drawer-backdrop" onclick={closeDrawer} role="button" tabindex="-1" aria-label="Close menu"></div>
    <div class="drawer">
      <div class="drawer-header">
        <span class="nav-brand">StreamVault</span>
        <button class="drawer-close" onclick={closeDrawer} aria-label="Close menu">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M18 6 6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
      <div class="drawer-links">
        <a href="#search" onclick={navigate} class="nav-link" class:active={currentRoute === 'search'}>Search</a>
        <a href="#queue" onclick={navigate} class="nav-link" class:active={currentRoute === 'queue'}>Queue</a>
        <a href="#library" onclick={navigate} class="nav-link" class:active={currentRoute === 'library'}>Library</a>
        <a href="#settings" onclick={navigate} class="nav-link" class:active={currentRoute === 'settings'}>Settings</a>
      </div>
      <div class="drawer-footer">
        <span class="connection-dot" class:connected={$sseConnected} class:disconnected={!$sseConnected}></span>
        <button class="btn btn-sm" onclick={handleLogout}>Logout</button>
      </div>
    </div>
  {/if}

  <main class="main-content">
    {#if currentRoute === 'search'}
      <SearchPage {addToast} />
    {:else if currentRoute === 'queue'}
      <QueuePage {addToast} {navigate} />
    {:else if currentRoute === 'job'}
      <JobDetailPage id={routeParams.id || ''} {addToast} {navigate} />
    {:else if currentRoute === 'settings'}
      <SettingsPage {addToast} />
    {:else if currentRoute === 'library'}
      <LibraryPage {addToast} {navigate} />
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
    background: var(--bg-primary);
  }

  .login-card {
    max-width: 400px;
    width: 100%;
    padding: 2rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: 0 4px 16px rgba(0,0,0,0.8);
  }

  .login-brand {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.25rem;
  }

  .login-brand h1 {
    font-family: 'JetBrains Mono', monospace;
    font-weight: 700;
    font-size: 1.5rem;
    color: var(--text-primary);
  }

  .login-subtitle {
    font-family: 'Inter', sans-serif;
    color: var(--text-secondary);
    font-size: 0.85rem;
    margin-bottom: 1.5rem;
  }

  .login-error {
    color: var(--danger);
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    margin-bottom: 0.75rem;
  }

  .nav {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 50;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }

  .nav-inner {
    max-width: 1440px;
    margin: 0 auto;
    display: flex;
    align-items: center;
    gap: 1.5rem;
    padding: 0.75rem 1.5rem;
  }

  .nav-brand {
    font-family: 'JetBrains Mono', monospace;
    font-weight: 700;
    font-size: 1.1rem;
    color: var(--accent);
    text-decoration: none;
  }

  .nav-links {
    display: flex;
    gap: 0.25rem;
    flex: 1;
  }

  .nav-link {
    font-family: 'JetBrains Mono', monospace;
    padding: 0.4rem 0.8rem;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    text-decoration: none;
    font-size: 0.8rem;
    transition: all 0.15s ease;
  }

  .nav-link:hover {
    color: var(--text-primary);
    background: #222222;
  }

  .nav-link.active {
    color: var(--accent);
    border: 1px solid var(--accent);
    background: rgba(245, 197, 24, 0.08);
  }

  .nav-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .connection-dot {
    width: 8px;
    height: 8px;
    display: inline-block;
    border-radius: 50%;
  }

  .connection-dot.connected {
    background: var(--success);
    box-shadow: 0 0 6px var(--success);
  }

  .connection-dot.disconnected {
    background: var(--danger);
  }

  .main-content {
    max-width: 1440px;
    margin: 0 auto;
    padding: 5rem 1.5rem 2rem;
  }

  /* Hamburger - hidden on desktop */
  .hamburger {
    display: none;
    background: none;
    border: none;
    color: var(--text-primary);
    cursor: pointer;
    padding: 0.5rem;
    min-width: 44px;
    min-height: 44px;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
  }
  .hamburger:hover { background: #222222; }

  /* Drawer */
  .drawer-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 51;
  }

  .drawer {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    width: 260px;
    background: var(--surface);
    border-right: 1px solid var(--border);
    z-index: 52;
    display: flex;
    flex-direction: column;
    animation: drawerSlideIn 0.2s ease;
  }

  .drawer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border);
  }

  .drawer-close {
    background: none;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 0.5rem;
    min-width: 44px;
    min-height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
  }
  .drawer-close:hover { background: #222222; }

  .drawer-links {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.75rem 0;
  }

  .drawer-links .nav-link {
    padding: 0.6rem 1rem;
    border-radius: 0;
    font-size: 0.85rem;
  }

  .drawer-footer {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--border);
  }

  @keyframes drawerSlideIn {
    from { transform: translateX(-100%); }
    to { transform: translateX(0); }
  }

  @media (max-width: 639px) {
    .hamburger {
      display: flex;
    }

    .nav-links, .nav-right {
      display: none;
    }

    .nav-inner {
      padding: 0.5rem 1rem;
      gap: 0.75rem;
    }

    .main-content {
      padding: 4.5rem 1rem 1.5rem;
    }

    .login-screen {
      padding: 1rem;
    }

    .login-card {
      padding: 1.5rem;
    }
  }
</style>
