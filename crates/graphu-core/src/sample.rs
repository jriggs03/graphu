//! The built-in sample notebooks. `samples.json` is generated from `web/src/sample/data.ts`,
//! so the browser-only build and the server show the same sample. These notes were written
//! for Graphu; they are not course documents.

use serde::Deserialize;

use crate::model::Candidate;

#[derive(Deserialize, Clone)]
pub(crate) struct SampleDoc {
    pub id: String,
    pub name: String,
    pub context: String,
    pub created_at: String,
    pub pages: Vec<String>,
    pub items: Vec<Candidate>,
    /// `approved` or `pending`: the review decision applied when the sample is first created.
    pub status: String,
}

#[derive(Deserialize)]
pub(crate) struct ManualConcept {
    pub title: String,
    pub symbol: String,
    pub comment: String,
    /// The topic it sits in, as a path. Empty for the top level.
    #[serde(default)]
    pub topic: String,
}

#[derive(Deserialize)]
pub(crate) struct Manual {
    pub created_at: String,
    pub concepts: Vec<ManualConcept>,
    pub links: Vec<(String, String)>,
}

#[derive(Deserialize)]
pub(crate) struct SampleNotebook {
    pub id: String,
    pub title: String,
    pub docs: Vec<SampleDoc>,
    pub packs: Vec<SampleDoc>,
    pub manual: Manual,
    pub target: Option<String>,
}

pub(crate) fn notebooks() -> Vec<SampleNotebook> {
    serde_json::from_str(include_str!("samples.json")).expect("samples.json is valid")
}

pub(crate) fn packs(notebook: &str) -> Vec<SampleDoc> {
    notebooks().into_iter().find(|item| item.id == notebook).map(|item| item.packs).unwrap_or_default()
}
