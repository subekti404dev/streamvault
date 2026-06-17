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

{#each toasts as toast (toast.id)}
  <div class="toast toast-{toast.type}" role="alert">
    <span>{toast.message}</span>
    <button class="toast-close" onclick={() => onDismiss?.(toast.id)}>×</button>
  </div>
{/each}

<style>
  .toast {
    position: fixed;
    bottom: 1.5rem;
    right: 1.5rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1.25rem;
    border-radius: var(--radius-sm);
    backdrop-filter: blur(12px);
    z-index: 100;
    animation: slideIn 0.3s ease;
    font-size: 0.875rem;
    max-width: 400px;
  }

  .toast-success {
    background: rgba(16, 185, 129, 0.2);
    border: 1px solid rgba(16, 185, 129, 0.3);
    color: #6ee7b7;
  }

  .toast-error {
    background: rgba(239, 68, 68, 0.2);
    border: 1px solid rgba(239, 68, 68, 0.3);
    color: #fca5a5;
  }

  .toast-info {
    background: rgba(99, 102, 241, 0.2);
    border: 1px solid rgba(99, 102, 241, 0.3);
    color: #a5b4fc;
  }

  .toast-close {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 1.1rem;
    opacity: 0.7;
    padding: 0;
    line-height: 1;
  }

  .toast-close:hover { opacity: 1; }

  @keyframes slideIn {
    from { transform: translateX(100px); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
</style>
