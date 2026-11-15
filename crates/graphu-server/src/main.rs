//! Start the Graphu server.
//!
//! Settings (all optional, read from the environment):
//!   GRAPHU_DB    where the SQLite file lives   (default data/graphu-rs.sqlite3)
//!   GRAPHU_WEB   folder with the built frontend (default web/dist)
//!   GRAPHU_ADDR  address to listen on           (default 127.0.0.1:8000)
//!   ANTHROPIC_API_KEY      lets Graphu read uploads with Claude. Without it only the sample works.
//!   GRAPHU_MODEL           Claude model               (default claude-sonnet-5-5)
//!   GRAPHU_TRANSCRIBE_CMD  command that turns an audio file ($1) into text, for voice notes

use std::path::PathBuf;

use graphu_core::Graphu;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let setting = |name: &str, fallback: &str| std::env::var(name).unwrap_or_else(|_| fallback.to_string());
    let db = PathBuf::from(setting("GRAPHU_DB", "data/graphu-rs.sqlite3"));
    let web = PathBuf::from(setting("GRAPHU_WEB", "web/dist"));
    let addr = setting("GRAPHU_ADDR", "127.0.0.1:8000");

    if let Some(folder) = db.parent().filter(|folder| !folder.as_os_str().is_empty()) {
        std::fs::create_dir_all(folder)?;
    }
    let mut graphu = Graphu::open(&db)?;
    // The built-in sample means the app works with no API key.
    graphu.ensure_samples()?;

    let has_web = web.join("index.html").is_file();
    if !has_web {
        eprintln!("No built frontend at {}. Serving the API only. Run: npm --prefix web run build", web.display());
    }
    let settings = graphu_ingest::Settings::from_env();
    match &settings.api_key {
        Some(_) => println!("AI: uploads are read with {}.", settings.model),
        None => println!("AI: no ANTHROPIC_API_KEY set. Uploads are recorded but not read; the sample still works."),
    }
    if settings.transcribe_cmd.is_none() {
        println!("Voice notes: no GRAPHU_TRANSCRIBE_CMD set, so audio is recorded but not transcribed.");
    }
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("Graphu is running at http://{addr}  (data: {})", db.display());
    axum::serve(listener, graphu_server::app(graphu, has_web.then_some(web), settings)).await?;
    Ok(())
}
