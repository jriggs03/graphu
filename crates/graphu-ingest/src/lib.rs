//! Turns one uploaded file into page text and proposals.
//!
//! ```text
//!  file ─▶ what is it? ─▶ get its text ───────────────────────▶ ask Claude ─▶ proposals
//!          (read.rs)      PDF, text, slides, Word: read here     (claude.rs)   + page text
//!                         photo, scan: Claude transcribes
//!                         audio: an outside transcription tool
//! ```
//!
//! The caller (the server, later the desktop app) stores the result with `graphu-core`, which
//! runs the grounding check. With no AI key, files are still recorded; the note says why
//! nothing was proposed.

mod claude;
pub mod read;

use graphu_core::Candidate;
use read::Kind;

pub use claude::{illustrate, AiError, Illustration};

/// Largest file accepted.
pub const MAX_BYTES: usize = 25 * 1024 * 1024;
/// Largest photo Claude accepts.
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_PAGES: usize = 100;
const MAX_SCANNED_PAGES: usize = 30;
const MAX_TEXT: usize = 300_000;

/// Where the AI lives. Read once from the environment when the server starts.
#[derive(Debug, Clone)]
pub struct Settings {
    /// `ANTHROPIC_API_KEY`. Without it, files are recorded but not read by AI.
    pub api_key: Option<String>,
    /// `GRAPHU_MODEL`, default `claude-sonnet-5-5`.
    pub model: String,
    /// `ANTHROPIC_BASE_URL`, default the Anthropic API. Tests point this at a fake.
    pub base_url: String,
    /// `GRAPHU_TRANSCRIBE_CMD`: a shell command that receives an audio file path as `$1` and
    /// prints the transcript. Without it, voice notes are recorded but not transcribed.
    pub transcribe_cmd: Option<String>,
}

impl Settings {
    pub fn from_env() -> Self {
        let read = |name: &str| std::env::var(name).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
        Settings {
            api_key: read("ANTHROPIC_API_KEY"),
            model: read("GRAPHU_MODEL").unwrap_or_else(|| "claude-sonnet-5-5".into()),
            base_url: read("ANTHROPIC_BASE_URL").unwrap_or_else(|| "https://api.anthropic.com".into()),
            transcribe_cmd: read("GRAPHU_TRANSCRIBE_CMD"),
        }
    }

    /// Settings with no AI at all. Every file is recorded and none is read by AI.
    pub fn offline() -> Self {
        Settings { api_key: None, model: "claude-sonnet-5-5".into(), base_url: String::new(), transcribe_cmd: None }
    }
}

/// What came out of one file.
#[derive(Debug, Default)]
pub struct Ingested {
    pub pages: Vec<String>,
    pub items: Vec<Candidate>,
    /// True when Claude proposed from this file (even if it proposed nothing).
    pub extracted: bool,
    /// Shown with the batch: why nothing was read, or that the text is an AI transcription.
    pub note: String,
}

#[derive(Debug)]
pub enum IngestError {
    /// 422: this file cannot be used. The message says what to do instead.
    Unreadable(String),
    /// 502: the AI step failed.
    Ai(String),
}

impl From<AiError> for IngestError {
    fn from(error: AiError) -> Self {
        match error {
            AiError::Unavailable(text) => IngestError::Ai(text),
            AiError::Declined(text) => IngestError::Unreadable(text),
        }
    }
}

const NO_KEY: &str = "No AI key is set on the server, so nothing was proposed from this file.";

fn recorded(pages: Vec<String>, note: &str) -> Ingested {
    Ingested { pages, items: Vec::new(), extracted: false, note: note.to_string() }
}

/// Run a transcription command: the audio file path is `$1`, the transcript is its output.
async fn transcribe_audio(command: &str, name: &str, bytes: &[u8]) -> Result<String, IngestError> {
    let failed = |why: String| IngestError::Ai(format!("The voice note could not be transcribed: {why}"));
    let extension = name.rsplit('.').next().filter(|ext| ext.len() <= 5 && ext.chars().all(char::is_alphanumeric)).unwrap_or("audio");
    let path = std::env::temp_dir().join(format!("graphu-{}.{extension}", graphu_core::sha256_hex(bytes)));
    tokio::fs::write(&path, bytes).await.map_err(|error| failed(error.to_string()))?;
    let output = tokio::process::Command::new("sh").arg("-c").arg(command).arg("graphu-transcribe").arg(&path).output().await;
    let _ = tokio::fs::remove_file(&path).await;
    let output = output.map_err(|error| failed(error.to_string()))?;
    if !output.status.success() {
        return Err(failed(String::from_utf8_lossy(&output.stderr).lines().last().unwrap_or("the tool failed").to_string()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Turn one file into page text and proposals.
///
/// in:  the file's name and bytes, the student's note about it, the concepts already in the graph
/// out: page text + proposals (not yet grounded), or a note saying why there are none
pub async fn ingest(settings: &Settings, name: &str, context: &str, known: &[String], bytes: &[u8]) -> Result<Ingested, IngestError> {
    let unreadable = |text: &str| Err(IngestError::Unreadable(text.to_string()));
    let has_key = settings.api_key.is_some();
    let mut note = String::new();

    let pages: Vec<String> = match read::classify(name, bytes) {
        Kind::Text => read::text_pages(&String::from_utf8_lossy(bytes)),
        Kind::Slides => read::slides_pages(bytes).map_err(IngestError::Unreadable)?,
        Kind::Word => read::word_pages(bytes).map_err(IngestError::Unreadable)?,
        Kind::Pdf => {
            let pages = read::pdf_pages(bytes).map_err(IngestError::Unreadable)?;
            let letters: usize = pages.iter().map(|page| page.split_whitespace().map(str::len).sum::<usize>()).sum();
            if letters >= 40 * pages.len().max(1) {
                pages
            } else if !has_key {
                // A scan: there is no text layer to read without AI.
                return Ok(recorded(Vec::new(), "This PDF is a scan with no text layer. Reading it needs an AI key on the server."));
            } else if pages.len() > MAX_SCANNED_PAGES {
                return unreadable("This scanned PDF is too long. Split it into files of 30 pages or fewer.");
            } else {
                note = "Transcribed by AI from a scan. Quotes are checked against that transcription, not the original.".into();
                claude::transcribe(settings, "application/pdf", bytes).await?
            }
        }
        Kind::Image(media_type) => {
            if !has_key {
                return Ok(recorded(Vec::new(), "Reading a photo needs an AI key on the server, so nothing was read from this file."));
            }
            if bytes.len() > MAX_IMAGE_BYTES {
                return unreadable("This photo is over 5 MB. Export a smaller copy and add that.");
            }
            note = "Transcribed by AI from a photo. Quotes are checked against that transcription, not the original.".into();
            claude::transcribe(settings, media_type, bytes).await?
        }
        Kind::OtherImage => return unreadable("This photo format cannot be read. Export it as JPEG or PNG and add that."),
        Kind::Audio => match &settings.transcribe_cmd {
            None => return Ok(recorded(Vec::new(), "Voice notes need a transcription tool on the server, so this recording was not transcribed.")),
            Some(command) => {
                note = "Transcribed from audio. Quotes are checked against the transcript, not the recording.".into();
                read::text_pages(&transcribe_audio(command, name, bytes).await?)
            }
        },
        Kind::Unknown => return unreadable("Graphu cannot read this kind of file. Try a PDF, text, PowerPoint, Word, photo or audio file."),
    };

    if pages.iter().all(|page| page.trim().is_empty()) {
        return unreadable("No text was found in this file.");
    }
    if pages.len() > MAX_PAGES || pages.iter().map(String::len).sum::<usize>() > MAX_TEXT {
        // Never cut a document short without saying so.
        return unreadable("This file is too long. Split it into files of up to 100 pages and 300,000 characters.");
    }
    if !has_key {
        return Ok(recorded(pages, NO_KEY));
    }
    let items = claude::extract(settings, context, known, &pages).await?;
    Ok(Ingested { pages, items, extracted: true, note })
}
