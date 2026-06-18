use axum::{Json, extract::State};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use crate::app::AppState;
use crate::error::{AppResult, AppError};

#[derive(Debug, Deserialize)]
pub struct InspectRequest {
    pub infohash: String,
}

#[derive(Debug, Serialize)]
pub struct TorrentFile {
    pub index: usize,
    pub name: String,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct InspectResponse {
    pub name: String,
    pub files: Vec<TorrentFile>,
}

/// Minimal bencode parser — only extracts `info` dict from .torrent files
mod bencode {
    #[derive(Debug)]
    pub enum Value {
        Int(i64),
        Bytes(Vec<u8>),
        List(Vec<Value>),
        Dict(Vec<(Vec<u8>, Value)>),
    }

    impl Value {
        pub fn as_str(&self) -> Option<&str> {
            if let Value::Bytes(b) = self {
                std::str::from_utf8(b).ok()
            } else {
                None
            }
        }

        pub fn as_int(&self) -> Option<i64> {
            if let Value::Int(i) = self { Some(*i) } else { None }
        }

        pub fn get(&self, key: &str) -> Option<&Value> {
            if let Value::Dict(entries) = self {
                entries.iter()
                    .find(|(k, _)| k == key.as_bytes())
                    .map(|(_, v)| v)
            } else {
                None
            }
        }
    }

    pub fn parse(data: &[u8]) -> Result<(Value, usize), String> {
        if data.is_empty() {
            return Err("empty input".into());
        }
        match data[0] {
            b'i' => {
                let end = data[1..].iter().position(|&b| b == b'e')
                    .ok_or("unterminated int")?;
                let s = std::str::from_utf8(&data[1..1 + end]).map_err(|e| e.to_string())?;
                let val: i64 = s.parse().map_err(|e: std::num::ParseIntError| e.to_string())?;
                Ok((Value::Int(val), 2 + end))
            }
            b'l' => {
                let mut items = Vec::new();
                let mut pos = 1;
                while pos < data.len() && data[pos] != b'e' {
                    let (val, len) = parse(&data[pos..])?;
                    items.push(val);
                    pos += len;
                }
                Ok((Value::List(items), pos + 1))
            }
            b'd' => {
                let mut entries = Vec::new();
                let mut pos = 1;
                while pos < data.len() && data[pos] != b'e' {
                    let (key, klen) = parse(&data[pos..])?;
                    pos += klen;
                    let key_bytes = if let Value::Bytes(b) = key { b } else {
                        return Err("dict key must be bytes".into());
                    };
                    let (val, vlen) = parse(&data[pos..])?;
                    pos += vlen;
                    entries.push((key_bytes, val));
                }
                Ok((Value::Dict(entries), pos + 1))
            }
            b'0'..=b'9' => {
                let colon = data.iter().position(|&b| b == b':')
                    .ok_or("missing colon in string")?;
                let s = std::str::from_utf8(&data[..colon]).map_err(|e| e.to_string())?;
                let len: usize = s.parse().map_err(|e: std::num::ParseIntError| e.to_string())?;
                let start = colon + 1;
                if start + len > data.len() {
                    return Err("string length exceeds data".into());
                }
                let bytes = data[start..start + len].to_vec();
                Ok((Value::Bytes(bytes), start + len))
            }
            c => Err(format!("unexpected byte: {}", c as char)),
        }
    }
}

pub async fn inspect_torrent(
    State(state): State<Arc<AppState>>,
    Json(body): Json<InspectRequest>,
) -> AppResult<Json<InspectResponse>> {
    let infohash = body.infohash.to_lowercase();

    // Validate infohash format
    if infohash.len() != 40 || !infohash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::BadRequest("Invalid infohash".into()));
    }

    // Try fetching from itorrents.org cache
    let url = format!("https://itorrents.org/torrent/{}.torrent", infohash.to_uppercase());
    let resp = state.http.get(&url)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("Failed to fetch .torrent: {}", e)))?;

    if !resp.status().is_success() {
        // Try alternative cache
        let url2 = format!("https://btcache.me/torrent/{}.torrent", infohash.to_uppercase());
        let resp2 = state.http.get(&url2)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| AppError::Internal(format!("Failed to fetch .torrent from cache: {}", e)))?;

        if !resp2.status().is_success() {
            return Err(AppError::NotFound(format!(
                "Torrent not found in cache (infohash: {}). Try again later or the torrent may not be indexed.",
                infohash
            )));
        }

        let data = resp2.bytes().await
            .map_err(|e| AppError::Internal(format!("Failed to read .torrent: {}", e)))?;
        return parse_torrent_data(&data);
    }

    let data = resp.bytes().await
        .map_err(|e| AppError::Internal(format!("Failed to read .torrent: {}", e)))?;
    parse_torrent_data(&data)
}

fn parse_torrent_data(data: &[u8]) -> AppResult<Json<InspectResponse>> {
    let (root, _) = bencode::parse(data)
        .map_err(|e| AppError::Internal(format!("Failed to parse .torrent: {}", e)))?;

    let info = root.get("info")
        .ok_or_else(|| AppError::Internal("Missing info dict in .torrent".into()))?;

    let name = info.get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown")
        .to_string();
    // Single file torrent
    if let Some(length) = info.get("length").and_then(|v| v.as_int()) {
        return Ok(Json(InspectResponse {
            name: name.clone(),
            files: vec![TorrentFile {
                index: 0,
                name: name.clone(),
                size_bytes: length as u64,
            }],
        }));
    }

    // Multi-file torrent
    let files_value = info.get("files")
        .ok_or_else(|| AppError::Internal("Missing files/length in .torrent info".into()))?;

    if let bencode::Value::List(file_list) = files_value {
        let mut files = Vec::new();
        for (idx, f) in file_list.iter().enumerate() {
            let length = f.get("length")
                .and_then(|v| v.as_int())
                .unwrap_or(0) as u64;

            let path_parts = f.get("path")
                .and_then(|v| {
                    if let bencode::Value::List(parts) = v {
                        Some(parts.iter()
                            .filter_map(|p| p.as_str())
                            .collect::<Vec<_>>()
                            .join("/"))
                    } else {
                        None
                    }
                })
                .unwrap_or_else(|| format!("file_{}", idx));

            files.push(TorrentFile {
                index: idx,
                name: path_parts,
                size_bytes: length,
            });
        }

        return Ok(Json(InspectResponse { name, files }));
    }

    Err(AppError::Internal("Unexpected files structure in .torrent".into()))
}
