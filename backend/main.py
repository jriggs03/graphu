import hashlib
import io
import os
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pypdf import PdfReader
from starlette.concurrency import run_in_threadpool

from .extraction import Candidate, Extraction, extract, grounded_items, normalize

MAX_BYTES = 8 * 1024 * 1024
MAX_PAGES = 30
MAX_TEXT = 60_000

DEMO_TEXT = (
    "A hash table maps keys to buckets. A hash function determines the bucket for a key. "
    "Chaining resolves collisions in a hash table by storing several entries in one bucket."
)
DEMO_ITEMS = Extraction(items=[
    Candidate(title=title, target=target, relation=relation, page=1, quote=quote)
    for title, target, relation, quote in [
        ("Hash table", "", "", "A hash table maps keys to buckets."),
        ("Hash function", "", "", "A hash function determines the bucket for a key."),
        ("Chaining", "", "", "Chaining resolves collisions in a hash table"),
        ("Chaining", "Hash table", "resolves collisions in", "Chaining resolves collisions in a hash table"),
    ]
])


class Decision(BaseModel):
    status: Literal["approved", "rejected"]


def connect(path):
    db = sqlite3.connect(path, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def item_keys(item):
    return tuple(value.casefold() for value in (item.title, item.target, item.relation))


def create_app(db_path=None, extractor=extract):
    path = Path(db_path or os.getenv("GRAPHU_DB", "data/graphu.sqlite3"))
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(connect(path)) as db, db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS sources (
                id TEXT PRIMARY KEY, name TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS proposals (
                id INTEGER PRIMARY KEY,
                source_id TEXT NOT NULL REFERENCES sources(id),
                title TEXT NOT NULL, target TEXT NOT NULL, relation TEXT NOT NULL,
                title_key TEXT NOT NULL, target_key TEXT NOT NULL, relation_key TEXT NOT NULL,
                page INTEGER NOT NULL, quote TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected')),
                UNIQUE(source_id, title_key, target_key, relation_key, page, quote)
            );
        """)
    app = FastAPI(title="Graphu")

    def known(source_id):
        with closing(connect(path)) as db:
            return db.execute("SELECT 1 FROM sources WHERE id = ?", (source_id,)).fetchone() is not None

    def save(source_id, name, extraction, pages):
        items = list(grounded_items(extraction, pages))
        with closing(connect(path)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            inserted = db.execute(
                "INSERT OR IGNORE INTO sources VALUES (?, ?)", (source_id, name)
            ).rowcount
            if not inserted:
                return {"duplicate": True, "count": 0}

            count = 0
            for item in items:
                keys = item_keys(item)
                rejected = db.execute(
                    """SELECT 1 FROM proposals WHERE title_key = ? AND target_key = ?
                       AND relation_key = ? AND status = 'rejected'""", keys
                ).fetchone()
                if rejected:
                    continue
                count += db.execute(
                    """INSERT OR IGNORE INTO proposals
                       (source_id, title, target, relation, title_key, target_key,
                        relation_key, page, quote) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (source_id, item.title, item.target, item.relation, *keys, item.page, item.quote),
                ).rowcount
        return {"duplicate": False, "count": count}

    @app.get("/api/state")
    def state():
        with closing(connect(path)) as db:
            rows = db.execute(
                """SELECT p.*, s.name AS source FROM proposals p
                   JOIN sources s ON p.source_id = s.id ORDER BY p.id"""
            ).fetchall()
        nodes = {}
        edges = {}
        pending = []
        for row in rows:
            evidence = {key: row[key] for key in ("source_id", "source", "page", "quote")}
            if row["status"] == "pending":
                pending.append({key: row[key] for key in (
                    "id", "title", "target", "relation", "title_key", "target_key"
                )} | {"evidence": evidence})
            elif row["status"] == "approved":
                if row["target"]:
                    key = (row["title_key"], row["target_key"], row["relation_key"])
                    edge = edges.setdefault(key, {
                        "id": row["id"], "source": key[0], "target": key[1],
                        "label": row["relation"], "evidence": [],
                    })
                    edge["evidence"].append(evidence)
                else:
                    key = row["title_key"]
                    node = nodes.setdefault(key, {"id": key, "label": row["title"], "evidence": []})
                    node["evidence"].append(evidence)
        return {"nodes": list(nodes.values()), "edges": list(edges.values()), "pending": pending,
                "ai_enabled": bool(os.getenv("OPENAI_API_KEY"))}

    @app.post("/api/demo")
    def demo():
        return save("demo-hash-tables", "Hash tables · sample notes", DEMO_ITEMS, [DEMO_TEXT])

    @app.post("/api/documents")
    async def upload(request: Request, name: str):
        name = name.replace("\\", "/").rsplit("/", 1)[-1].strip()[:180] or "Lecture.pdf"
        if request.headers.get("content-type", "").split(";")[0] != "application/pdf":
            raise HTTPException(415, "Choose a PDF document.")
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > MAX_BYTES:
                raise HTTPException(413, "Choose a PDF under 8 MB.")
            data.extend(chunk)
        source_id = hashlib.sha256(data).hexdigest()
        if await run_in_threadpool(known, source_id):
            return {"duplicate": True, "count": 0}
        key = os.getenv("OPENAI_API_KEY")
        if not key:
            raise HTTPException(503, "PDF extraction needs a server API key. Try the sample notes.")
        pages = await run_in_threadpool(read_pages, data)
        try:
            suggestions = await run_in_threadpool(extractor, pages, key)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise HTTPException(502, "AI extraction failed. Check model access and retry.") from exc
        return await run_in_threadpool(save, source_id, name, suggestions, pages)

    @app.patch("/api/proposals/{proposal_id}")
    def review(proposal_id: int, decision: Decision):
        with closing(connect(path)) as db, db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM proposals WHERE id = ?", (proposal_id,)).fetchone()
            if not row:
                raise HTTPException(404, "Proposal not found.")
            if row["status"] == decision.status:
                return {"status": decision.status}
            if row["status"] != "pending":
                raise HTTPException(409, "This proposal has already been reviewed.")
            if decision.status == "approved" and row["target"]:
                count = db.execute(
                    """SELECT COUNT(DISTINCT title_key) FROM proposals WHERE status = 'approved'
                       AND target_key = '' AND title_key IN (?, ?)""",
                    (row["title_key"], row["target_key"]),
                ).fetchone()[0]
                if count != 2:
                    raise HTTPException(409, "Approve both concepts before approving this link.")
            if decision.status == "rejected" and not db.execute(
                """SELECT 1 FROM proposals WHERE status = 'approved'
                   AND title_key = ? AND target_key = ? AND relation_key = ?""",
                (row["title_key"], row["target_key"], row["relation_key"]),
            ).fetchone():
                db.execute(
                    """UPDATE proposals SET status = 'rejected' WHERE status = 'pending'
                       AND title_key = ? AND target_key = ? AND relation_key = ?""",
                    (row["title_key"], row["target_key"], row["relation_key"]),
                )
            else:
                db.execute("UPDATE proposals SET status = ? WHERE id = ?", (decision.status, proposal_id))
        return {"status": decision.status}

    web = Path(__file__).resolve().parents[1] / "web" / "dist"
    if web.is_dir():
        app.mount("/", StaticFiles(directory=web, html=True), name="web")
    return app


def read_pages(data):
    try:
        if not data.startswith(b"%PDF-"):
            raise ValueError("Missing PDF header")
        pdf = PdfReader(io.BytesIO(data))
        if pdf.is_encrypted or len(pdf.pages) > MAX_PAGES:
            raise ValueError("Encrypted or oversized PDF")
        pages = [normalize(page.extract_text() or "") for page in pdf.pages]
    except Exception as exc:
        raise HTTPException(422, "Choose an unencrypted, readable PDF of up to 30 pages.") from exc
    if not any(pages) or sum(map(len, pages)) > MAX_TEXT:
        raise HTTPException(422, "Choose a text PDF with up to 60,000 characters. Scans need OCR first.")
    return pages
