//! The web server: each route calls one function in `graphu-core` and returns its result as
//! JSON. The routes match the `Backend` interface in `web/src/api.ts`.
//!
//! ```text
//!  browser ──HTTP──▶ route (this file) ──▶ graphu-core ──▶ SQLite
//!                         │
//!                         └─ uploads go through graphu-ingest first (read the file, ask Claude)
//! ```

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use graphu_core::{sha256_hex, AddResult, Graphu, NewDocument, Notebook, NotebookSummary, SamplePack, Status};
use graphu_ingest::{IngestError, Settings};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tower_http::services::{ServeDir, ServeFile};

/// Uploads larger than this are refused.
pub const MAX_BYTES: usize = graphu_ingest::MAX_BYTES;

pub struct AppState {
    graphu: Mutex<Graphu>,
    /// Where the AI lives (key, model). Fixed when the server starts.
    settings: Settings,
}

type Shared = Arc<AppState>;

/// An error the browser can show: `{"detail": "..."}` with a matching HTTP status.
struct Failure(StatusCode, String);

impl From<graphu_core::Error> for Failure {
    fn from(error: graphu_core::Error) -> Self {
        let status = StatusCode::from_u16(error.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        Failure(status, error.to_string())
    }
}

impl IntoResponse for Failure {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "detail": self.1 }))).into_response()
    }
}

type Reply<T> = Result<Json<T>, Failure>;

/// Lock the workspace, run one core call, and turn the result into a JSON reply.
fn run<T>(state: &Shared, call: impl FnOnce(&mut Graphu) -> graphu_core::Result<T>) -> Reply<T> {
    let mut graphu = state.graphu.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    Ok(Json(call(&mut graphu)?))
}

#[derive(Serialize)]
struct Info {
    mode: &'static str,
    ai_enabled: bool,
}

#[derive(Serialize)]
struct Added {
    notebook: Notebook,
    results: Vec<AddResult>,
}

#[derive(Deserialize)]
struct NewNotebook {
    title: String,
}

#[derive(Deserialize)]
struct Upload {
    name: Option<String>,
    context: Option<String>,
}

#[derive(Deserialize)]
struct Decision {
    status: Status,
}

#[derive(Deserialize)]
struct Undone {
    undone: bool,
}

#[derive(Deserialize)]
struct NewConcept {
    label: String,
}

#[derive(Deserialize)]
struct NewEdge {
    from: String,
    to: String,
}

#[derive(Deserialize)]
struct Comment {
    concept: String,
    text: String,
}

#[derive(Deserialize)]
struct Draw {
    concept: String,
}

#[derive(Deserialize)]
struct Target {
    concept: Option<String>,
}

/// Build the whole application. `web` is the folder holding the built frontend, if any.
pub fn app(graphu: Graphu, web: Option<PathBuf>, settings: Settings) -> Router {
    let api = Router::new()
        .route("/info", get(info))
        .route("/notebooks", get(list_notebooks).post(create_notebook))
        .route("/notebooks/{id}", get(get_notebook).patch(rename_notebook).delete(delete_notebook))
        .route("/notebooks/{id}/documents", post(add_document))
        .route("/notebooks/{id}/sample-packs", get(list_sample_packs))
        .route("/notebooks/{id}/sample-packs/{pack}", post(add_sample_pack))
        .route("/notebooks/{id}/claims/{claim}", patch(review_claim))
        .route("/notebooks/{id}/batches/{batch}", patch(set_batch_undone))
        .route("/notebooks/{id}/batches/{batch}/review", post(review_batch))
        .route("/notebooks/{id}/concepts", post(add_concept))
        .route("/notebooks/{id}/edges", post(add_edge))
        .route("/notebooks/{id}/comment", put(set_comment))
        .route("/notebooks/{id}/target", put(set_target))
        .route("/notebooks/{id}/visual", post(draw_visual))
        .fallback(|| async { Failure(StatusCode::NOT_FOUND, "No such API route.".into()) })
        .layer(DefaultBodyLimit::max(MAX_BYTES))
        .with_state(Arc::new(AppState { graphu: Mutex::new(graphu), settings }));
    let router = Router::new().nest("/api", api);
    match web {
        // Any path that is not a file gets index.html, so the single-page app can load.
        Some(folder) => router.fallback_service(ServeDir::new(&folder).fallback(ServeFile::new(folder.join("index.html")))),
        None => router,
    }
}

async fn info(State(state): State<Shared>) -> Json<Info> {
    Json(Info { mode: "server", ai_enabled: state.settings.api_key.is_some() })
}

async fn list_notebooks(State(state): State<Shared>) -> Reply<Vec<NotebookSummary>> {
    run(&state, |graphu| graphu.list_notebooks())
}

async fn create_notebook(State(state): State<Shared>, Json(body): Json<NewNotebook>) -> Reply<NotebookSummary> {
    run(&state, |graphu| graphu.create_notebook(&body.title))
}

async fn rename_notebook(State(state): State<Shared>, Path(id): Path<String>, Json(body): Json<NewNotebook>) -> Reply<NotebookSummary> {
    run(&state, |graphu| graphu.rename_notebook(&id, &body.title))
}

async fn delete_notebook(State(state): State<Shared>, Path(id): Path<String>) -> Reply<()> {
    run(&state, |graphu| graphu.delete_notebook(&id))
}

async fn get_notebook(State(state): State<Shared>, Path(id): Path<String>) -> Reply<Notebook> {
    run(&state, |graphu| graphu.get_notebook(&id))
}

/// The request body is the raw file, of any kind.
///
/// 1. Hash it. The same bytes twice is a duplicate and costs no AI call.
/// 2. Read it and ask Claude for proposals (graphu-ingest). The workspace is not locked meanwhile.
/// 3. Store it as a new batch (graphu-core), which keeps only proposals whose quote is on the page.
async fn add_document(State(state): State<Shared>, Path(id): Path<String>, Query(upload): Query<Upload>, body: Bytes) -> Reply<Added> {
    if body.is_empty() {
        return Err(Failure(StatusCode::UNPROCESSABLE_ENTITY, "That file is empty.".into()));
    }
    let mut document = NewDocument {
        source_id: sha256_hex(&body),
        name: upload.name.unwrap_or_default(),
        context: upload.context.unwrap_or_default(),
        ..NewDocument::default()
    };
    let Json((duplicate, known)) = run(&state, |graphu| {
        let notebook = graphu.get_notebook(&id)?;
        let known: Vec<String> = notebook.concepts.into_iter().map(|concept| concept.label).collect();
        Ok((graphu.has_source(&id, &document.source_id)?, known))
    })?;
    if !duplicate {
        let ingested = graphu_ingest::ingest(&state.settings, &document.name, &document.context, &known, &body).await
            .map_err(|error| match error {
                IngestError::Unreadable(text) => Failure(StatusCode::UNPROCESSABLE_ENTITY, text),
                IngestError::Ai(text) => Failure(StatusCode::BAD_GATEWAY, text),
            })?;
        document.pages = ingested.pages;
        document.items = ingested.items;
        document.extracted = ingested.extracted;
        document.note = ingested.note;
    }
    run(&state, |graphu| {
        let result = graphu.add_document(&id, document)?;
        Ok(Added { notebook: graphu.get_notebook(&id)?, results: vec![result] })
    })
}

async fn list_sample_packs(State(state): State<Shared>, Path(id): Path<String>) -> Reply<Vec<SamplePack>> {
    run(&state, |graphu| graphu.list_sample_packs(&id))
}

async fn add_sample_pack(State(state): State<Shared>, Path((id, pack)): Path<(String, String)>) -> Reply<Added> {
    run(&state, |graphu| {
        let result = graphu.add_sample_pack(&id, &pack)?;
        Ok(Added { notebook: graphu.get_notebook(&id)?, results: vec![result] })
    })
}

async fn review_claim(State(state): State<Shared>, Path((id, claim)): Path<(String, i64)>, Json(body): Json<Decision>) -> Reply<Notebook> {
    run(&state, |graphu| graphu.review_claim(&id, claim, body.status))
}

async fn review_batch(State(state): State<Shared>, Path((id, batch)): Path<(String, String)>, Json(body): Json<Decision>) -> Reply<Notebook> {
    if body.status == Status::Pending {
        return Err(Failure(StatusCode::UNPROCESSABLE_ENTITY, "Approve or reject a batch.".into()));
    }
    run(&state, |graphu| graphu.review_batch(&id, &batch, body.status))
}

async fn set_batch_undone(State(state): State<Shared>, Path((id, batch)): Path<(String, String)>, Json(body): Json<Undone>) -> Reply<Notebook> {
    run(&state, |graphu| graphu.set_batch_undone(&id, &batch, body.undone))
}

async fn add_concept(State(state): State<Shared>, Path(id): Path<String>, Json(body): Json<NewConcept>) -> Reply<Notebook> {
    run(&state, |graphu| graphu.add_concept(&id, &body.label))
}

async fn add_edge(State(state): State<Shared>, Path(id): Path<String>, Json(body): Json<NewEdge>) -> Reply<Notebook> {
    run(&state, |graphu| graphu.add_edge(&id, &body.from, &body.to))
}

async fn set_comment(State(state): State<Shared>, Path(id): Path<String>, Json(body): Json<Comment>) -> Reply<Notebook> {
    run(&state, |graphu| graphu.set_comment(&id, &body.concept, &body.text))
}

async fn set_target(State(state): State<Shared>, Path(id): Path<String>, Json(body): Json<Target>) -> Reply<Notebook> {
    run(&state, |graphu| graphu.set_target(&id, body.concept.as_deref()))
}

/// Ask Claude for a small picture of one concept, based on its approved quotes, and save it.
async fn draw_visual(State(state): State<Shared>, Path(id): Path<String>, Json(body): Json<Draw>) -> Reply<Notebook> {
    if state.settings.api_key.is_none() {
        return Err(Failure(StatusCode::UNPROCESSABLE_ENTITY, "Drawing a picture needs an AI key on the server.".into()));
    }
    let Json(notebook) = run(&state, |graphu| graphu.get_notebook(&id))?;
    let concept = notebook.concepts.iter().find(|concept| concept.id == body.concept)
        .ok_or_else(|| Failure(StatusCode::NOT_FOUND, "Concept not found.".into()))?;
    let quotes: Vec<String> = concept.evidence.iter().filter(|item| item.status == Status::Approved)
        .take(6).map(|item| item.quote.clone()).collect();
    let picture = graphu_ingest::illustrate(&state.settings, &concept.label, &quotes).await.map_err(|error| match error {
        graphu_ingest::AiError::Unavailable(text) => Failure(StatusCode::BAD_GATEWAY, text),
        graphu_ingest::AiError::Declined(text) => Failure(StatusCode::UNPROCESSABLE_ENTITY, text),
    })?;
    run(&state, |graphu| graphu.set_visual(&id, &body.concept, &picture.svg, &picture.caption))
}
