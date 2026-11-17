//! The server tested through real HTTP requests, without opening a network port.

use std::path::PathBuf;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use axum::Router;
use graphu_core::Graphu;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

fn server(web: Option<PathBuf>) -> Router {
    let mut graphu = Graphu::in_memory().unwrap();
    graphu.ensure_samples().unwrap();
    graphu_server::app(graphu, web, graphu_ingest::Settings::offline())
}

/// Send one request and return the status, the content type, and the body.
async fn send(app: &Router, method: Method, path: &str, body: Option<Value>) -> (StatusCode, String, Vec<u8>) {
    let request = Request::builder().method(method).uri(path);
    let request = match body {
        Some(value) => request.header(header::CONTENT_TYPE, "application/json").body(Body::from(value.to_string())),
        None => request.body(Body::empty()),
    }.unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let kind = response.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    (status, kind, response.into_body().collect().await.unwrap().to_bytes().to_vec())
}

async fn call(app: &Router, method: Method, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    let (status, _, bytes) = send(app, method, path, body).await;
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn upload(app: &Router, path: &str, bytes: Vec<u8>) -> (StatusCode, Value) {
    let request = Request::builder().method(Method::POST).uri(path).body(Body::from(bytes)).unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

const HASH: &str = "/api/notebooks/sample-hash-tables";

#[tokio::test]
async fn review_flow_over_http() {
    let app = server(None);
    let (status, info) = call(&app, Method::GET, "/api/info", None).await;
    assert_eq!((status, info["mode"].as_str()), (StatusCode::OK, Some("server")));

    // The sample is there with no API key.
    let (_, list) = call(&app, Method::GET, "/api/notebooks", None).await;
    let ids: Vec<&str> = list.as_array().unwrap().iter().map(|n| n["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&"sample-calculus") && ids.contains(&"sample-hash-tables"));

    let (_, notebook) = call(&app, Method::GET, HASH, None).await;
    let claims = notebook["claims"].as_array().unwrap();
    assert_eq!(claims.len(), 4);
    let id_of = |title: &str, kind: &str| claims.iter()
        .find(|c| c["title"] == title && c["kind"] == kind).unwrap()["id"].as_i64().unwrap();
    let link = format!("{HASH}/claims/{}", id_of("Chaining", "edge"));
    let approve = Some(json!({ "status": "approved" }));

    // A link is refused until both of its concepts are approved, with a message the UI can show.
    let (status, error) = call(&app, Method::PATCH, &link, approve.clone()).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(error["detail"], "Approve both concepts before approving this link.");

    for title in ["Hash table", "Chaining"] {
        let path = format!("{HASH}/claims/{}", id_of(title, "concept"));
        assert_eq!(call(&app, Method::PATCH, &path, approve.clone()).await.0, StatusCode::OK);
    }
    let (status, notebook) = call(&app, Method::PATCH, &link, approve).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(notebook["edges"][0]["status"], "approved");
    assert_eq!(notebook["edges"][0]["evidence"][0]["page"], 1);

    // Undo the batch over HTTP, then restore it.
    let batch = format!("{HASH}/batches/{}", notebook["batches"][0]["id"].as_str().unwrap());
    let (_, undone) = call(&app, Method::PATCH, &batch, Some(json!({ "undone": true }))).await;
    assert_eq!(undone["concepts"].as_array().unwrap().len(), 0);
    let (_, restored) = call(&app, Method::PATCH, &batch, Some(json!({ "undone": false }))).await;
    assert_eq!(restored["concepts"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn notebooks_uploads_and_errors() {
    let app = server(None);
    let (status, created) = call(&app, Method::POST, "/api/notebooks", Some(json!({ "title": "Week 6 slides" }))).await;
    assert_eq!(status, StatusCode::OK);
    let base = format!("/api/notebooks/{}", created["id"].as_str().unwrap());

    // The same bytes twice: the second upload is a duplicate, whatever it is called.
    let path = format!("{base}/documents?name=Lecture.txt&context=week%206%20slides");
    let (status, first) = upload(&app, &path, b"Lecture notes about caches.".to_vec()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(first["results"][0]["duplicate"], false);
    assert_eq!(first["results"][0]["extracted"], false);
    assert!(first["results"][0]["note"].as_str().unwrap().contains("No AI key"), "recorded, with the reason");
    assert_eq!(first["notebook"]["sources"][0]["pages"][0], "Lecture notes about caches.");

    // A broken PDF is refused with a message instead of being stored.
    let (status, error) = upload(&app, &format!("{base}/documents?name=Bad.pdf"), b"%PDF-1.4 not really".to_vec()).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(error["detail"].as_str().unwrap().contains("could not be read"));
    assert_eq!(first["notebook"]["batches"][0]["context"], "week 6 slides");
    let (_, second) = upload(&app, &format!("{base}/documents?name=Renamed.txt"), b"Lecture notes about caches.".to_vec()).await;
    assert_eq!(second["results"][0]["duplicate"], true);

    assert_eq!(upload(&app, &path, Vec::new()).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(upload(&app, &path, vec![0; graphu_server::MAX_BYTES + 1]).await.0, StatusCode::PAYLOAD_TOO_LARGE);

    // The student's own concept, a comment, and a goal.
    let (_, notebook) = call(&app, Method::POST, &format!("{base}/concepts"), Some(json!({ "label": "Limits" }))).await;
    assert_eq!(notebook["concepts"][0]["user_added"], true);
    let (_, notebook) = call(&app, Method::PUT, &format!("{base}/comment"), Some(json!({ "concept": "limits", "text": "review" }))).await;
    assert_eq!(notebook["concepts"][0]["comment"], "review");
    let (_, notebook) = call(&app, Method::PUT, &format!("{base}/target"), Some(json!({ "concept": "limits" }))).await;
    assert_eq!(notebook["target"], "limits");

    // Rename, then delete. The built-in sample is protected.
    let (_, renamed) = call(&app, Method::PATCH, &base, Some(json!({ "title": "CSC 357" }))).await;
    assert_eq!(renamed["title"], "CSC 357");
    assert_eq!(call(&app, Method::DELETE, &base, None).await.0, StatusCode::OK);
    assert_eq!(call(&app, Method::GET, &base, None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(call(&app, Method::DELETE, "/api/notebooks/sample-calculus", None).await.0, StatusCode::CONFLICT);

    let (status, error) = call(&app, Method::GET, "/api/notebooks/nope", None).await;
    assert_eq!((status, error["detail"].as_str()), (StatusCode::NOT_FOUND, Some("Notebook not found.")));
    assert_eq!(call(&app, Method::GET, "/api/nope", None).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn sample_pack_over_http() {
    let app = server(None);
    let base = "/api/notebooks/sample-calculus";
    let (_, packs) = call(&app, Method::GET, &format!("{base}/sample-packs"), None).await;
    let pack = packs[0]["id"].as_str().unwrap();
    let (_, added) = call(&app, Method::POST, &format!("{base}/sample-packs/{pack}"), None).await;
    assert_eq!(added["results"][0]["count"], 8);
    let batch = added["results"][0]["batch_id"].as_str().unwrap();
    let (_, notebook) = call(&app, Method::POST, &format!("{base}/batches/{batch}/review"), Some(json!({ "status": "rejected" }))).await;
    assert!(notebook["claims"].as_array().unwrap().iter().filter(|c| c["batch_id"] == batch).all(|c| c["status"] == "rejected"));
}

/// Port of `test_built_pwa_is_served`. Like the Python test, it needs the frontend to be built.
#[tokio::test]
async fn built_pwa_is_served() {
    let web = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../web/dist");
    if !web.join("index.html").is_file() {
        eprintln!("skipped: build the frontend to test PWA routes");
        return;
    }
    let app = server(Some(web));
    let (status, kind, page) = send(&app, Method::GET, "/", None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(kind.starts_with("text/html") && String::from_utf8_lossy(&page).contains("Graphu"));

    let (_, _, bytes) = send(&app, Method::GET, "/manifest.webmanifest", None).await;
    let manifest: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(manifest["display"], "standalone");
    for icon in manifest["icons"].as_array().unwrap() {
        let (status, kind, _) = send(&app, Method::GET, icon["src"].as_str().unwrap(), None).await;
        assert_eq!((status, kind.as_str()), (StatusCode::OK, "image/png"));
    }
    assert_eq!(send(&app, Method::GET, "/sw.js", None).await.0, StatusCode::OK);
    // The API still answers when the frontend is being served too.
    assert_eq!(send(&app, Method::GET, "/api/info", None).await.0, StatusCode::OK);
}

/// The whole upload path with a fake Claude: read → propose → ground → review queue.
#[tokio::test]
async fn upload_is_read_proposed_and_grounded() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static CALLS: AtomicUsize = AtomicUsize::new(0);
    let claude = Router::new().route("/v1/messages", axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
        CALLS.fetch_add(1, Ordering::SeqCst);
        if body["system"].as_str().unwrap().starts_with("You propose dependencies") {
            return axum::Json(json!({ "stop_reason": "end_turn", "content": [{ "type": "text", "text": "{\"links\":[]}" }] }));
        }
        let items = json!({ "items": [
            { "title": "Cache", "target": "", "relation": "", "symbol": "", "page": 1, "quote": "A cache keeps frequently used data close." },
            { "title": "Locality", "target": "", "relation": "", "symbol": "", "page": 1, "quote": "Caches work because programs show locality." },
            { "title": "Cache", "target": "Locality", "relation": "relies on", "symbol": "", "page": 1, "quote": "Caches work because programs show locality." },
            { "title": "Invented", "target": "", "relation": "", "symbol": "", "page": 1, "quote": "This sentence is not in the notes at all." },
        ] });
        axum::Json(json!({ "stop_reason": "end_turn", "content": [{ "type": "text", "text": items.to_string() }] }))
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, claude).await.unwrap() });
    let settings = graphu_ingest::Settings { api_key: Some("test".into()), model: "claude-sonnet-5-5".into(), base_url, transcribe_cmd: None };
    let app = graphu_server::app(Graphu::in_memory().unwrap(), None, settings);

    assert_eq!(call(&app, Method::GET, "/api/info", None).await.1["ai_enabled"], true);
    let (_, created) = call(&app, Method::POST, "/api/notebooks", Some(json!({ "title": "Systems" }))).await;
    let base = format!("/api/notebooks/{}", created["id"].as_str().unwrap());
    let notes = b"A cache keeps frequently used data close.\nCaches work because programs show locality.".to_vec();

    let (status, added) = upload(&app, &format!("{base}/documents?name=week4.txt&context=week%204"), notes.clone()).await;
    assert_eq!(status, StatusCode::OK);
    let result = &added["results"][0];
    assert_eq!((result["extracted"].as_bool(), result["count"].as_i64(), result["dropped"].as_i64()), (Some(true), Some(3), Some(1)));
    let claims = added["notebook"]["claims"].as_array().unwrap();
    assert!(claims.iter().all(|claim| claim["status"] == "pending" && claim["source"] == "week4.txt"));
    assert!(!claims.iter().any(|claim| claim["title"] == "Invented"), "its quote is not on the page");
    assert_eq!(added["notebook"]["sources"][0]["pages"].as_array().unwrap().len(), 1);

    // The same file again: a duplicate, and Claude is not asked a second time.
    let (_, again) = upload(&app, &format!("{base}/documents?name=copy.txt"), notes.clone()).await;
    assert_eq!(again["results"][0]["duplicate"], true);
    assert_eq!(CALLS.load(Ordering::SeqCst), 1, "one extraction; one file has nothing to connect across");

    // The same file with the same note in a new graphbook: the saved answer is reused, so the
    // proposals are exactly the same and Claude is not asked again.
    let (_, second) = call(&app, Method::POST, "/api/notebooks", Some(json!({ "title": "Systems again" }))).await;
    let other = format!("/api/notebooks/{}", second["id"].as_str().unwrap());
    let (_, rebuilt) = upload(&app, &format!("{other}/documents?name=week4.txt&context=week%204"), notes.clone()).await;
    let shape = |claims: &Value| claims.as_array().unwrap().iter()
        .map(|claim| (claim["title"].to_string(), claim["target"].to_string(), claim["quote"].to_string())).collect::<Vec<_>>();
    assert_eq!(shape(&rebuilt["notebook"]["claims"]), shape(&added["notebook"]["claims"]));
    assert_eq!(CALLS.load(Ordering::SeqCst), 1, "same input, same graph, no new AI call");

    // Without a key, a picture is refused with a reason (this fake returns no picture anyway).
    let offline = server(None);
    let (status, error) = call(&offline, Method::POST, "/api/notebooks/sample-calculus/visual", Some(json!({ "concept": "integrals" }))).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(error["detail"].as_str().unwrap().contains("AI key"));
    assert_eq!(call(&app, Method::POST, &format!("{base}/visual"), Some(json!({ "concept": "nope" }))).await.0, StatusCode::NOT_FOUND);

    // A file that cannot be used comes back as a message, not a batch.
    let (status, error) = upload(&app, &format!("{base}/documents?name=data.bin"), vec![0, 1, 2]).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(error["detail"].as_str().unwrap().contains("cannot read this kind of file"));
}

#[tokio::test]
async fn picture_is_drawn_checked_and_saved() {
    let claude = Router::new().route("/v1/messages", axum::routing::post(|axum::Json(body): axum::Json<Value>| async move {
        // Asked about "Limits", this fake misbehaves and returns a picture with a script in it.
        let bad = body["messages"][0]["content"][0]["text"].as_str().unwrap().contains("Limits");
        let svg = if bad { "<svg><script>alert(1)</script></svg>" } else { "<svg viewBox=\"0 0 320 180\"><rect width=\"10\" height=\"10\"/></svg>" };
        let picture = json!({ "svg": svg, "caption": "Area under a curve." });
        axum::Json(json!({ "stop_reason": "end_turn", "content": [{ "type": "text", "text": picture.to_string() }] }))
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, claude).await.unwrap() });
    let settings = graphu_ingest::Settings { api_key: Some("test".into()), model: "claude-sonnet-5-5".into(), base_url, transcribe_cmd: None };
    let mut graphu = Graphu::in_memory().unwrap();
    graphu.ensure_samples().unwrap();
    let app = graphu_server::app(graphu, None, settings);

    let path = "/api/notebooks/sample-calculus/visual";
    let (status, notebook) = call(&app, Method::POST, path, Some(json!({ "concept": "integrals" }))).await;
    assert_eq!(status, StatusCode::OK);
    let concept = notebook["concepts"].as_array().unwrap().iter().find(|c| c["id"] == "integrals").unwrap();
    assert_eq!(concept["visual"]["caption"], "Area under a curve.");
    assert!(concept["visual"]["svg"].as_str().unwrap().starts_with("<svg"));

    // An unsafe picture from the model is refused and nothing is saved.
    let (status, _) = call(&app, Method::POST, path, Some(json!({ "concept": "limits" }))).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (_, notebook) = call(&app, Method::GET, "/api/notebooks/sample-calculus", None).await;
    assert!(notebook["concepts"].as_array().unwrap().iter().find(|c| c["id"] == "limits").unwrap()["visual"].is_null());
}

/// Send a request as one particular browser (its made-up user id).
async fn call_as(app: &Router, user: &str, method: Method, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    let request = Request::builder().method(method).uri(path).header(graphu_server::USER_HEADER, user);
    let request = match body {
        Some(value) => request.header(header::CONTENT_TYPE, "application/json").body(Body::from(value.to_string())),
        None => request.body(Body::empty()),
    }.unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn titles(list: &Value) -> Vec<String> {
    let mut titles: Vec<String> = list.as_array().unwrap().iter().map(|n| n["title"].as_str().unwrap().to_string()).collect();
    titles.sort();
    titles
}

const ANA: &str = "0b9c1e52-7a41-4f0e-9d7c-ana000000001";
const BEN: &str = "5d2f8a90-33c6-4b1a-8e22-ben000000002";

#[tokio::test]
async fn each_person_sees_only_their_own_graphbooks() {
    let app = server(None);
    let (_, made) = call_as(&app, ANA, Method::POST, "/api/notebooks", Some(json!({ "title": "Ana's notes" }))).await;
    let ana_book = format!("/api/notebooks/{}", made["id"].as_str().unwrap());

    // Each person starts with their own copy of the samples, and Ana's graphbook is hers alone.
    let (_, ana) = call_as(&app, ANA, Method::GET, "/api/notebooks", None).await;
    let (_, ben) = call_as(&app, BEN, Method::GET, "/api/notebooks", None).await;
    assert_eq!(titles(&ana), ["Ana's notes", "Calculus III (sample)", "Hash tables (sample)"]);
    assert_eq!(titles(&ben), ["Calculus III (sample)", "Hash tables (sample)"]);
    assert_eq!(call_as(&app, BEN, Method::GET, &ana_book, None).await.0, StatusCode::NOT_FOUND);
    assert_eq!(call_as(&app, BEN, Method::DELETE, &ana_book, None).await.0, StatusCode::NOT_FOUND);

    // Ben reviewing his sample does not change Ana's.
    let (_, sample) = call_as(&app, BEN, Method::GET, HASH, None).await;
    let batch = sample["batches"][0]["id"].as_str().unwrap();
    call_as(&app, BEN, Method::POST, &format!("{HASH}/batches/{batch}/review"), Some(json!({ "status": "approved" }))).await;
    let pending = |notebook: &Value| notebook["claims"].as_array().unwrap().iter().filter(|c| c["status"] == "pending").count();
    assert_eq!(pending(&call_as(&app, BEN, Method::GET, HASH, None).await.1), 0);
    assert_eq!(pending(&call_as(&app, ANA, Method::GET, HASH, None).await.1), 4);

    // An id that could not be a safe file name is refused.
    assert_eq!(call_as(&app, "../../etc/passwd-0000", Method::GET, "/api/notebooks", None).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(call_as(&app, "short", Method::GET, "/api/notebooks", None).await.0, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn workspaces_are_files_and_the_first_person_inherits_the_old_shared_graphbooks() {
    let dir = std::env::temp_dir().join(format!("graphu-users-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("users")).unwrap();
    let old = dir.join("shared.sqlite3");
    {
        let mut shared = Graphu::open(&old).unwrap();
        shared.ensure_samples().unwrap();
        shared.create_notebook("Autoencoders").unwrap();
    }
    let build = |adopt: bool| {
        let users = graphu_server::Users { dir: dir.join("users"), adopt_from: adopt.then(|| old.clone()) };
        graphu_server::app_with_users(Graphu::open(&old).unwrap(), None, graphu_ingest::Settings::offline(), Some(users))
    };
    let app = build(true);
    let (_, first) = call_as(&app, ANA, Method::GET, "/api/notebooks", None).await;
    let (_, second) = call_as(&app, BEN, Method::GET, "/api/notebooks", None).await;
    assert!(titles(&first).contains(&"Autoencoders".to_string()), "the first arrival keeps what was there");
    assert!(!titles(&second).contains(&"Autoencoders".to_string()), "later arrivals start fresh");
    assert!(dir.join("users").join(format!("{ANA}.sqlite3")).is_file());

    // After a restart, each person still has their own graphbooks.
    call_as(&app, BEN, Method::POST, "/api/notebooks", Some(json!({ "title": "Ben's notes" }))).await;
    drop(app);
    let app = build(true);
    assert!(titles(&call_as(&app, BEN, Method::GET, "/api/notebooks", None).await.1).contains(&"Ben's notes".to_string()));
    assert!(!titles(&call_as(&app, ANA, Method::GET, "/api/notebooks", None).await.1).contains(&"Ben's notes".to_string()));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn uploads_connect_across_files_and_keep_uploads_when_connect_fails() {
    use std::sync::{Arc, Mutex};
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let record = requests.clone();
    let claude = Router::new().route("/v1/messages", axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
        let record = record.clone();
        async move {
            record.lock().unwrap().push(body.clone());
            let prompt = body["messages"][0]["content"][0]["text"].as_str().unwrap();
            let payload = if body["system"].as_str().unwrap().starts_with("You propose dependencies") {
                let data: Value = serde_json::from_str(prompt).unwrap();
                let sources = data["sources"].as_array().unwrap();
                if sources.len() > 2 {
                    return (StatusCode::TOO_MANY_REQUESTS, axum::Json(json!({"error": {"message": "test rate limit"}})));
                }
                let find = |word: &str| sources.iter().find(|s| s["pages"][0]["text"].as_str().unwrap().starts_with(word)).unwrap();
                let a = find("Optimization");
                let b = find("The gradient");
                json!({"links": [{"title": "Optimization", "target": "Gradient", "relation": "relies on",
                    "source_a": a["source_id"], "page_a": 1, "quote_a": a["pages"][0]["text"],
                    "source_b": b["source_id"], "page_b": 1, "quote_b": b["pages"][0]["text"]}]})
            } else {
                let (title, quote) = if prompt.contains("Optimization minimizes") {
                    ("Optimization", "Optimization minimizes loss by following the gradient.")
                } else { ("Gradient", "The gradient is the vector of partial derivatives.") };
                json!({"items": [{"title": title, "target": "", "relation": "", "symbol": "", "page": 1, "quote": quote}]})
            };
            (StatusCode::OK, axum::Json(json!({"stop_reason": "end_turn", "content": [{"type": "text", "text": payload.to_string()}]})))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let settings = graphu_ingest::Settings { api_key: Some("test".into()), model: "test".into(),
        base_url: format!("http://{}", listener.local_addr().unwrap()), transcribe_cmd: None };
    tokio::spawn(async move { axum::serve(listener, claude).await.unwrap() });
    let app = graphu_server::app(Graphu::in_memory().unwrap(), None, settings);
    let (_, made) = call(&app, Method::POST, "/api/notebooks", Some(json!({"title":"Across notes"}))).await;
    let path = format!("/api/notebooks/{}", made["id"].as_str().unwrap());
    let a = "Optimization minimizes loss by following the gradient.";
    let b = "The gradient is the vector of partial derivatives.";
    assert_eq!(upload(&app, &format!("{path}/documents?name=a.txt&context=week1"), a.as_bytes().to_vec()).await.0, StatusCode::OK);
    let (status, result) = upload(&app, &format!("{path}/documents?name=b.txt&context=week2"), b.as_bytes().to_vec()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["notebook"]["edges"][0]["evidence_kind"], "linked");
    assert_eq!(result["notebook"]["edges"][0]["evidence"].as_array().unwrap().len(), 2);
    assert_eq!(result["results"][0]["count"], 2);
    assert_eq!(result["notebook"]["edges"][0]["status"], "pending");
    let count = requests.lock().unwrap().len();
    let (_, duplicate) = upload(&app, &format!("{path}/documents?name=b.txt"), b.as_bytes().to_vec()).await;
    assert_eq!(duplicate["results"][0]["duplicate"], true);
    assert_eq!(requests.lock().unwrap().len(), count, "duplicates cost no additional AI calls");
    let (_, result) = upload(&app, &format!("{path}/documents?name=c.txt"), format!("{b} More notes.").as_bytes().to_vec()).await;
    assert_eq!(result["notebook"]["sources"].as_array().unwrap().len(), 3);
    assert!(result["results"][0]["note"].as_str().unwrap().contains("Notes saved"));
    let (_, reloaded) = call(&app, Method::GET, &path, None).await;
    assert!(reloaded["batches"].as_array().unwrap().last().unwrap()["note"].as_str().unwrap().contains("Notes saved"));
    let requests = requests.lock().unwrap();
    let connect = requests.iter().find(|r| r["system"].as_str().unwrap().starts_with("You propose dependencies")).unwrap();
    let prompt = connect["messages"][0]["content"][0]["text"].as_str().unwrap();
    assert!(prompt.contains("week1") && prompt.contains("week2") && prompt.contains(a) && prompt.contains(b));
    assert!(connect["system"].as_str().unwrap().contains("untrusted data"));
}

/// One file, with a concept the first pass left unlinked: the connection pass is asked about it,
/// its two-quote link joins the review queue, and topics come through. All of it is repeatable.
///
///   extraction: Cache, Locality, Prefetching (no link)   topic: "Memory"
///   connection: Prefetching relies on Cache   (one quote uses "cache", one explains it)
#[tokio::test]
async fn loose_concepts_get_a_second_look_and_topics_come_through() {
    use std::sync::{Arc, Mutex};
    let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
    let record = requests.clone();
    let claude = Router::new().route("/v1/messages", axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
        let record = record.clone();
        async move {
            record.lock().unwrap().push(body.clone());
            let payload = if body["system"].as_str().unwrap().starts_with("You propose dependencies") {
                let data: Value = serde_json::from_str(body["messages"][0]["content"][0]["text"].as_str().unwrap()).unwrap();
                let source = &data["sources"][0]["source_id"];
                json!({ "links": [{ "title": "Prefetching", "target": "Cache", "relation": "fills",
                    "source_a": source, "page_a": 1, "quote_a": "Prefetching fills the cache before the data is asked for.",
                    "source_b": source, "page_b": 1, "quote_b": "A cache keeps frequently used data close." }] })
            } else {
                let concept = |title: &str, quote: &str| json!({ "title": title, "target": "", "relation": "", "symbol": "",
                    "topic": "Memory", "page": 1, "quote": quote });
                json!({ "items": [
                    concept("Cache", "A cache keeps frequently used data close."),
                    concept("Locality", "Caches work because programs show locality."),
                    concept("Prefetching", "Prefetching fills the cache before the data is asked for."),
                    { "title": "Cache", "target": "Locality", "relation": "relies on", "symbol": "", "topic": "", "page": 1,
                      "quote": "Caches work because programs show locality." },
                ] })
            };
            axum::Json(json!({ "stop_reason": "end_turn", "content": [{ "type": "text", "text": payload.to_string() }] }))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let settings = graphu_ingest::Settings { api_key: Some("test".into()), model: "test".into(),
        base_url: format!("http://{}", listener.local_addr().unwrap()), transcribe_cmd: None };
    tokio::spawn(async move { axum::serve(listener, claude).await.unwrap() });
    let app = graphu_server::app(Graphu::in_memory().unwrap(), None, settings);
    let notes = b"A cache keeps frequently used data close.\nCaches work because programs show locality.\nPrefetching fills the cache before the data is asked for.".to_vec();

    let (_, made) = call(&app, Method::POST, "/api/notebooks", Some(json!({ "title": "Systems" }))).await;
    let path = format!("/api/notebooks/{}", made["id"].as_str().unwrap());
    let (status, added) = upload(&app, &format!("{path}/documents?name=week4.txt"), notes.clone()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(added["results"][0]["count"], 5, "three concepts, one stated link, one two-quote link");
    let notebook = &added["notebook"];
    let edge = notebook["edges"].as_array().unwrap().iter().find(|edge| edge["id"] == "prefetching->cache").unwrap();
    assert_eq!((edge["evidence_kind"].as_str(), edge["status"].as_str()), (Some("linked"), Some("pending")));
    // The connection pass was told which concept had no link.
    {
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        let asked: Value = serde_json::from_str(requests[1]["messages"][0]["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(asked["concepts_without_links"], json!(["Prefetching"]));
        assert!(requests[0]["messages"][0]["content"][0]["text"].as_str().unwrap().contains("<known_topics>[]</known_topics>"));
    }
    // Every concept sits in the topic the AI named, and the topic is listed once.
    assert!(notebook["concepts"].as_array().unwrap().iter().all(|concept| concept["parent"] == "memory"));
    assert_eq!(notebook["topics"], json!([{ "id": "memory", "label": "Memory", "parent": null, "status": "pending" }]));

    // The same file in a new graphbook: the same concepts and links, and Claude is not asked again.
    let (_, second) = call(&app, Method::POST, "/api/notebooks", Some(json!({ "title": "Again" }))).await;
    let other = format!("/api/notebooks/{}", second["id"].as_str().unwrap());
    let (_, rebuilt) = upload(&app, &format!("{other}/documents?name=week4.txt"), notes).await;
    let shape = |claims: &Value| claims.as_array().unwrap().iter()
        .map(|claim| (claim["title"].to_string(), claim["target"].to_string(), claim["quote"].to_string())).collect::<Vec<_>>();
    assert_eq!(shape(&rebuilt["notebook"]["claims"]), shape(&notebook["claims"]));
    assert_eq!(requests.lock().unwrap().len(), 2, "same input, same graph, no new AI call");

    // The student moves a concept out of the topic, over HTTP.
    let (status, moved) = call(&app, Method::PUT, &format!("{path}/parent"), Some(json!({ "concept": "prefetching", "parent": null }))).await;
    assert_eq!(status, StatusCode::OK);
    let prefetching = moved["concepts"].as_array().unwrap().iter().find(|concept| concept["id"] == "prefetching").unwrap();
    assert_eq!(prefetching["parent"], Value::Null);
    assert_eq!(call(&app, Method::PUT, &format!("{path}/parent"), Some(json!({ "concept": "cache", "parent": "nope" }))).await.0, StatusCode::NOT_FOUND);
}

/// While a file is being built, the server says which file and which step it is on.
///
///   during the first AI call:   week4.txt, step 2 of 4, "Finding concepts and links"
///   during the second AI call:  week4.txt, step 4 of 4, "Looking for links the first pass missed"
///   afterwards:                 nothing is being built
#[tokio::test]
async fn an_upload_reports_how_far_along_it_is() {
    use std::sync::{Arc, Mutex, OnceLock};
    static APP: OnceLock<Router> = OnceLock::new();
    let seen = Arc::new(Mutex::new(Vec::<Value>::new()));
    let record = seen.clone();
    let claude = Router::new().route("/v1/messages", axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
        let record = record.clone();
        async move {
            // Ask the app what it is doing, from inside the AI call it is waiting on.
            let (_, progress) = call(APP.get().unwrap(), Method::GET, "/api/notebooks/n1/progress", None).await;
            record.lock().unwrap().push(progress);
            let payload = if body["system"].as_str().unwrap().starts_with("You propose dependencies") {
                json!({ "links": [] })
            } else {
                let concept = |title: &str, quote: &str| json!({ "title": title, "target": "", "relation": "", "symbol": "", "page": 1, "quote": quote });
                json!({ "items": [concept("Cache", "A cache keeps frequently used data close."), concept("Locality", "Caches work because programs show locality.")] })
            };
            axum::Json(json!({ "stop_reason": "end_turn", "content": [{ "type": "text", "text": payload.to_string() }] }))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let settings = graphu_ingest::Settings { api_key: Some("test".into()), model: "test".into(),
        base_url: format!("http://{}", listener.local_addr().unwrap()), transcribe_cmd: None };
    tokio::spawn(async move { axum::serve(listener, claude).await.unwrap() });
    let app = APP.get_or_init(|| graphu_server::app(Graphu::in_memory().unwrap(), None, settings));

    let (_, made) = call(app, Method::POST, "/api/notebooks", Some(json!({ "title": "Systems" }))).await;
    assert_eq!(made["id"], "n1");
    assert_eq!(call(app, Method::GET, "/api/notebooks/n1/progress", None).await.1, Value::Null);
    let notes = b"A cache keeps frequently used data close.\nCaches work because programs show locality.".to_vec();
    assert_eq!(upload(app, "/api/notebooks/n1/documents?name=week4.txt", notes).await.0, StatusCode::OK);

    let seen = seen.lock().unwrap();
    assert_eq!(seen[0], json!({ "name": "week4.txt", "step": 2, "of": 4, "label": "Finding concepts and links" }));
    assert_eq!(seen[1], json!({ "name": "week4.txt", "step": 4, "of": 4, "label": "Looking for links the first pass missed" }));
    assert_eq!(call(app, Method::GET, "/api/notebooks/n1/progress", None).await.1, Value::Null, "nothing is left behind");
    // A file that is refused leaves nothing behind either.
    assert_eq!(upload(app, "/api/notebooks/n1/documents?name=data.bin", vec![0, 1, 2]).await.0, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(call(app, Method::GET, "/api/notebooks/n1/progress", None).await.1, Value::Null);
}
