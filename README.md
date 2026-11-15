# Graphu

Graphu helps college students connect concepts across lecture PDFs. It proposes concepts and relationships, shows a document name, page number and supporting quote for each, and adds them to the map after review.

## Status of the redesign

The frontend in `web/` is the new design from `docs/design/`. For now it runs entirely in the browser on built-in sample notes: `web/src/api.ts` is the only module that talks to a backend, and it is currently answered by `web/src/sample/store.ts` (localStorage). No server or API key is needed, and files you add are recorded as a batch but not read. To try it, run `npm --prefix web run dev` and open http://localhost:5173, or build with `npm --prefix web run build` and host `web/dist` as a static site.

The Python backend below still works and still passes its tests, but the new frontend does not call it. It stays as the safety net until the Rust server exposes the API in `api.ts`.

## Run locally

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
