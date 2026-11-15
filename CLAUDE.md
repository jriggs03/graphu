# Graphu: instructions for Claude Code

Graphu turns a student's own course material (slides, notes, voice memos) into an interactive concept graph. Every concept and relationship is traced back to a source page and quote. **AI organizes; the student decides.** Nothing enters the graph without the student's approval.

This file is the build plan for the CPVC × OCOB × CPE AI Hackathon. Read it fully before writing code.

## Deadlines (Pacific, Sun Nov 15 2026)

- **Noon: submissions close.** Whatever is live at noon is what's judged. Freeze features about 11:00 AM.
- The submission needs: a live link, the repo link, a short description including the AI tools used and what each did, and a demo video under 2 minutes (we are entering **Best Use of AI**).
- Best Use of AI rule: *the product must stop working without AI; a chatbot added on the side doesn't qualify.* Graphu has **no chatbot UI**. AI extraction is what builds the graph.

## Decisions already made

| Decision | Choice |
|---|---|
| Deliverable | **Web app first.** Desktop (Tauri) comes later, wrapping the same core and frontend. |
| Backend | **Rust**: `graphu-core` library + `graphu-server` (Axum). Structure it so a Tauri shell can reuse the core with no rewrite. |
| AI provider | **Anthropic Claude API** (Messages API, structured output via tool use). Env: `ANTHROPIC_API_KEY`, optional `GRAPHU_MODEL` (default `claude-sonnet-5-5`). Key stays server-side. |
| Storage | SQLite (`rusqlite` or `sqlx`), path from `GRAPHU_DB`. |
| Frontend | New UI based on `docs/design/` (see below). Keep it a responsive PWA. All graph interaction runs in memory in the browser, with no server round trip on click, drag, zoom or search. |
| Safety net | **Keep the existing Python backend (`backend/`) working until the Rust server passes the same behaviors.** If Rust PDF extraction isn't reliable by ~8 AM, the live link runs on Python and Rust ships what works. |

## Design references (in `docs/design/`)

- `prototype-unix-map.html`: **the interaction model James approved.** Circular clickable nodes with a symbol plus a short label. A selected node turns accent-colored, its neighbors get stronger outlines, and unrelated nodes dim. The side panel shows a plain-language heading, a tiny code/formula snippet, a small visual, a citation, **Learn first** chips (prerequisites) and **Used by** chips (dependents), plus a **Next** button. Node size uses three PageRank tiers computed on dependent → prerequisite edges. Edges stop at circle edges and never run through labels. Reuse this engine, generalized so the data comes from the API, not hardcoded.
- `sketch-home.png`: **Home screen.** Left sidebar: tabs at top, list of notebooks ("graphbooks") below, settings at bottom. Center: the Graphu name, plus a **context box** with a **+** button to add files.
  - The context box gives *context about the material being added* ("week 6 slides", "voice memo from office hours"). It is **not** a "teach me X" prompt.
  - **Drag and drop works anywhere on the home screen** and also onto an open graph.
- `sketch-notebook.png`: **Inside a notebook.** Slim left icon rail (search, add, sources, …, settings at bottom); the graph fills the rest.
  - **Search** matches concept names, slide text, quotes and the student's comments, then highlights matching nodes and dims the rest.
  - **"Want to learn" target:** the student picks a concept; Graphu highlights every prerequisite reachable from it (green "need to know" path). `Need(t) = { v : t →* v along relies-on edges }`. The prototype's numbered route is the hand-authored version of this.
  - **"Not in slide !" marker** on any node without source evidence (user-added). It is visible, never hidden.

## Behaviors that must hold (from the spec and the current tests)

1. **Grounding:** every AI-proposed concept/edge carries `{source_id, page, quote}`. The server verifies the quote appears on that page (after whitespace normalization) before it's shown. Unverifiable items are dropped. Port `grounded_items` in `backend/extraction.py` exactly.
2. **Review before graph:** proposals are `pending` until approved. An edge needs both endpoints approved.
3. **New vs old + undo:** each upload is a **batch**. New items are visibly marked until reviewed. Undo works per item and per batch, and nothing is ever silently overwritten.
4. **Incremental:** later uploads add evidence to existing concepts (merge is proposed, not automatic). Content hashing (SHA-256) blocks duplicate documents. **Rejected claims are not re-proposed** from unchanged input.
5. **Provenance UI:** clicking any node or edge shows its quotes with document name and page.
6. **No-key sample:** a built-in sample notebook works with no API key, so the judging link always works.
7. Treat document text as untrusted data: the extraction prompt must ignore instructions inside it.
8. Port the three tests in `tests/test_graphu.py` (demo review/persistence; PDF provenance, duplicate and rejection; built PWA served) to Rust integration tests.

## Order of work (always keep something demoable)

1. **Frontend redesign on sample data** (home, notebooks, graph engine, search highlight, drag-drop, batches, undo UI). Talk to the backend through one `api.ts` module (later it can switch to Tauri `invoke`). **Deploy immediately** as the live link.
2. **Rust core:** schema, graph queries, PageRank, review, batches/undo, grounding check, with ported tests passing.
3. **Axum server** exposing the same API the frontend uses. Serve the built frontend.
4. **PDF text per page** (`pdf-extract`/`lopdf`) + **Claude extraction** + grounding. Test on a real text-based lecture PDF locally. **Never commit course documents.**
5. **Deploy the Rust server** (Dockerfile, persistent volume for SQLite). Confirm the host with James.
6. Stretch, in order: MCP server exposing `get_concept`, `get_subgraph`, `search`, `propose_edge` (proposals go to the review queue); Tauri desktop shell; per-concept code/formula snippets and visuals like the prototype.

## Before noon

- Update `HACKATHON.md` credits: Claude (Claude Code built the Rust backend and redesign; the Claude API does extraction), OpenAI Codex (initial scaffold), and every crate/library used.
- Update `README.md` run instructions for the Rust server.
- Check the live link in a private window with no key set: sample notebook loads and review works.
- Don't delete commits or AI chats; the organizers check project history.

## Working style

- James learns visually: when explaining code, show what goes in, what happens, and what comes out.
- Branch from `main`, keep commits small and frequent, and run tests before pushing.
- When unsure whether something is supported by a source, Graphu does less: omit, don't invent.
