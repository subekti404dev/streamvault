<script lang="ts">
  let { toasts, onDismiss }: {
    toasts: Array<{id: number; message: string; type: string}>;
    onDismiss?: (id: number) => void;
  } = $props();

  // Auto-dismiss after 5 seconds
  $effect(() => {
    const last = toasts[toasts.length - 1];
    if (!last) return;
    const timer = setTimeout(() => {
      onDismiss?.(last.id);
    }, 5000);
    return () => clearTimeout(timer);
  });
</script>

<div class="toast-container">
  {#each toasts as toast (toast.id)}
    <div class="toast toast-{toast.type}" role="alert">
      <span>{toast.message}</span>
      <button class="toast-close" onclick={() => onDismiss?.(toast.id)}>×</button>
    </div>
  {/each}
</div>

<style>
.toast-container {
  position: fixed; bottom: 1.5rem; right: 1.5rem;
  display: flex; flex-direction: column; gap: 0.5rem; z-index: 100;
}

.toast {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.75rem 1.25rem;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 0.875rem; max-width: 400px;
  animation: slideIn 0.3s ease;
  box-shadow: 0 4px 16px rgba(0,0,0,0.8);
}

.toast-success { border-left: 3px solid var(--success); }
.toast-error { border-left: 3px solid var(--danger); }
.toast-info { border-left: 3px solid var(--info); }

.toast-close {
  background: none; border: none; color: var(--text-secondary);
  cursor: pointer; font-size: 1.1rem; opacity: 0.7;
  padding: 0; line-height: 1; margin-left: auto;
}
.toast-close:hover { opacity: 1; }

@keyframes slideIn {
  from { transform: translateX(100px); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
</style>
