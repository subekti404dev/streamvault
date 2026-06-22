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
}

type BencodeValue = string | number | BencodeDict | BencodeValue[];

interface BencodeDict {
  [key: string]: BencodeValue;
}

class BencodeReader {
  private pos = 0;

  constructor(private data: Uint8Array) {}

  private peek(): number {
    return this.data[this.pos];
  }

  private readByte(): number {
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
    while (this.data[end] !== 0x65 /* 'e' */) end++;
    const str = new TextDecoder().decode(this.data.subarray(this.pos, end));
    this.pos = end + 1;
    return parseInt(str, 10);
  }

  private parseString(): string {
    let end = this.pos;
    while (this.data[end] !== 0x3a /* ':' */) end++;
    const lenStr = new TextDecoder().decode(this.data.subarray(this.pos, end));
    const len = parseInt(lenStr, 10);
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
      dict[key] = this.parse();
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

export async function inspectTorrent(c: Context<AppBindings>): Promise<Response> {
  const body = (await c.req.json()) as InspectRequest;

  if (!/^[a-f0-9]{40}$/i.test(body.infohash)) {
    throw badRequest("Invalid infohash: must be 40 hex characters");
  }

  const infohash = body.infohash.toLowerCase();
  const url = `https://itorrents.org/torrent/${infohash.toUpperCase()}.torrent`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  let resp: Response;
  try {
    resp = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) throw badRequest("Failed to fetch torrent file");

  const buf = new Uint8Array(await resp.arrayBuffer());
  const decoded = parseBencode(buf);

  const info = decoded.info;
  if (!info || typeof info !== "object" || Array.isArray(info)) {
    throw badRequest("Missing or invalid info dictionary in torrent");
  }

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
        ? String(pathArr[pathArr.length - 1])
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

  return c.json({ name, files } satisfies InspectResponse);
}
