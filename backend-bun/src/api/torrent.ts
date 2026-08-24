import { createHash } from "node:crypto";
import type { Context } from "hono";
import type { AppBindings } from "../app";
import { badRequest } from "../error";

interface InspectRequest {
  infohash: string;
}

interface TorrentFileEntry {
  index: number;
  name: string;
  size_bytes: number;
}

interface InspectResponse {
  name: string;
  files: TorrentFileEntry[];
  safe: boolean;
  reason?: string;
}

type BencodeValue = string | number | BencodeDict | BencodeValue[];

interface BencodeDict {
  [key: string]: BencodeValue;
}

class BencodeReader {
  private pos = 0;
  /** Byte span [start, end) of the most recently parsed "info" dict value */
  infoSpan: [number, number] | null = null;

  constructor(private data: Uint8Array) {}

  /** Check bounds, throw on malformed input before walking past buffer */
  private guard(i?: number): void {
    if ((i ?? this.pos) >= this.data.length) {
      throw new Error(`Bencode: unexpected end of data at offset ${i ?? this.pos}`);
    }
  }

  private peek(): number {
    this.guard();
    return this.data[this.pos];
  }

  private readByte(): number {
    this.guard();
    return this.data[this.pos++];
  }

  parse(): BencodeValue {
    const c = this.peek();
    if (c === 0x69 /* 'i' */) return this.parseInt();
    if (c >= 0x30 && c <= 0x39 /* '0'-'9' */) return this.parseString();
    if (c === 0x64 /* 'd' */) return this.parseDict();
    if (c === 0x6c /* 'l' */) return this.parseList();
    throw new Error(`Unexpected bencode byte: 0x${c.toString(16)} at offset ${this.pos}`);
  }

  private parseInt(): number {
    this.readByte(); // 'i'
    let end = this.pos;
    while (true) {
      this.guard(end);
      if (this.data[end] === 0x65 /* 'e' */) break;
      end++;
    }
    const str = new TextDecoder().decode(this.data.subarray(this.pos, end));
    this.pos = end + 1;
    return parseInt(str, 10);
  }

  private parseString(): string {
    let end = this.pos;
    while (true) {
      this.guard(end);
      if (this.data[end] === 0x3a /* ':' */) break;
      end++;
    }
    const lenStr = new TextDecoder().decode(this.data.subarray(this.pos, end));
    const len = parseInt(lenStr, 10);
    if (len < 0 || len > this.data.length - this.pos) {
      throw new Error(`Bencode: invalid string length ${len} at offset ${this.pos}`);
    }
    this.pos = end + 1;
    const str = new TextDecoder().decode(this.data.subarray(this.pos, this.pos + len));
    this.pos += len;
    return str;
  }

  private parseDict(): BencodeDict {
    this.readByte(); // 'd'
    const dict: BencodeDict = {};
    while (this.peek() !== 0x65 /* 'e' */) {
      const key = this.parseString();
      if (key === "info") {
        const start = this.pos;
        const value = this.parse();
        this.infoSpan = [start, this.pos];
        dict[key] = value;
      } else {
        dict[key] = this.parse();
      }
    }
    this.readByte(); // 'e'
    return dict;
  }

  private parseList(): BencodeValue[] {
    this.readByte(); // 'l'
    const list: BencodeValue[] = [];
    while (this.peek() !== 0x65 /* 'e' */) {
      list.push(this.parse());
    }
    this.readByte(); // 'e'
    return list;
  }
}

function parseBencode(data: Uint8Array): BencodeDict {
  const reader = new BencodeReader(data);
  const result = reader.parse();
  if (typeof result === "object" && !Array.isArray(result)) return result;
  throw new Error("Top-level bencode value must be a dictionary");
}

const EXECUTABLE_EXTENSIONS = new Set([
  "exe", "msi", "scr", "bat", "cmd", "com", "pif", "lnk",
  "vbs", "vbe", "js", "jse", "wsf", "wsh", "ps1", "jar", "hta", "apk",
]);

const VIDEO_EXTENSIONS = new Set([
  "mkv", "mp4", "avi", "ts", "m2ts", "mts", "mov", "wmv", "flv",
  "webm", "mpg", "mpeg", "m4v", "vob", "ogm", "rmvb", "iso",
]);

function fileExtension(name: string): string {
  const base = name.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot + 1).toLowerCase();
}

export function analyzeTorrentSafety(
  name: string,
  files: TorrentFileEntry[],
): { safe: boolean; reason?: string } {
  let hasVideo = false;
  for (const f of files) {
    const ext = fileExtension(f.name) || (files.length === 1 ? fileExtension(name) : "");
    if (EXECUTABLE_EXTENSIONS.has(ext)) {
      return { safe: false, reason: `contains executable file: ${f.name}` };
    }
    if (VIDEO_EXTENSIONS.has(ext)) hasVideo = true;
  }
  if (files.length > 0 && !hasVideo && !fileExtension(name)) {
    return { safe: false, reason: "no media files found in torrent" };
  }
  if (!hasVideo && EXECUTABLE_EXTENSIONS.has(fileExtension(name))) {
    return { safe: false, reason: `executable torrent: ${name}` };
  }
  return { safe: true };
}

export async function fetchTorrentMeta(infohash: string, timeoutMs = 15_000): Promise<{ name: string; files: TorrentFileEntry[] } | null> {
  const url = `https://itorrents.org/torrent/${infohash.toUpperCase()}.torrent`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;

    const buf = new Uint8Array(await resp.arrayBuffer());
    const reader = new BencodeReader(buf);
    const parsed = reader.parse();
    const decoded = (typeof parsed === "object" && !Array.isArray(parsed))
      ? parsed as BencodeDict
      : null;
    if (!decoded) return null;

    // Integrity check: sha1 of the canonical bencoded "info" dict must equal
    // the requested infohash. Public .torrent caches serve arbitrary placeholder
    // payloads on cache misses — never trust unverified bytes.
    if (!reader.infoSpan) return null;
    const [start, end] = reader.infoSpan;
    const actual = createHash("sha1").update(buf.subarray(start, end)).digest("hex");
    if (actual !== infohash.toLowerCase()) {
      console.warn(`[torrent] infohash mismatch for ${infohash}: got ${actual} (cache miss / poisoned placeholder)`);
      return null;
    }

    const info = decoded.info;
    if (!info || typeof info !== "object" || Array.isArray(info)) return null;

    const infoDict = info as BencodeDict;
    const name = typeof infoDict.name === "string" ? infoDict.name : "unknown";

    const files: TorrentFileEntry[] = [];
    if (Array.isArray(infoDict.files)) {
      const fileList = infoDict.files as BencodeValue[];
      for (let i = 0; i < fileList.length; i++) {
        const f = fileList[i];
        if (!f || typeof f !== "object" || Array.isArray(f)) continue;
        const fd = f as BencodeDict;
        const pathArr = fd.path;
        const fname = Array.isArray(pathArr) && pathArr.length > 0
          ? pathArr.map(p => String(p)).join('/')
          : `file_${i}`;
        files.push({
          index: i,
          name: fname,
          size_bytes: typeof fd.length === "number" ? fd.length : 0,
        });
      }
    } else if (typeof infoDict.length === "number") {
      files.push({ index: 0, name, size_bytes: infoDict.length });
    }

    return { name, files };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectTorrent(c: Context<AppBindings>): Promise<Response> {
  const body = (await c.req.json()) as InspectRequest;

  if (!/^[a-f0-9]{40}$/i.test(body.infohash)) {
    throw badRequest("Invalid infohash: must be 40 hex characters");
  }

  const infohash = body.infohash.toLowerCase();
  const meta = await fetchTorrentMeta(infohash);
  if (!meta) throw badRequest("Torrent metadata not available on public cache");

  const safety = analyzeTorrentSafety(meta.name, meta.files);

  return c.json({ ...meta, ...safety } satisfies InspectResponse);
}
