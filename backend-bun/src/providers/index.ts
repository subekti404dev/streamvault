import type { ProviderContext, ProviderResult, TorrentProvider } from "./types";

export { ytsProvider } from "./yts";
export { eztvProvider } from "./eztv";
export * from "./types";

import { ytsProvider } from "./yts";
import { eztvProvider } from "./eztv";

export const builtinProviders: TorrentProvider[] = [ytsProvider, eztvProvider];

const PROVIDER_TIMEOUT_MS = 12_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("provider timeout")), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Run providers in parallel, log failures, dedup by infoHash keeping highest seeders. */
export async function aggregateProviders(
  providers: TorrentProvider[],
  ctx: ProviderContext,
): Promise<ProviderResult[]> {
  const eligible = providers.filter((p) => p.supports(ctx.mediaType));

  const settled = await Promise.allSettled(
    eligible.map(async (p) => withTimeout(p.search(ctx), PROVIDER_TIMEOUT_MS)),
  );

  const byHash = new Map<string, ProviderResult>();
  settled.forEach((res, i) => {
    if (res.status === "rejected") {
      console.warn(`[providers] ${eligible[i].id} failed:`, res.reason instanceof Error ? res.reason.message : res.reason);
      return;
    }
    for (const r of res.value) {
      const hash = r.infoHash.toLowerCase();
      const existing = byHash.get(hash);
      if (!existing || r.seeders > existing.seeders) byHash.set(hash, r);
    }
  });

  const out = [...byHash.values()];
  console.log(`[providers] ${ctx.mediaType} "${ctx.title}" -> ${out.length} unique torrents from ${eligible.length} provider(s)`);
  return out;
}
