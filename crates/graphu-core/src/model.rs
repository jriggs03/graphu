//! The shapes the frontend reads. Field names match `web/src/api.ts` exactly, so the
//! server (and later Tauri) can hand these straight to the UI as JSON.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pending,
    Approved,
    Rejected,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Pending => "pending",
            Status::Approved => "approved",
            Status::Rejected => "rejected",
        }
    }

    pub(crate) fn parse(value: &str) -> Status {
        match value {
            "approved" => Status::Approved,
            "rejected" => Status::Rejected,
            _ => Status::Pending,
        }
    }
}

/// One AI proposal before it is checked. Mirrors `Candidate` in `backend/extraction.py`.
/// A concept has an empty `target` and `relation`. A link says "`title` relies on `target`".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Candidate {
    pub title: String,
    #[serde(default)]
    pub target: String,
    #[serde(default)]
    pub relation: String,
    pub page: i64,
    pub quote: String,
    #[serde(default)]
    pub symbol: Option<String>,
}

/// One quote on one page of one document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Evidence {
    pub claim_id: i64,
    pub batch_id: String,
    pub source_id: String,
    pub source: String,
    pub page: i64,
    pub quote: String,
    pub status: Status,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Concept {
    pub id: String,
    pub label: String,
    pub symbol: String,
    /// `Pending` concepts are previews. They are not part of the graph yet.
    pub status: Status,
    /// True when no approved source quote backs it: the "Not in slide !" marker.
    pub user_added: bool,
    pub evidence: Vec<Evidence>,
    pub comment: String,
}

/// `from` relies on `to`: `from` is the dependent, `to` is the prerequisite.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Edge {
    pub id: String,
    pub from: String,
    pub to: String,
    pub relation: String,
    pub status: Status,
    pub user_added: bool,
    pub evidence: Vec<Evidence>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaimKind {
    Concept,
    Edge,
}

/// One proposal (or one thing the student added). The unit of review and undo.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Claim {
    pub id: i64,
    pub batch_id: String,
    pub kind: ClaimKind,
    pub title: String,
    pub target: String,
    pub relation: String,
    pub concept_id: String,
    pub target_id: String,
    pub quote: String,
    pub page: i64,
    pub source: String,
    pub status: Status,
    /// A link can only be approved once both of its concepts are approved.
    pub ready: bool,
    /// True when this adds evidence to something already in the graph.
    pub merge: bool,
}

/// One upload, or the student's own additions. Undo works on a whole batch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Batch {
    pub id: String,
    /// `upload`, `sample` or `manual`.
    pub kind: String,
    pub name: String,
    pub context: String,
    pub created_at: String,
    pub undone: bool,
    /// Proposals dropped because their quote was not found on the cited page.
    pub dropped: i64,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Source {
    pub id: String,
    pub name: String,
    pub batch_id: String,
    pub pages: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Notebook {
    pub id: String,
    pub title: String,
    pub concepts: Vec<Concept>,
    pub edges: Vec<Edge>,
    pub claims: Vec<Claim>,
    pub batches: Vec<Batch>,
    pub sources: Vec<Source>,
    /// The concept the student said they want to learn, if any.
    pub target: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NotebookSummary {
    pub id: String,
    pub title: String,
    pub concepts: usize,
    pub pending: usize,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AddResult {
    pub name: String,
    pub batch_id: Option<String>,
    pub duplicate: bool,
    pub count: usize,
    pub dropped: usize,
    /// False when the document could not be read (for example, no AI key on the server).
    pub extracted: bool,
    /// Why nothing was read, or how the text was obtained (for example, an AI transcription).
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SamplePack {
    pub id: String,
    pub name: String,
    pub context: String,
}

/// A document ready to be stored: its text per page, and what the AI proposed from it.
#[derive(Debug, Clone, Default)]
pub struct NewDocument {
    /// SHA-256 of the file bytes. See [`crate::sha256_hex`].
    pub source_id: String,
    pub name: String,
    /// What the student said this material is ("week 6 slides").
    pub context: String,
    pub pages: Vec<String>,
    pub items: Vec<Candidate>,
    /// False when nothing was read from the file. `note` should then say why.
    pub extracted: bool,
    pub note: String,
}
