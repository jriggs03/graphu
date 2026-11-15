# Graphu

Graphu helps college students connect concepts across lecture PDFs. It proposes concepts and relationships, shows a document name, page number and supporting quote for each, and adds them to the map after review.

## Status of the rewrite

Graphu is moving from the Python scaffold to Rust. Three pieces exist today:

| Piece | Where | What it does |
|---|---|---|
| Frontend | `web/` | The redesigned UI from `docs/design/`. It talks to a backend only through `web/src/api.ts`. |
| Core | `crates/graphu-core` | The rules and SQLite storage: grounding, review, batches, undo, graph queries. |
| Server | `crates/graphu-server` | An Axum web server. Each route calls one core function, and it serves the built frontend. |

The frontend picks its backend when it loads. If `/api/info` answers, it uses the server. If not (for example on a static host), it falls back to a built-in sample that lives in the browser's localStorage.

### What you can add

Uploads go through `crates/graphu-ingest`, then the grounding check, then your review queue.

| You add | How its text is obtained |
|---|---|
| PDF with selectable text, `.txt`, `.md`, PowerPoint (`.pptx`), Word (`.docx`) | Read on the server, no AI needed for this step |
| Photo of handwriting or a whiteboard (JPEG, PNG, GIF, WebP, up to 5 MB), scanned PDF (up to 30 pages) | Transcribed by Claude |
| Voice note (MP3, M4A, WAV and similar) | Transcribed by the command in `GRAPHU_TRANSCRIBE_CMD` |

Claude then proposes concepts and links from that text, each with a page and an exact quote. A proposal whose quote is not on the cited page is dropped. For photos, scans and audio the quote is checked against the transcription, and the batch says so.

Without `ANTHROPIC_API_KEY` the server still runs: the sample works, and uploads are recorded with a note saying they were not read. HEIC photos are not supported; export them as JPEG or PNG. Limits: 25 MB per file, 100 pages, 300,000 characters. A duplicate file is blocked by its content hash and costs no AI call.

### Run the Rust server

You need Rust (`brew install rust`) and Node.js 22.

```sh
npm --prefix web ci
npm --prefix web run build
cargo run -p graphu-server
```

Open http://127.0.0.1:8000. The sample graphbooks load with no API key. To read your own files, start it with a key: `ANTHROPIC_API_KEY=your-key cargo run -p graphu-server`. Settings, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `GRAPHU_DB` | `data/graphu-rs.sqlite3` | Where the SQLite file lives. It must not be the Python backend's file. |
| `GRAPHU_WEB` | `web/dist` | Folder with the built frontend. |
| `GRAPHU_ADDR` | `127.0.0.1:8000` | Address to listen on. Use `0.0.0.0:8000` inside a container. |
| `ANTHROPIC_API_KEY` | not set | Lets Graphu read uploads with Claude. It stays on the server and never reaches the browser. |
| `GRAPHU_MODEL` | `claude-sonnet-5-5` | Claude model used for transcription and extraction. |
| `GRAPHU_TRANSCRIBE_CMD` | not set | Shell command for voice notes. It receives the audio file path as `$1` and prints the transcript. |

The server keeps one shared workspace and has no sign-in, the same as the Python scaffold.

For frontend development run the server, then `npm --prefix web run dev` and open http://localhost:5173. Vite forwards `/api` to port 8000.

### Tests

```sh
cargo test --workspace
```

The Python backend below still works and still passes its tests. It is the safety net until the Rust server has been tried on real lecture files with a real key.

## Run the Python scaffold locally

Use Python 3.12 and Node.js 22.13 or newer within the 22.x line.

```sh
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
npm --prefix web ci
npm --prefix web run build
uvicorn backend.main:create_app --factory
```

Open http://localhost:8000 and choose **Try sample notes**. Approve Hash table and Chaining, then approve their relationship. Select any concept or relationship to inspect its source. Reload to see the persisted map.

To enable PDF uploads from your Mac, stop any Graphu server already running on port 8000, then run this from the repo root:

```sh
.venv/bin/python -m backend.start
```

Paste your OpenAI API key at the hidden Terminal prompt. Graphu keeps the key in the server process for that session. Refresh http://localhost:8000, choose a text-based PDF, and confirm that its extracted text can be sent to OpenAI.

To configure an unattended server, set `OPENAI_API_KEY` in the server environment before starting Uvicorn. Optionally set `GRAPHU_MODEL` to a compatible Structured Outputs model (default `gpt-4o-mini`) and `GRAPHU_DB` to a writable SQLite path (default `data/graphu.sqlite3`). See `.env.example` for names. Uvicorn does not load that example file.

For frontend development, keep the backend running and use `npm --prefix web run dev`. To install the built PWA, serve it over HTTPS or localhost and use the browser’s install or Add to Home Screen action where available. Import, review and graph access require a connection to the backend.

## How it works

1. **Import.** FastAPI accepts a text-based PDF of up to 8 MB, 30 pages and 60,000 extracted characters. pypdf reads page text and preserves page numbering. A document hash prevents duplicate ingestion.
2. **Extract.** The OpenAI Responses API receives page text and returns structured suggestions. Graphu verifies that each quote appears on its reported page after whitespace normalization. Reviewers decide whether that quote actually supports the proposed concept or relationship.
3. **Review.** SQLite stores pending, approved and rejected suggestions. Relationships require both concepts to be approved. Rejected claims without existing approved evidence are suppressed on later imports when their normalized names and relation match.
4. **Explore.** React renders approved concepts and relationships. Drag nodes, zoom, search, and select a concept or relationship to see its supporting excerpts. Later uploads can add evidence to existing graph items. Node positions reset on reload.

See `/docs` on the running server for the API. The weekend scope is one trusted workspace. Separate users, OCR, audio, personal overlays, and editing approved claims are future work.

## Demo hosting

Build the frontend and run the same FastAPI application behind HTTPS with a persistent SQLite volume. The app shares one workspace and has no authentication or usage limits built in. Keep a live-AI deployment behind your host’s access controls and use course materials you have permission to share with OpenAI. For an ungated judging link, leave the API key unset to provide the built-in sample without external API usage. PDF bytes and full extracted text are transient in Graphu. Stored data includes source names, hashes, quotes and graph decisions.

## Tests

```sh
python -m unittest discover -s tests -v
npm --prefix web run build
```

[Hackathon schedule, contribution workflow and credits](HACKATHON.md)

## Licensing

The repository starts private. An open-source license for original project code is pending the team’s decision. Dependencies retain their respective licenses.
