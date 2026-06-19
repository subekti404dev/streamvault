# Stremio Library Catalog — Proxy Cinemeta

## Problem

Saat ini catalog cuma nampilin movie (gak ada series), meta handler return empty kalau `cached_meta` kosong.

## Solusi

1. **Catalog** — list IMDB IDs dari completed jobs (movie flat, series group by IMDB ID)
2. **Meta** — proxy Cinemeta, pass-through. Stremio dapet poster, description, cast, dll gratis
3. **Stream** — udah ada, gak berubah

Data di jobs table cuma: `imdb_id`, `media_type`, `title`, `season`, `episode`. Itu cukup.

---

## Perubahan

### 1. Manifest — tambah series catalog

**File**: `backend/src/stremio/routes.rs`

```rust
catalogs: vec![
    CatalogDescriptor { type_: "movie".into(), id: "streamvault-movie".into(), name: "StreamVault Movies".into() },
    CatalogDescriptor { type_: "series".into(), id: "streamvault-series".into(), name: "StreamVault Series".into() },
],
```

### 2. Catalog handler — group series by IMDB ID

```rust
pub async fn catalog_handler(
    State(state): State<Arc<AppState>>,
    Path((type_, _catalog_id)): Path<(String, String)>,
) -> Json<MetaResponse> {
    let completed = queries::list_jobs_by_status(&state.db, "completed").await
        .unwrap_or_default();

    let metas = match type_.as_str() {
        "movie" => {
            completed.iter()
                .filter(|j| j.media_type == "movie")
                .map(|j| MetaPreview {
                    id: j.imdb_id.clone(),
                    type_: "movie".into(),
                    name: j.title.clone().unwrap_or_default(),
                    poster: None,  // Stremio fetch sendiri dari Cinemeta
                    year: None,
                })
                .collect()
        }
        "series" => {
            let mut seen = std::collections::HashSet::new();
            completed.iter()
                .filter(|j| j.media_type == "series" && seen.insert(&j.imdb_id))
                .map(|j| MetaPreview {
                    id: j.imdb_id.clone(),
                    type_: "series".into(),
                    name: j.title.clone().unwrap_or_default(),
                    poster: None,
                    year: None,
                })
                .collect()
        }
        _ => vec![],
    };

    Json(MetaResponse { metas })
}
```

### 3. Meta handler — proxy Cinemeta

```rust
pub async fn meta_handler(
    State(state): State<Arc<AppState>>,
    Path((type_, imdb_id)): Path<(String, String)>,
) -> Json<serde_json::Value> {
    let imdb_id = imdb_id.strip_suffix(".json").unwrap_or(&imdb_id);
    let url = format!("https://v3-cinemeta.strem.io/meta/{}/{}.json", type_, imdb_id);

    match state.http.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let mut body: serde_json::Value = resp.json().await.unwrap_or_default();
            // Inject our streamVault source info
            if let Some(meta) = body.get_mut("meta") {
                if let Some(obj) = meta.as_object_mut() {
                    obj.insert("streamVault".into(),
                        serde_json::json!({"available": true}));
                }
            }
            Json(body)
        }
        _ => Json(serde_json::json!({"meta": {}})),
    }
}
```

Return type: `Json<serde_json::Value>` — passthrough, gak perlu struct baru.

### 4. Stream handler — create_job jika belum ada

Stream handler udah bikin job otomatis waktu user play. Catalog cm nampilin **completed** jobs.

---

## Files Changed

| File | Perubahan |
|------|-----------|
| `backend/src/stremio/routes.rs` | manifest: +series catalog, catalog: group series, meta: proxy Cinemeta |
| `backend/src/app.rs` | update route return type untuk meta_handler (Value, bukan MetaResponse) |

## Yang gak berubah

- DB — no migration
- `queries.rs` — no change
- `models.rs` — no change (meta return raw JSON)
- Search — no change
- Stream — no change

## Flow di Stremio

```
User browse catalog:
  /catalog/movie/streamvault-movie.json
    → [{ id: "tt1234567", type: "movie", name: "Project Hail Mary" }, ...]

User pilih movie → Stremio fetch meta:
  /meta/movie/tt1234567.json
    → proxy Cinemeta → { meta: { name, poster, description, ... } }

User play → Stremio fetch stream:
  /stream/movie/tt1234567.json
    → existing handler → return HLS URL
```

Cinemeta handle semua metadata (poster, rating, cast, dll). Kita cuma nyediain IMDB ID.
