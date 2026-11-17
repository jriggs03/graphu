//! Storage and review rules. Every proposal is a row in `claims`; the graph the UI draws is
//! worked out from those rows each time it is read, so undo never has to rewrite history.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{Error, Result};
use crate::ground::{grounded_items, key_of, normalize};
use crate::model::*;
use crate::sample::{self, SampleDoc};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS notebooks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, updated_at TEXT NOT NULL, target TEXT
);
CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY,
    notebook_id TEXT NOT NULL REFERENCES notebooks(id),
    kind TEXT NOT NULL CHECK (kind IN ('upload', 'sample', 'manual')),
    name TEXT NOT NULL, context TEXT NOT NULL, created_at TEXT NOT NULL,
    undone INTEGER NOT NULL DEFAULT 0, dropped INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sources (
    notebook_id TEXT NOT NULL REFERENCES notebooks(id),
    id TEXT NOT NULL, name TEXT NOT NULL, batch_id INTEGER NOT NULL REFERENCES batches(id),
    PRIMARY KEY (notebook_id, id)
);
CREATE TABLE IF NOT EXISTS pages (
    notebook_id TEXT NOT NULL, source_id TEXT NOT NULL, page INTEGER NOT NULL, text TEXT NOT NULL,
    PRIMARY KEY (notebook_id, source_id, page)
);
CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY,
    notebook_id TEXT NOT NULL REFERENCES notebooks(id),
    batch_id INTEGER NOT NULL REFERENCES batches(id),
    source_id TEXT,
    title TEXT NOT NULL, target TEXT NOT NULL, relation TEXT NOT NULL, symbol TEXT NOT NULL,
    title_key TEXT NOT NULL, target_key TEXT NOT NULL, relation_key TEXT NOT NULL,
    page INTEGER NOT NULL, quote TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected'))
);
CREATE TABLE IF NOT EXISTS linked_evidence (
    claim_id INTEGER PRIMARY KEY REFERENCES claims(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL, page INTEGER NOT NULL, quote TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS claims_by_notebook ON claims(notebook_id);
CREATE TABLE IF NOT EXISTS visuals (
    notebook_id TEXT NOT NULL REFERENCES notebooks(id), concept_id TEXT NOT NULL,
    svg TEXT NOT NULL, caption TEXT NOT NULL,
    PRIMARY KEY (notebook_id, concept_id)
);
CREATE TABLE IF NOT EXISTS symbols (
    notebook_id TEXT NOT NULL REFERENCES notebooks(id), concept_id TEXT NOT NULL, symbol TEXT NOT NULL,
    PRIMARY KEY (notebook_id, concept_id)
);
CREATE TABLE IF NOT EXISTS extractions (key TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS parents (
    notebook_id TEXT NOT NULL REFERENCES notebooks(id), concept_id TEXT NOT NULL, parent_id TEXT NOT NULL,
    PRIMARY KEY (notebook_id, concept_id)
);
CREATE TABLE IF NOT EXISTS comments (
    notebook_id TEXT NOT NULL REFERENCES notebooks(id), concept_id TEXT NOT NULL, text TEXT NOT NULL,
    PRIMARY KEY (notebook_id, concept_id)
);
";

/// A Graphu workspace backed by one SQLite file.
pub struct Graphu {
    conn: Connection,
}

struct ClaimRow {
    id: i64,
    batch_id: i64,
    source_id: Option<String>,
    title: String,
    target: String,
    relation: String,
    symbol: String,
    heading: String,
    snippet: String,
    topic: String,
    page: i64,
    quote: String,
    status: Status,
}

impl Graphu {
    /// Open (or create) the workspace at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::init(Connection::open(path)?)
    }

    /// A workspace that lives only in memory. Used by tests.
    pub fn in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        // The Python backend used a different layout. Refuse its file instead of mixing the two.
        if exists(&conn, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'proposals'", [])? {
            return Err(Error::Invalid(
                "This database belongs to the Python backend. Point GRAPHU_DB at a different file.".into()));
        }
        conn.execute_batch(SCHEMA)?;
        // Databases made before headings, snippets and topics existed gain the columns here.
        for column in ["heading", "snippet", "topic"] {
            if !exists(&conn, "SELECT 1 FROM pragma_table_info('claims') WHERE name = ?1", params![column])? {
                conn.execute_batch(&format!("ALTER TABLE claims ADD COLUMN {column} TEXT NOT NULL DEFAULT ''"))?;
            }
        }
        Ok(Self { conn })
    }

    /* ---------- notebooks ---------- */

    pub fn list_notebooks(&self) -> Result<Vec<NotebookSummary>> {
        let mut statement = self.conn.prepare("SELECT id, updated_at FROM notebooks ORDER BY updated_at DESC, id")?;
        let rows: Vec<(String, String)> =
            statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        rows.into_iter().map(|(id, updated_at)| Ok(summary(&view(&self.conn, &id)?, updated_at))).collect()
    }

    pub fn create_notebook(&mut self, title: &str) -> Result<NotebookSummary> {
        let title: String = normalize(title).chars().take(80).collect();
        let title = if title.is_empty() { "Untitled graphbook".to_string() } else { title };
        let tx = self.conn.transaction()?;
        let next: i64 = tx.query_row("SELECT COUNT(*) + 1 FROM notebooks", [], |row| row.get(0))?;
        // After a deletion the count can repeat, so the loop below keeps the id unique.
        let mut id = format!("n{next}");
        while exists(&tx, "SELECT 1 FROM notebooks WHERE id = ?1", params![id])? {
            id.push('x');
        }
        let stamp = now(&tx)?;
        tx.execute("INSERT INTO notebooks (id, title, updated_at) VALUES (?1, ?2, ?3)", params![id, title, stamp])?;
        tx.commit()?;
        Ok(NotebookSummary { id, title, concepts: 0, pending: 0, updated_at: stamp })
    }

    pub fn rename_notebook(&mut self, id: &str, title: &str) -> Result<NotebookSummary> {
        let title: String = normalize(title).chars().take(80).collect();
        if title.is_empty() {
            return Err(Error::Invalid("Give the graphbook a name.".into()));
        }
        let tx = self.conn.transaction()?;
        require_notebook(&tx, id)?;
        tx.execute("UPDATE notebooks SET title = ?2 WHERE id = ?1", params![id, title])?;
        touch(&tx, id)?;
        tx.commit()?;
        let updated_at = now(&self.conn)?;
        Ok(summary(&view(&self.conn, id)?, updated_at))
    }

    /// Delete a graphbook and everything in it. This cannot be undone.
    /// The built-in samples are kept, so the app always has something to show.
    pub fn delete_notebook(&mut self, id: &str) -> Result<()> {
        if crate::sample::notebooks().iter().any(|sample| sample.id == id) {
            return Err(Error::Conflict("The built-in samples cannot be deleted.".into()));
        }
        let tx = self.conn.transaction()?;
        require_notebook(&tx, id)?;
        for table in ["symbols", "visuals", "comments", "parents", "claims", "pages", "sources", "batches"] {
            tx.execute(&format!("DELETE FROM {table} WHERE notebook_id = ?1"), params![id])?;
        }
        tx.execute("DELETE FROM notebooks WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    /// Everything the UI needs to draw one notebook.
    pub fn get_notebook(&self, id: &str) -> Result<Notebook> {
        view(&self.conn, id)
    }

    /* ---------- adding material ---------- */

    /// True when this exact file (by content hash) is already in the notebook.
    /// The server checks this first so a duplicate never costs an AI call.
    pub fn has_source(&self, notebook: &str, source_id: &str) -> Result<bool> {
        exists(&self.conn, "SELECT 1 FROM sources WHERE notebook_id = ?1 AND id = ?2", params![notebook, source_id])
    }

    /// What the AI answered the last time it was given exactly this input, if ever.
    /// `key` is a hash of the file, the student's note about it, the concepts already in the
    /// graph and the model, so the same file added again gives the same proposals.
    pub fn saved_extraction(&self, key: &str) -> Result<Option<String>> {
        let mut statement = self.conn.prepare("SELECT body FROM extractions WHERE key = ?1")?;
        let mut rows = statement.query(params![key])?;
        Ok(match rows.next()? { Some(row) => Some(row.get(0)?), None => None })
    }

    /// Remember the AI's answer for `key`. The first answer is kept; later ones never replace it.
    pub fn save_extraction(&self, key: &str, body: &str) -> Result<()> {
        self.conn.execute("INSERT OR IGNORE INTO extractions (key, body) VALUES (?1, ?2)", params![key, body])?;
        Ok(())
    }

    /// Store one document as a new batch.
    ///
    /// in:  page text plus the AI's proposals
    /// does: grounding check, skips anything the student already rejected
    /// out: how many proposals are now waiting for review, and how many were dropped
    pub fn add_document(&mut self, notebook: &str, document: NewDocument) -> Result<AddResult> {
        let tx = self.conn.transaction()?;
        require_notebook(&tx, notebook)?;
        let name = document.name.replace('\\', "/");
        let name: String = name.rsplit('/').next().unwrap_or("").trim().chars().take(180).collect();
        let name = if name.is_empty() { "Document".to_string() } else { name };
        let context: String = normalize(&document.context).chars().take(300).collect();
        let mut result = add_doc(&tx, notebook, "upload", &document.source_id, &name, &context, &document.note,
            &document.pages, &document.items, None)?;
        result.extracted = document.extracted && !result.duplicate;
        touch(&tx, notebook)?;
        tx.commit()?;
        Ok(result)
    }

    /* ---------- the built-in sample ---------- */

    /// Create the sample notebooks if they are missing, so the app works with no API key.
    pub fn ensure_samples(&mut self) -> Result<()> {
        let tx = self.conn.transaction()?;
        for notebook in sample::notebooks() {
            if exists(&tx, "SELECT 1 FROM notebooks WHERE id = ?1", params![notebook.id])? {
                continue;
            }
            tx.execute("INSERT INTO notebooks (id, title, updated_at, target) VALUES (?1, ?2, '', ?3)",
                params![notebook.id, notebook.title, notebook.target])?;
            let mut latest = String::new();
            for doc in &notebook.docs {
                let added = add_sample(&tx, &notebook.id, doc, Some(&doc.created_at))?;
                if doc.status == "approved" {
                    tx.execute("UPDATE claims SET status = 'approved' WHERE batch_id = ?1", params![added.batch_id])?;
                }
                latest = latest.max(doc.created_at.clone());
            }
            if !notebook.manual.concepts.is_empty() {
                let batch = new_batch(&tx, &notebook.id, "manual", "Added by you", "", "", Some(&notebook.manual.created_at))?;
                for concept in &notebook.manual.concepts {
                    insert_claim(&tx, &notebook.id, batch, None, &concept.title, "", "", &concept.symbol, 0, "", Status::Approved)?;
                    tx.execute("UPDATE claims SET topic = ?2 WHERE id = ?1",
                        params![tx.last_insert_rowid(), crate::ground::topic_path(&concept.topic)])?;
                    tx.execute("INSERT INTO comments VALUES (?1, ?2, ?3)",
                        params![notebook.id, key_of(&concept.title), concept.comment])?;
                }
                for (from, to) in &notebook.manual.links {
                    insert_claim(&tx, &notebook.id, batch, None, from, to, "relies on", "", 0, "", Status::Approved)?;
                }
            }
            tx.execute("UPDATE notebooks SET updated_at = ?2 WHERE id = ?1", params![notebook.id, latest])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Extra sample material that can still be added to this notebook.
    pub fn list_sample_packs(&self, notebook: &str) -> Result<Vec<SamplePack>> {
        require_notebook(&self.conn, notebook)?;
        let mut packs = Vec::new();
        for pack in sample::packs(notebook) {
            if !self.has_source(notebook, &pack.id)? {
                packs.push(SamplePack { id: pack.id, name: pack.name, context: pack.context });
            }
        }
        Ok(packs)
    }

    pub fn add_sample_pack(&mut self, notebook: &str, pack: &str) -> Result<AddResult> {
        let tx = self.conn.transaction()?;
        require_notebook(&tx, notebook)?;
        let doc = sample::packs(notebook).into_iter().find(|doc| doc.id == pack)
            .ok_or_else(|| Error::NotFound("Sample material not found.".into()))?;
        let result = add_sample(&tx, notebook, &doc, None)?.result;
        touch(&tx, notebook)?;
        tx.commit()?;
        Ok(result)
    }

    /* ---------- review and undo ---------- */

    /// Approve or reject one proposal. `Status::Pending` is the per-item undo.
    pub fn review_claim(&mut self, notebook: &str, claim: i64, status: Status) -> Result<Notebook> {
        let tx = self.conn.transaction()?;
        set_status(&tx, notebook, claim, status)?;
        touch(&tx, notebook)?;
        tx.commit()?;
        self.get_notebook(notebook)
    }

    /// Approve or reject everything still pending in one batch.
    pub fn review_batch(&mut self, notebook: &str, batch: &str, status: Status) -> Result<Notebook> {
        let batch = batch_id(batch)?;
        let tx = self.conn.transaction()?;
        require_batch(&tx, notebook, batch)?;
        let pending = |only_concepts: bool| -> Result<Vec<i64>> {
            let mut statement = tx.prepare(
                "SELECT id FROM claims WHERE batch_id = ?1 AND status = 'pending' AND (?2 = 0 OR target = '') ORDER BY id")?;
            let ids = statement.query_map(params![batch, only_concepts], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
            Ok(ids)
        };
        // Concepts first, so that links between them become approvable.
        for id in pending(true)? {
            set_status(&tx, notebook, id, status)?;
        }
        for id in pending(false)? {
            let ready = view(&tx, notebook)?.claims.iter().any(|claim| claim.id == id && claim.ready);
            if status == Status::Rejected || ready {
                set_status(&tx, notebook, id, status)?;
            }
        }
        touch(&tx, notebook)?;
        tx.commit()?;
        self.get_notebook(notebook)
    }

    /// Per-batch undo and restore. An undone batch is kept, never deleted.
    pub fn set_batch_undone(&mut self, notebook: &str, batch: &str, undone: bool) -> Result<Notebook> {
        let batch = batch_id(batch)?;
        let tx = self.conn.transaction()?;
        require_batch(&tx, notebook, batch)?;
        tx.execute("UPDATE batches SET undone = ?2 WHERE id = ?1", params![batch, undone])?;
        touch(&tx, notebook)?;
        tx.commit()?;
        self.get_notebook(notebook)
    }

    pub fn set_batch_note(&mut self, notebook: &str, batch: &str, note: &str) -> Result<()> {
        let batch = batch_id(batch)?;
        require_batch(&self.conn, notebook, batch)?;
        self.conn.execute("UPDATE batches SET note = ?3 WHERE notebook_id = ?1 AND id = ?2", params![notebook, batch, note])?;
        Ok(())
    }

    /// Validate both passages using stored pages; one claim owns the two quotes so review is atomic.
    /// Attach links to this upload's batch so undoing the upload also undoes its connection pass.
    pub fn add_linked(&mut self, notebook: &str, batch: &str, items: &[LinkedCandidate]) -> Result<usize> {
        let tx = self.conn.transaction()?;
        let batch = batch_id(batch)?;
        require_batch(&tx, notebook, batch)?;
        let shown = view(&tx, notebook)?;
        if shown.batches.iter().any(|b| b.id == batch.to_string() && b.undone) {
            return Ok(0);
        }
        let mut count = 0;
        for item in items.iter().take(60) {
            let (title, target, relation) = (normalize(&item.title), normalize(&item.target), normalize(&item.relation));
            let (a, b) = (normalize(&item.quote_a), normalize(&item.quote_b));
            let from = key_of(&title);
            let to = key_of(&target);
            if from == to || relation.is_empty() || relation.chars().count() > 60
                || !shown.concepts.iter().any(|c| c.id == from)
                || !shown.concepts.iter().any(|c| c.id == to) {
                continue;
            }
            let on_page = |source: &str, page: i64, quote: &str| {
                (12..=800).contains(&quote.chars().count()) && page > 0 && shown.sources.iter()
                    .find(|s| s.id == source).and_then(|s| s.pages.get((page - 1) as usize))
                    .is_some_and(|text| normalize(text).contains(quote))
            };
            if !on_page(&item.source_a, item.page_a, &a) || !on_page(&item.source_b, item.page_b, &b)
                || !mentions_name(&a, &target) {
                continue;
            }
            // The graph has one link per ordered pair. Do not revive a rejected pair by
            // rephrasing its relation, or duplicate an existing pending/approved claim.
            if exists(&tx, "SELECT 1 FROM claims WHERE notebook_id = ?1 AND title_key = ?2 AND target_key = ?3",
                params![notebook, from, to])? {
                continue;
            }
            insert_claim(&tx, notebook, batch, Some(&item.source_a), &title, &target, &relation,
                "", item.page_a, &a, Status::Pending)?;
            let claim = tx.last_insert_rowid();
            tx.execute("INSERT INTO linked_evidence VALUES (?1, ?2, ?3, ?4)",
                params![claim, item.source_b, item.page_b, b])?;
            count += 1;
        }
        touch(&tx, notebook)?;
        tx.commit()?;
        Ok(count)
    }

    /* ---------- the student's own additions ---------- */

    /// Add a concept by hand. It goes straight into the graph, marked as having no source.
    pub fn add_concept(&mut self, notebook: &str, label: &str) -> Result<Notebook> {
        let title = normalize(label);
        if title.is_empty() || title.chars().count() > 80 {
            return Err(Error::Invalid("Give the concept a name of up to 80 characters.".into()));
        }
        let tx = self.conn.transaction()?;
        if view(&tx, notebook)?.concepts.iter().any(|concept| concept.id == key_of(&title)) {
            return Err(Error::Conflict(format!("“{title}” is already in this notebook.")));
        }
        let batch = manual_batch(&tx, notebook)?;
        insert_claim(&tx, notebook, batch, None, &title, "", "", "", 0, "", Status::Approved)?;
        touch(&tx, notebook)?;
        tx.commit()?;
        self.get_notebook(notebook)
    }

    /// Add a "relies on" link by hand between two concepts that are already in the graph.
    pub fn add_edge(&mut self, notebook: &str, from: &str, to: &str) -> Result<Notebook> {
        let tx = self.conn.transaction()?;
        let shown = view(&tx, notebook)?;
        let label = |id: &str| shown.concepts.iter()
            .find(|concept| concept.id == id && concept.status == Status::Approved).map(|concept| concept.label.clone());
        let (Some(a), Some(b)) = (label(from), label(to)) else {
            return Err(Error::Invalid("Pick two different concepts that are in the graph.".into()));
        };
        if from == to {
            return Err(Error::Invalid("Pick two different concepts that are in the graph.".into()));
        }
        if shown.edges.iter().any(|edge| edge.from == from && edge.to == to) {
            return Err(Error::Conflict("That link already exists.".into()));
        }
        let batch = manual_batch(&tx, notebook)?;
        insert_claim(&tx, notebook, batch, None, &a, &b, "relies on", "", 0, "", Status::Approved)?;
        touch(&tx, notebook)?;
        tx.commit()?;
        self.get_notebook(notebook)
    }

    pub fn set_comment(&mut self, notebook: &str, concept: &str, text: &str) -> Result<Notebook> {
        let tx = self.conn.transaction()?;
        require_notebook(&tx, notebook)?;
        let text: String = text.trim().chars().take(2000).collect();
        tx.execute("DELETE FROM comments WHERE notebook_id = ?1 AND concept_id = ?2", params![notebook, concept])?;
        if !text.is_empty() {
            tx.execute("INSERT INTO comments VALUES (?1, ?2, ?3)", params![notebook, concept, text])?;
        }
        touch(&tx, notebook)?;
        tx.commit()?;
        self.get_notebook(notebook)
    }

    /// Set the short symbol drawn inside a concept's node. The student's choice wins over
    /// whatever the AI proposed. An empty symbol goes back to the proposed one.
    pub fn set_symbol(&mut self, notebook: &str, concept: &str, symbol: &str) -> Result<Notebook> {
        let symbol = normalize(symbol);
        if symbol.chars().count() > 12 {
            return Err(Error::Invalid("Keep the symbol to 12 characters or fewer.".into()));
        }
        let tx = self.conn.transaction()?;
        if !view(&tx, notebook)?.concepts.iter().any(|item| item.id == concept) {
            return Err(Error::NotFound("Concept not found.".into()));
        }
        tx.execute("DELETE FROM symbols WHERE notebook_id = ?1 AND concept_id = ?2", params![notebook, concept])?;
        if !symbol.is_empty() {
            tx.execute("INSERT INTO symbols VALUES (?1, ?2, ?3)", params![notebook, concept, symbol])?;
        }
        touch(&tx, notebook)?;
        tx.commit()?;
        self.get_notebook(notebook)
    }

    /// Save the AI-drawn picture for a concept, replacing any earlier one.
    /// The picture is refused if it could run code or load anything from outside.
    pub fn set_visual(&mut self, notebook: &str, concept: &str, svg: &str, caption: &str) -> Result<Notebook> {
        let svg = svg.trim();
        let lower = svg.to_lowercase();
        let unsafe_parts = ["<script", "<foreignobject", "javascript:", "<iframe", "<image", "href=\"http"];
        // " on" followed by a letter and "=" would be an event handler such as onload=.
        let handler = lower.split(" on").skip(1).any(|rest| {
            let name: String = rest.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
            !name.is_empty() && rest[name.len()..].trim_start().starts_with('=')
        });
        if !lower.starts_with("<svg") || svg.chars().count() > 30_000
            || unsafe_parts.iter().any(|part| lower.contains(part)) || handler {
            return Err(Error::Invalid("That picture could not be used.".into()));
        }
        let tx = self.conn.transaction()?;
        if !view(&tx, notebook)?.concepts.iter().any(|item| item.id == concept) {
            return Err(Error::NotFound("Concept not found.".into()));
        }
        let caption: String = normalize(caption).chars().take(200).collect();
        tx.execute("INSERT OR REPLACE INTO visuals VALUES (?1, ?2, ?3, ?4)", params![notebook, concept, svg, caption])?;
        touch(&tx, notebook)?;
        tx.commit()?;
        self.get_notebook(notebook)
    }

    /// Move a concept (or a topic) into another topic. `None` moves it to the top level.
    /// The student's choice wins over the topic the AI proposed.
    pub fn set_parent(&mut self, notebook: &str, concept: &str, parent: Option<&str>) -> Result<Notebook> {
        let tx = self.conn.transaction()?;
        let shown = view(&tx, notebook)?;
        let parent_of = |key: &str| shown.concepts.iter().find(|item| item.id == key).map(|item| item.parent.clone())
            .or_else(|| shown.topics.iter().find(|item| item.id == key).map(|item| item.parent.clone()));
        if parent_of(concept).is_none() {
            return Err(Error::NotFound("Concept not found.".into()));
        }
        let parent = parent.filter(|key| !key.is_empty());
        if let Some(up) = parent {
            // The new topic must exist and must not be the concept itself or something inside it.
            let mut current = Some(up.to_string());
            let mut steps = 0;
            while let Some(key) = current {
                if key == concept || steps > shown.concepts.len() + shown.topics.len() {
                    return Err(Error::Invalid("A topic cannot be moved inside itself.".into()));
                }
                let Some(next) = parent_of(&key) else {
                    return Err(Error::NotFound("Topic not found.".into()));
                };
                current = next;
                steps += 1;
            }
        }
        tx.execute("INSERT OR REPLACE INTO parents VALUES (?1, ?2, ?3)", params![notebook, concept, parent.unwrap_or("")])?;
        touch(&tx, notebook)?;
        tx.commit()?;
        self.get_notebook(notebook)
    }

    /// Set (or clear) the concept the student wants to learn.
    pub fn set_target(&mut self, notebook: &str, concept: Option<&str>) -> Result<Notebook> {
        let tx = self.conn.transaction()?;
        let shown = view(&tx, notebook)?;
        if let Some(id) = concept {
            if !shown.concepts.iter().any(|item| item.id == id && item.status == Status::Approved) {
                return Err(Error::Invalid("Pick a concept that is in the graph.".into()));
            }
        }
        tx.execute("UPDATE notebooks SET target = ?2 WHERE id = ?1", params![notebook, concept])?;
        touch(&tx, notebook)?;
        tx.commit()?;
        self.get_notebook(notebook)
    }
}

/* ---------- helpers ---------- */

fn exists(conn: &Connection, sql: &str, values: impl rusqlite::Params) -> Result<bool> {
    Ok(conn.query_row(sql, values, |_| Ok(())).optional()?.is_some())
}

fn now(conn: &Connection) -> Result<String> {
    Ok(conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now')", [], |row| row.get(0))?)
}

fn touch(conn: &Connection, notebook: &str) -> Result<()> {
    conn.execute("UPDATE notebooks SET updated_at = ?2 WHERE id = ?1", params![notebook, now(conn)?])?;
    Ok(())
}

fn require_notebook(conn: &Connection, notebook: &str) -> Result<()> {
    if exists(conn, "SELECT 1 FROM notebooks WHERE id = ?1", params![notebook])? {
        Ok(())
    } else {
        Err(Error::NotFound("Notebook not found.".into()))
    }
}

fn batch_id(batch: &str) -> Result<i64> {
    batch.parse().map_err(|_| Error::NotFound("Batch not found.".into()))
}

fn require_batch(conn: &Connection, notebook: &str, batch: i64) -> Result<()> {
    if exists(conn, "SELECT 1 FROM batches WHERE id = ?1 AND notebook_id = ?2", params![batch, notebook])? {
        Ok(())
    } else {
        Err(Error::NotFound("Batch not found.".into()))
    }
}

fn new_batch(conn: &Connection, notebook: &str, kind: &str, name: &str, context: &str, note: &str,
    created_at: Option<&str>) -> Result<i64> {
    let stamp = match created_at {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => now(conn)?,
    };
    conn.execute("INSERT INTO batches (notebook_id, kind, name, context, created_at, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![notebook, kind, name, context, stamp, note])?;
    Ok(conn.last_insert_rowid())
}

fn manual_batch(conn: &Connection, notebook: &str) -> Result<i64> {
    let found: Option<i64> = conn.query_row(
        "SELECT id FROM batches WHERE notebook_id = ?1 AND kind = 'manual' AND undone = 0 ORDER BY id LIMIT 1",
        params![notebook], |row| row.get(0)).optional()?;
    match found {
        Some(id) => Ok(id),
        None => new_batch(conn, notebook, "manual", "Added by you", "", "", None),
    }
}

#[allow(clippy::too_many_arguments)]
fn insert_claim(conn: &Connection, notebook: &str, batch: i64, source: Option<&str>, title: &str, target: &str,
    relation: &str, symbol: &str, page: i64, quote: &str, status: Status) -> Result<()> {
    conn.execute(
        "INSERT INTO claims (notebook_id, batch_id, source_id, title, target, relation, symbol,
                             title_key, target_key, relation_key, page, quote, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![notebook, batch, source, title, target, relation, symbol,
            key_of(title), key_of(target), key_of(relation), page, quote, status.as_str()])?;
    Ok(())
}

struct Added {
    batch_id: i64,
    result: AddResult,
}

fn add_sample(conn: &Connection, notebook: &str, doc: &SampleDoc, created_at: Option<&str>) -> Result<Added> {
    let result = add_doc(conn, notebook, "sample", &doc.id, &doc.name, &doc.context, "", &doc.pages, &doc.items, created_at)?;
    let batch_id = result.batch_id.as_deref().and_then(|id| id.parse().ok()).unwrap_or(0);
    Ok(Added { batch_id, result })
}

/// Ground the proposals, skip anything already rejected or already present, store the rest.
#[allow(clippy::too_many_arguments)]
fn add_doc(conn: &Connection, notebook: &str, kind: &str, source_id: &str, name: &str, context: &str, note: &str,
    pages: &[String], items: &[Candidate], created_at: Option<&str>) -> Result<AddResult> {
    if exists(conn, "SELECT 1 FROM sources WHERE notebook_id = ?1 AND id = ?2", params![notebook, source_id])? {
        return Ok(AddResult { name: name.into(), batch_id: None, duplicate: true, count: 0, dropped: 0, extracted: false, note: String::new() });
    }
    let batch = new_batch(conn, notebook, kind, name, context, note, created_at)?;
    conn.execute("INSERT INTO sources VALUES (?1, ?2, ?3, ?4)", params![notebook, source_id, name, batch])?;
    for (index, page) in pages.iter().enumerate() {
        conn.execute("INSERT INTO pages VALUES (?1, ?2, ?3, ?4)",
            params![notebook, source_id, index as i64 + 1, normalize(page)])?;
    }
    let grounded = grounded_items(items, pages);
    let dropped = items.len() - grounded.len();
    conn.execute("UPDATE batches SET dropped = ?2 WHERE id = ?1", params![batch, dropped as i64])?;
    let mut count = 0;
    for item in &grounded {
        let keys = params![notebook, key_of(&item.title), key_of(&item.target), key_of(&item.relation)];
        // A claim the student rejected is not proposed again.
        if exists(conn, "SELECT 1 FROM claims WHERE notebook_id = ?1 AND status = 'rejected'
                         AND title_key = ?2 AND target_key = ?3 AND relation_key = ?4", keys)? {
            continue;
        }
        if exists(conn, "SELECT 1 FROM claims WHERE notebook_id = ?1 AND source_id = ?2 AND title_key = ?3
                         AND target_key = ?4 AND relation_key = ?5 AND page = ?6 AND quote = ?7",
            params![notebook, source_id, key_of(&item.title), key_of(&item.target), key_of(&item.relation), item.page, item.quote])? {
            continue;
        }
        insert_claim(conn, notebook, batch, Some(source_id), &item.title, &item.target, &item.relation,
            item.symbol.as_deref().unwrap_or(""), item.page, &item.quote, Status::Pending)?;
        conn.execute("UPDATE claims SET heading = ?2, snippet = ?3, topic = ?4 WHERE id = ?1", params![
            conn.last_insert_rowid(), item.heading.as_deref().unwrap_or(""), item.snippet.as_deref().unwrap_or(""),
            item.topic.as_deref().unwrap_or("")])?;
        count += 1;
    }
    Ok(AddResult { name: name.into(), batch_id: Some(batch.to_string()), duplicate: false, count, dropped, extracted: true, note: note.into() })
}

fn set_status(conn: &Connection, notebook: &str, claim: i64, status: Status) -> Result<()> {
    let row: Option<(String, i64, String, String, String)> = conn.query_row(
        "SELECT status, batch_id, title_key, target_key, relation_key FROM claims WHERE id = ?1 AND notebook_id = ?2",
        params![claim, notebook], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).optional()?;
    let Some((current, batch, title_key, target_key, relation_key)) = row else {
        return Err(Error::NotFound("Proposal not found.".into()));
    };
    if exists(conn, "SELECT 1 FROM batches WHERE id = ?1 AND undone = 1", params![batch])? {
        return Err(Error::Conflict("This batch was undone. Restore it before reviewing its items.".into()));
    }
    if Status::parse(&current) == status {
        return Ok(());
    }
    if status == Status::Approved {
        let ready = view(conn, notebook)?.claims.iter().any(|item| item.id == claim && item.ready);
        if !ready {
            return Err(Error::Conflict("Approve both concepts before approving this link.".into()));
        }
    }
    let keys = params![notebook, title_key, target_key, relation_key];
    let same = "notebook_id = ?1 AND title_key = ?2 AND target_key = ?3 AND relation_key = ?4";
    if status == Status::Rejected
        && !exists(conn, &format!("SELECT 1 FROM claims WHERE {same} AND status = 'approved'"), keys)? {
        // Rejecting an idea rejects every pending copy of it, so it is not asked again.
        conn.execute(&format!("UPDATE claims SET status = 'rejected' WHERE {same} AND status = 'pending'"), keys)?;
    }
    conn.execute("UPDATE claims SET status = ?2 WHERE id = ?1", params![claim, status.as_str()])?;
    Ok(())
}

fn summary(shown: &Notebook, updated_at: String) -> NotebookSummary {
    let undone: HashSet<&str> = shown.batches.iter().filter(|batch| batch.undone).map(|batch| batch.id.as_str()).collect();
    NotebookSummary {
        id: shown.id.clone(),
        title: shown.title.clone(),
        updated_at,
        concepts: shown.concepts.iter().filter(|concept| concept.status == Status::Approved).count(),
        pending: shown.claims.iter()
            .filter(|claim| claim.status == Status::Pending && !undone.contains(claim.batch_id.as_str())).count(),
    }
}

/* ---------- reading: turn stored claims into the graph the UI draws ---------- */

fn view(conn: &Connection, id: &str) -> Result<Notebook> {
    let (title, target): (String, Option<String>) = conn
        .query_row("SELECT title, target FROM notebooks WHERE id = ?1", params![id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?
        .ok_or_else(|| Error::NotFound("Notebook not found.".into()))?;

    let mut statement = conn.prepare(
        "SELECT id, kind, name, context, created_at, undone, dropped, note FROM batches
         WHERE notebook_id = ?1 ORDER BY created_at, id")?;
    let batches: Vec<Batch> = statement.query_map(params![id], |row| Ok(Batch {
        id: row.get::<_, i64>(0)?.to_string(), kind: row.get(1)?, name: row.get(2)?, context: row.get(3)?,
        created_at: row.get(4)?, undone: row.get(5)?, dropped: row.get(6)?, note: row.get(7)?,
    }))?.collect::<rusqlite::Result<_>>()?;
    let undone: HashSet<String> = batches.iter().filter(|batch| batch.undone).map(|batch| batch.id.clone()).collect();

    let mut statement = conn.prepare("SELECT id, name, batch_id FROM sources WHERE notebook_id = ?1 ORDER BY batch_id")?;
    let mut sources: Vec<Source> = statement.query_map(params![id], |row| Ok(Source {
        id: row.get(0)?, name: row.get(1)?, batch_id: row.get::<_, i64>(2)?.to_string(), pages: Vec::new(),
    }))?.collect::<rusqlite::Result<_>>()?;
    let mut statement = conn.prepare("SELECT text FROM pages WHERE notebook_id = ?1 AND source_id = ?2 ORDER BY page")?;
    for source in &mut sources {
        source.pages = statement.query_map(params![id, source.id], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
    }
    let source_name: HashMap<String, String> = sources.iter().map(|source| (source.id.clone(), source.name.clone())).collect();
    let name_of = |source: &Option<String>| source.as_ref().and_then(|key| source_name.get(key)).cloned().unwrap_or_default();

    let mut statement = conn.prepare(
        "SELECT id, batch_id, source_id, title, target, relation, symbol, page, quote, status, heading, snippet, topic
         FROM claims WHERE notebook_id = ?1 ORDER BY id")?;
    let rows: Vec<ClaimRow> = statement.query_map(params![id], |row| Ok(ClaimRow {
        id: row.get(0)?, batch_id: row.get(1)?, source_id: row.get(2)?, title: row.get(3)?, target: row.get(4)?,
        relation: row.get(5)?, symbol: row.get(6)?, page: row.get(7)?, quote: row.get(8)?,
        heading: row.get(10)?, snippet: row.get(11)?, topic: row.get(12)?,
        status: Status::parse(&row.get::<_, String>(9)?),
    }))?.collect::<rusqlite::Result<_>>()?;

    let mut statement = conn.prepare("SELECT concept_id, text FROM comments WHERE notebook_id = ?1")?;
    let comments: HashMap<String, String> =
        statement.query_map(params![id], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<rusqlite::Result<_>>()?;

    let mut statement = conn.prepare("SELECT concept_id, svg, caption FROM visuals WHERE notebook_id = ?1")?;
    let visuals: HashMap<String, Visual> = statement
        .query_map(params![id], |row| Ok((row.get(0)?, Visual { svg: row.get(1)?, caption: row.get(2)? })))?
        .collect::<rusqlite::Result<_>>()?;

    let mut statement = conn.prepare("SELECT e.claim_id, e.source_id, e.page, e.quote FROM linked_evidence e JOIN claims c ON c.id = e.claim_id WHERE c.notebook_id = ?1")?;
    let linked: HashMap<i64, (String, i64, String)> = statement.query_map(params![id], |row|
        Ok((row.get(0)?, (row.get(1)?, row.get(2)?, row.get(3)?))))?.collect::<rusqlite::Result<_>>()?;
    let active_source = |source: &str| sources.iter().any(|s| s.id == source && !undone.contains(&s.batch_id));
    let active_link = |claim: &ClaimRow| linked.get(&claim.id).is_none_or(|(source, _, _)|
        active_source(source) && claim.source_id.as_deref().is_some_and(&active_source));

    let evidence_of = |claim: &ClaimRow| Evidence {
        claim_id: claim.id, batch_id: claim.batch_id.to_string(), source_id: claim.source_id.clone().unwrap_or_default(),
        source: name_of(&claim.source_id), page: claim.page, quote: claim.quote.clone(), status: claim.status,
    };
    let all_evidence = |claim: &ClaimRow| {
        let mut evidence = Vec::new();
        if claim.source_id.is_some() {
            evidence.push(evidence_of(claim));
        }
        if let Some((source, page, quote)) = linked.get(&claim.id) {
            evidence.push(Evidence { source_id: source.clone(), source: source_name.get(source).cloned().unwrap_or_default(),
                page: *page, quote: quote.clone(), ..evidence_of(claim) });
        }
        evidence
    };
    // Unsourced = nothing approved backs it (or, for a pending item, nothing backs it at all).
    let unsourced = |status: Status, evidence: &[Evidence]| {
        !evidence.iter().any(|item| status == Status::Pending || item.status == Status::Approved)
    };
    let live: Vec<&ClaimRow> = rows.iter()
        .filter(|claim| !undone.contains(&claim.batch_id.to_string()) && claim.status != Status::Rejected && active_link(claim)).collect();

    // Concepts: one per name, approved as soon as any claim for it is approved.
    let mut concepts: Vec<Concept> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    // The topic path the AI (or the sample) gave each concept, from its first claim that has one.
    let mut paths: HashMap<String, Vec<String>> = HashMap::new();
    for claim in live.iter().filter(|claim| claim.target.is_empty()) {
        let key = key_of(&claim.title);
        let index = *at.entry(key.clone()).or_insert_with(|| {
            concepts.push(Concept {
                id: key.clone(), label: claim.title.clone(), symbol: claim.symbol.clone(), status: Status::Pending,
                user_added: false, evidence: Vec::new(), comment: comments.get(&key).cloned().unwrap_or_default(),
                visual: visuals.get(&key).cloned(), heading: String::new(), snippet: None, parent: None,
            });
            concepts.len() - 1
        });
        let concept = &mut concepts[index];
        if claim.status == Status::Approved && concept.status == Status::Pending {
            concept.status = Status::Approved;
            concept.label = claim.title.clone();
        }
        if concept.symbol.is_empty() {
            concept.symbol = claim.symbol.clone();
        }
        // The summary and the snippet come from the first claim that has them.
        if concept.heading.is_empty() {
            concept.heading = claim.heading.clone();
        }
        if concept.snippet.is_none() && !claim.snippet.is_empty() {
            concept.snippet = Some(Snippet { text: claim.snippet.clone(), page: claim.page, source: name_of(&claim.source_id) });
        }
        if claim.source_id.is_some() {
            concept.evidence.push(evidence_of(claim));
        }
        if !claim.topic.is_empty() {
            paths.entry(key).or_insert_with(|| claim.topic.split(" > ").map(str::to_string).collect());
        }
    }
    let mut statement = conn.prepare("SELECT concept_id, symbol FROM symbols WHERE notebook_id = ?1")?;
    let chosen: HashMap<String, String> =
        statement.query_map(params![id], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
    for concept in &mut concepts {
        concept.user_added = unsourced(concept.status, &concept.evidence);
        if let Some(symbol) = chosen.get(&concept.id) {
            concept.symbol = symbol.clone();
        }
    }
    let mut statement = conn.prepare("SELECT concept_id, parent_id FROM parents WHERE notebook_id = ?1")?;
    let moved: Vec<(String, String)> =
        statement.query_map(params![id], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
    let topics = nest(&mut concepts, &paths, &moved);
    let approved = |key: &str| at.get(key).is_some_and(|&index| concepts[index].status == Status::Approved);

    // Links: one per pair of concepts. In the graph only when approved and both ends are approved.
    let mut edges: Vec<Edge> = Vec::new();
    let mut any_approved: Vec<bool> = Vec::new();
    let mut edge_at: HashMap<String, usize> = HashMap::new();
    for claim in live.iter().filter(|claim| !claim.target.is_empty()) {
        let (from, to) = (key_of(&claim.title), key_of(&claim.target));
        if !at.contains_key(&from) || !at.contains_key(&to) {
            continue;
        }
        let key = format!("{from}->{to}");
        let index = *edge_at.entry(key.clone()).or_insert_with(|| {
            edges.push(Edge {
                evidence_kind: "stated".into(),
                id: key.clone(), from: from.clone(), to: to.clone(), relation: claim.relation.clone(),
                status: Status::Pending, user_added: false, evidence: Vec::new(),
            });
            any_approved.push(false);
            edges.len() - 1
        });
        if claim.status == Status::Approved && !any_approved[index] {
            any_approved[index] = true;
            edges[index].relation = claim.relation.clone();
        }
        if claim.source_id.is_some() {
            edges[index].evidence.extend(all_evidence(claim));
            if linked.contains_key(&claim.id) {
                edges[index].evidence_kind = "linked".into();
            }
        }
    }
    for (index, edge) in edges.iter_mut().enumerate() {
        let decided = if any_approved[index] { Status::Approved } else { Status::Pending };
        edge.user_added = unsourced(decided, &edge.evidence);
        edge.status = if any_approved[index] && approved(&edge.from) && approved(&edge.to) { Status::Approved } else { Status::Pending };
    }

    let claims: Vec<Claim> = rows.iter().filter(|claim| active_link(claim)).map(|claim| {
        let (concept_id, target_id) = (key_of(&claim.title), key_of(&claim.target));
        let kind = if claim.target.is_empty() { ClaimKind::Concept } else { ClaimKind::Edge };
        let pair_approved = edge_at.get(&format!("{concept_id}->{target_id}")).is_some_and(|&index| any_approved[index]);
        Claim {
            evidence_kind: if linked.contains_key(&claim.id) { "linked" } else { "stated" }.into(),
            evidence: all_evidence(claim),
            id: claim.id, batch_id: claim.batch_id.to_string(), kind, title: claim.title.clone(),
            target: claim.target.clone(), relation: claim.relation.clone(), quote: claim.quote.clone(), page: claim.page,
            source: name_of(&claim.source_id), status: claim.status,
            ready: kind == ClaimKind::Concept || (approved(&concept_id) && approved(&target_id)),
            merge: claim.status == Status::Pending
                && if kind == ClaimKind::Concept { approved(&concept_id) } else { pair_approved },
            concept_id, target_id,
        }
    }).collect();

    let target = target.filter(|key| approved(key));
    sources.retain(|source| !undone.contains(&source.batch_id));
    Ok(Notebook { id: id.to_string(), title, concepts, topics, edges, claims, batches, sources, target })
}

/// Work out which topic each concept sits in.
///
/// in:  each concept's topic path ("Transformers > Positional encoding"), plus the moves the
///      student made by hand (`moved`: concept → new parent, "" for the top level)
/// out: `parent` set on every concept, and the list of topics that are not concepts themselves
///
/// A path names its topics from the outside in. When a name on the path is a concept, that
/// concept is the topic; otherwise a [`Topic`] is made for it. The student's moves win.
fn nest(concepts: &mut [Concept], paths: &HashMap<String, Vec<String>>, moved: &[(String, String)]) -> Vec<Topic> {
    let real: HashSet<String> = concepts.iter().map(|concept| concept.id.clone()).collect();
    let mut topics: Vec<Topic> = Vec::new();
    let mut parent: HashMap<String, String> = HashMap::new();
    for concept in concepts.iter() {
        let Some(path) = paths.get(&concept.id) else { continue };
        let mut above: Option<String> = None;
        for name in path {
            let key = key_of(name);
            // A concept named by its own path is the topic itself: "Attention" in "Attention".
            if key == concept.id {
                break;
            }
            if above.as_deref() == Some(key.as_str()) {
                continue;
            }
            if !real.contains(&key) && !topics.iter().any(|topic| topic.id == key) {
                topics.push(Topic { id: key.clone(), label: name.clone(), parent: None, status: Status::Pending });
            }
            if let Some(up) = &above {
                parent.entry(key.clone()).or_insert_with(|| up.clone());
            }
            above = Some(key);
        }
        if let Some(up) = above {
            parent.entry(concept.id.clone()).or_insert(up);
        }
    }
    let known = |key: &str| real.contains(key) || topics.iter().any(|topic| topic.id == key);
    for (child, up) in moved {
        if !known(child) {
            continue;
        }
        if up.is_empty() {
            parent.remove(child);
        } else if known(up) {
            parent.insert(child.clone(), up.clone());
        }
    }
    // Nothing may sit inside itself. A loop is cut at the first item found on it.
    let keys: Vec<String> = concepts.iter().map(|concept| concept.id.clone())
        .chain(topics.iter().map(|topic| topic.id.clone())).collect();
    for key in &keys {
        let mut current = parent.get(key).cloned();
        for _ in 0..keys.len() {
            match current {
                Some(up) if &up == key => {
                    parent.remove(key);
                    break;
                }
                Some(up) => current = parent.get(&up).cloned(),
                None => break,
            }
        }
    }
    // A topic is kept while a concept sits somewhere inside it, and is in the graph once one of those is.
    let mut holds: HashMap<String, Status> = HashMap::new();
    for concept in concepts.iter_mut() {
        concept.parent = parent.get(&concept.id).cloned();
        let mut current = concept.parent.clone();
        while let Some(up) = current {
            let status = holds.entry(up.clone()).or_insert(Status::Pending);
            if concept.status == Status::Approved {
                *status = Status::Approved;
            }
            current = parent.get(&up).cloned();
        }
    }
    topics.retain(|topic| holds.contains_key(&topic.id));
    for topic in &mut topics {
        topic.parent = parent.get(&topic.id).cloned();
        topic.status = holds[&topic.id];
    }
    topics
}

/// Match names as tokens, avoiding false matches such as "art" inside "partial".
fn mentions_name(quote: &str, name: &str) -> bool {
    let quote = key_of(quote);
    let name = key_of(name);
    !name.is_empty() && quote.match_indices(&name).any(|(i, _)| {
        let left = quote[..i].chars().next_back();
        let right = quote[i + name.len()..].chars().next();
        !left.is_some_and(|c| c.is_alphanumeric() || c == '_')
            && !right.is_some_and(|c| c.is_alphanumeric() || c == '_')
    })
}
