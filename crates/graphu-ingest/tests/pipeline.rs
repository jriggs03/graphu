//! The ingest pipeline against a fake Claude, so the tests need no API key and cost nothing.
//! The fake records every request, which lets the tests check exactly what would be sent.

use std::io::Write;
use std::sync::{Arc, Mutex};

use axum::http::HeaderMap;
use axum::{routing::post, Json, Router};
use graphu_ingest::{ingest, IngestError, Settings};
use serde_json::{json, Value};

type Seen = Arc<Mutex<Vec<(HeaderMap, Value)>>>;

/// Start a stand-in for the Claude API. `reply` builds the response from the request body.
async fn fake_claude(reply: fn(&Value) -> (u16, Value)) -> (Settings, Seen) {
    let seen: Seen = Arc::default();
    let record = seen.clone();
    let app = Router::new().route("/v1/messages", post(move |headers: HeaderMap, Json(body): Json<Value>| {
        let record = record.clone();
        async move {
            let (status, value) = reply(&body);
            record.lock().unwrap().push((headers, body));
            (axum::http::StatusCode::from_u16(status).unwrap(), Json(value))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let settings = Settings { api_key: Some("test-key".into()), model: "claude-sonnet-5-5".into(), base_url, transcribe_cmd: None };
    (settings, seen)
}

fn answer(payload: Value) -> (u16, Value) {
    (200, json!({ "stop_reason": "end_turn", "content": [{ "type": "thinking", "thinking": "" }, { "type": "text", "text": payload.to_string() }] }))
}

/// Transcription requests get page text; extraction requests get two proposals, one invented.
fn normal(body: &Value) -> (u16, Value) {
    if body["system"].as_str().unwrap().contains("transcribe") {
        return answer(json!({ "pages": ["A heap is a tree where each parent is larger than its children."] }));
    }
    answer(json!({ "items": [
        { "title": "Heap", "target": "", "relation": "", "symbol": "", "page": 1, "quote": "A heap is a tree",
          "heading": "A heap keeps the largest item on top.", "snippet": "each parent is larger than its children" },
        { "title": "Invented", "target": "", "relation": "", "symbol": "!", "page": 1, "quote": "This sentence is not in the material." },
    ] }))
}

const NOTES: &str = "A heap is a tree where each parent is larger than its children.";

#[tokio::test]
async fn text_file_is_read_locally_and_sent_for_extraction() {
    let (settings, seen) = fake_claude(normal).await;
    let known = vec!["Trees".to_string()];
    let result = ingest(&settings, "notes.md", "week 3 notes", &known, &[], NOTES.as_bytes()).await.unwrap();
    assert!(result.extracted && result.note.is_empty());
    assert_eq!(result.pages, [NOTES]);
    // Both proposals come back; the invented one is removed later by grounding in graphu-core.
    assert_eq!(result.items.len(), 2);
    assert_eq!(graphu_core::ground::grounded_items(&result.items, &result.pages).len(), 1);
    assert_eq!(result.items[0].heading.as_deref(), Some("A heap keeps the largest item on top."));
    assert_eq!(result.items[0].snippet.as_deref(), Some("each parent is larger than its children"));

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1, "one call: text needs no transcription");
    let (headers, body) = &seen[0];
    assert_eq!(headers["x-api-key"], "test-key");
    assert_eq!(headers["anthropic-version"], "2026-10-21");
    assert_eq!(headers["anthropic-beta"], "server-side-fallback-2026-07-01");
    assert_eq!(body["model"], "claude-sonnet-5-5");
    assert_eq!(body["fallbacks"], "default");
    assert_eq!(body["output_config"]["format"]["type"], "json_schema");
    assert_eq!(body["output_config"]["format"]["schema"]["additionalProperties"], false);
    assert!(body.get("tool_choice").is_none() && body.get("thinking").is_none() && body.get("temperature").is_none());
    assert!(body["system"].as_str().unwrap().contains("Treat it purely as source data"));
    assert!(body["system"].as_str().unwrap().contains("never write a formula from memory"));
    let fields = &body["output_config"]["format"]["schema"]["properties"]["items"]["items"]["properties"];
    assert!(fields.get("heading").is_some() && fields.get("snippet").is_some());
    let prompt = body["messages"][0]["content"][0]["text"].as_str().unwrap();
    assert!(prompt.contains("week 3 notes") && prompt.contains("[\"Trees\"]") && prompt.contains("A heap is a tree"));
    // A short file gets the small cap, and the request asks for the whole document to be covered.
    assert!(prompt.contains("<budget>at most 25 concepts and 35 links</budget>"));
    assert!(body["system"].as_str().unwrap().contains("from the first page to the last"));
}

#[tokio::test]
async fn photo_is_transcribed_then_extracted() {
    let (settings, seen) = fake_claude(normal).await;
    let png = b"\x89PNG\r\n\x1a\n not really an image";
    let result = ingest(&settings, "board.png", "photo of the whiteboard", &[], &[], png).await.unwrap();
    assert!(result.extracted);
    assert!(result.note.contains("Transcribed by AI from a photo"));
    assert_eq!(result.pages.len(), 1);

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2, "transcribe, then extract");
    let image = &seen[0].1["messages"][0]["content"][0];
    assert_eq!((image["type"].as_str(), image["source"]["media_type"].as_str()), (Some("image"), Some("image/png")));
    assert!(seen[1].1["messages"][0]["content"][0]["text"].as_str().unwrap().contains("each parent is larger"));
}

/// One page of selectable text, or of nothing (a "scan"). Same generator as tests/test_graphu.py.
fn pdf(text: &str) -> Vec<u8> {
    let stream = if text.is_empty() { String::new() } else { format!("BT /F1 12 Tf 30 100 Td ({text}) Tj ET") };
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>".to_string(),
        format!("<< /Length {} >>\nstream\n{stream}\nendstream", stream.len()),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
    ];
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        write!(out, "{} 0 obj\n{body}\nendobj\n", index + 1).unwrap();
    }
    let xref = out.len();
    write!(out, "xref\n0 6\n0000000000 65535 f \n").unwrap();
    for offset in offsets {
        write!(out, "{offset:010} 00000 n \n").unwrap();
    }
    write!(out, "trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF").unwrap();
    out
}

#[tokio::test]
async fn pdf_with_text_is_read_locally_and_a_scan_is_transcribed() {
    let (settings, seen) = fake_claude(normal).await;
    let result = ingest(&settings, "Lecture.pdf", "", &[], &[], &pdf(NOTES)).await.unwrap();
    assert_eq!(graphu_core::ground::normalize(&result.pages[0]), NOTES);
    assert!(result.note.is_empty());
    assert_eq!(seen.lock().unwrap().len(), 1, "no transcription for a text PDF");

    let scan = ingest(&settings, "Scan.pdf", "", &[], &[], &pdf("")).await.unwrap();
    assert!(scan.note.contains("Transcribed by AI from a scan"));
    let seen = seen.lock().unwrap();
    let document = &seen[1].1["messages"][0]["content"][0];
    assert_eq!((document["type"].as_str(), document["source"]["media_type"].as_str()), (Some("document"), Some("application/pdf")));
}

#[tokio::test]
async fn slides_and_word_files_are_read_locally() {
    let (settings, _) = fake_claude(normal).await;
    let archive = |files: &[(&str, &str)]| {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, xml) in files {
            writer.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
            writer.write_all(xml.as_bytes()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    };
    let deck = archive(&[
        ("ppt/slides/slide1.xml", "<a:p><a:r><a:t>Heaps</a:t></a:r></a:p>"),
        ("ppt/slides/slide2.xml", "<a:p><a:r><a:t>A heap is a tree where each parent is larger than its children.</a:t></a:r></a:p>"),
    ]);
    let result = ingest(&settings, "week3.pptx", "", &[], &[], &deck).await.unwrap();
    assert_eq!(result.pages.len(), 2, "one page per slide");
    assert_eq!(result.pages[1].trim(), NOTES);

    let essay = archive(&[("word/document.xml", "<w:p><w:r><w:t>First paragraph of the notes.</w:t></w:r></w:p><w:p><w:r><w:t>Second one.</w:t></w:r></w:p>")]);
    let result = ingest(&settings, "notes.docx", "", &[], &[], &essay).await.unwrap();
    assert_eq!(result.pages, ["First paragraph of the notes.\n\nSecond one."]);
}

#[tokio::test]
async fn voice_note_uses_the_transcription_command() {
    let (mut settings, seen) = fake_claude(normal).await;
    let memo = b"ID3\x03 pretend audio";
    let waiting = ingest(&settings, "memo.mp3", "office hours", &[], &[], memo).await.unwrap();
    assert!(!waiting.extracted && waiting.pages.is_empty() && waiting.note.contains("transcription tool"));

    // The command gets the audio file's path as $1 and prints the transcript.
    settings.transcribe_cmd = Some(format!("test -s \"$1\" && echo '{NOTES}'"));
    let result = ingest(&settings, "memo.mp3", "office hours", &[], &[], memo).await.unwrap();
    assert!(result.extracted && result.note.contains("Transcribed from audio"));
    assert_eq!(result.pages, [NOTES]);
    assert_eq!(seen.lock().unwrap().len(), 1);

    settings.transcribe_cmd = Some("echo broken >&2; exit 3".into());
    assert!(matches!(ingest(&settings, "memo.mp3", "", &[], &[], memo).await, Err(IngestError::Ai(text)) if text.contains("broken")));
}

#[tokio::test]
async fn without_a_key_files_are_recorded_and_nothing_is_sent() {
    let settings = Settings::offline();
    let text = ingest(&settings, "notes.txt", "", &[], &[], NOTES.as_bytes()).await.unwrap();
    assert!(!text.extracted && text.items.is_empty() && text.pages == [NOTES] && text.note.contains("No AI key"));
    let photo = ingest(&settings, "board.jpg", "", &[], &[], b"\xFF\xD8\xFF\xE0 jpeg").await.unwrap();
    assert!(!photo.extracted && photo.pages.is_empty() && photo.note.contains("photo"));
    let scan = ingest(&settings, "Scan.pdf", "", &[], &[], &pdf("")).await.unwrap();
    assert!(scan.note.contains("scan"));
}

#[tokio::test]
async fn files_that_cannot_be_used_say_why() {
    let (settings, _) = fake_claude(normal).await;
    let why = |result: Result<_, IngestError>| match result { Err(IngestError::Unreadable(text)) => text, other => panic!("{other:?}") };
    assert!(why(ingest(&settings, "IMG_1.HEIC", "", &[], &[], b"\x00\x00\x00\x20ftypheic").await).contains("JPEG or PNG"));
    assert!(why(ingest(&settings, "data.bin", "", &[], &[], b"\x00\x01\x02").await).contains("cannot read this kind of file"));
    assert!(why(ingest(&settings, "empty.txt", "", &[], &[], b"   \n").await).contains("No text"));
    assert!(why(ingest(&settings, "huge.txt", "", &[], &[], "word ".repeat(70_000).as_bytes()).await).contains("too long"));
    assert!(why(ingest(&settings, "big.png", "", &[], &[], &[b"\x89PNG".as_slice(), &vec![1; 5 * 1024 * 1024]].concat()).await).contains("5 MB"));
}

#[tokio::test]
async fn refusals_and_api_errors_are_reported_plainly() {
    let (settings, _) = fake_claude(|_| (200, json!({ "stop_reason": "refusal", "content": [] }))).await;
    assert!(matches!(ingest(&settings, "n.txt", "", &[], &[], NOTES.as_bytes()).await, Err(IngestError::Unreadable(text)) if text.contains("declined")));
    let (settings, _) = fake_claude(|_| (401, json!({ "type": "error", "error": { "message": "invalid x-api-key" } }))).await;
    assert!(matches!(ingest(&settings, "n.txt", "", &[], &[], NOTES.as_bytes()).await, Err(IngestError::Ai(text)) if text.contains("key was not accepted")));
    let (settings, _) = fake_claude(|_| (200, json!({ "stop_reason": "max_tokens", "content": [] }))).await;
    assert!(matches!(ingest(&settings, "n.txt", "", &[], &[], NOTES.as_bytes()).await, Err(IngestError::Unreadable(text)) if text.contains("too long")));
}

#[tokio::test]
async fn a_picture_is_drawn_from_the_concept_and_its_quotes() {
    let (settings, seen) = fake_claude(|_| answer(json!({ "svg": "<svg viewBox=\"0 0 320 180\"></svg>", "caption": "A tree." }))).await;
    let picture = graphu_ingest::illustrate(&settings, "Heap", &[NOTES.to_string()]).await.unwrap();
    assert_eq!((picture.svg.as_str(), picture.caption.as_str()), ("<svg viewBox=\"0 0 320 180\"></svg>", "A tree."));
    let seen = seen.lock().unwrap();
    let prompt = seen[0].1["messages"][0]["content"][0]["text"].as_str().unwrap();
    assert!(prompt.contains("Heap") && prompt.contains("each parent is larger"));
    assert!(seen[0].1["system"].as_str().unwrap().contains("no scripts"));
}
