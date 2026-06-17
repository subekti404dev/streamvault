use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct Manifest {
    pub id: String,
    pub version: String,
    pub name: String,
    pub description: String,
    pub resources: Vec<String>,
    #[serde(rename = "types")]
    pub types_: Vec<String>,
    pub catalogs: Vec<CatalogDescriptor>,
    pub id_prefixes: Vec<String>,
    #[serde(rename = "behaviorHints")]
    pub behavior_hints: BehaviorHints,
}

#[derive(Debug, Serialize)]
pub struct CatalogDescriptor {
    #[serde(rename = "type")]
    pub type_: String,
    pub id: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct BehaviorHints {
    pub configurable: bool,
    #[serde(rename = "configurationRequired")]
    pub configuration_required: bool,
}

#[derive(Debug, Serialize)]
pub struct MetaResponse {
    pub metas: Vec<MetaPreview>,
}

#[derive(Debug, Serialize)]
pub struct MetaPreview {
    pub id: String,
    #[serde(rename = "type")]
    pub type_: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poster: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub year: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct StreamResponse {
    pub streams: Vec<Stream>,
}

#[derive(Debug, Serialize)]
pub struct Stream {
    pub name: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}
