//! Graphu's rules and storage, with no web server and no screen attached.
//!
//! ```text
//!  document text + AI proposals ──▶ grounding ──▶ pending claims ──▶ student review ──▶ graph
//!                                   (ground.rs)    (store.rs)                          (view in store.rs)
//! ```
//!
//! The Axum server and, later, the Tauri desktop shell both call into [`Graphu`].

mod error;
pub mod graph;
pub mod ground;
mod model;
mod sample;
mod store;

pub use error::{Error, Result};
pub use model::*;
pub use store::Graphu;

/// The content hash that identifies a document. Uploading the same bytes twice is blocked.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}
