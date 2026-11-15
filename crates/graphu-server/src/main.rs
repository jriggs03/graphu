//! Start the Graphu server.
//!
//! Settings (all optional, read from the environment):
//!   GRAPHU_DB    where the SQLite file lives   (default data/graphu.sqlite3)
//!   GRAPHU_WEB   folder with the built frontend (default web/dist)
//!   GRAPHU_ADDR  address to listen on           (default 127.0.0.1:8000)

use std::path::PathBuf;

use graphu_core::Graphu;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let setting = |name: &str, fallback: &str| std::env::var(name).unwrap_or_else(|_| fallback.to_string());
    let db = PathBuf::from(setting("GRAPHU_DB", "data/graphu.sqlite3"));
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
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("Graphu is running at http://{addr}  (data: {})", db.display());
    axum::serve(listener, graphu_server::app(graphu, has_web.then_some(web))).await?;
    Ok(())
}
