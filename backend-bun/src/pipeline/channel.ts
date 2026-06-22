// Deterministic channel picker using hash * 31 algorithm (32-bit signed)
export function pickChannel(jobId: string, channels: string[]): string | null {
  if (channels.length === 0) return null;
  let hash = 0;
  for (let i = 0; i < jobId.length; i++) {
    hash = (hash * 31 + jobId.charCodeAt(i)) | 0;
  }
  return channels[Math.abs(hash) % channels.length];
}
