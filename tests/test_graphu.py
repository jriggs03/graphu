import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.extraction import Candidate, Extraction
from backend.main import create_app


def lecture_pdf(text):
    """Generate one page of selectable text for the upload integration test."""
    stream = f"BT /F1 12 Tf 30 100 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    pdf = b"%PDF-1.4\n"
    offsets = []
    for index, body in enumerate(objects, 1):
        offsets.append(len(pdf))
        pdf += f"{index} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(pdf)
    pdf += b"xref\n0 6\n0000000000 65535 f \n"
    pdf += b"".join(f"{offset:010} 00000 n \n".encode() for offset in offsets)
    return pdf + f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()


class GraphuTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.db = Path(directory.name) / "state.sqlite3"
        self.client = TestClient(create_app(self.db))
        self.addCleanup(self.client.close)

    def state(self):
        return self.client.get("/api/state").json()

    def review(self, proposal, status):
        return self.client.patch(f"/api/proposals/{proposal['id']}", json={"status": status})

    def test_demo_review_and_persistence(self):
        self.assertEqual(self.client.post("/api/demo").json()["count"], 4)
        self.assertEqual(self.state()["nodes"], [])
        proposals = {p["title"]: p for p in self.state()["pending"] if not p["target"]}
        link = next(p for p in self.state()["pending"] if p["target"])
        self.assertEqual(self.review(link, "approved").status_code, 409)
        for title in ("Hash table", "Chaining"):
            self.assertEqual(self.review(proposals[title], "approved").status_code, 200)
        self.assertEqual(self.review(proposals["Hash function"], "rejected").status_code, 200)
        self.assertEqual(self.review(link, "approved").status_code, 200)
        self.assertEqual(self.review(link, "approved").status_code, 200)
        self.assertEqual(self.client.post("/api/demo").json()["duplicate"], True)
        with TestClient(create_app(self.db)) as reopened:
            state = reopened.get("/api/state").json()
        self.assertEqual(len(state["nodes"]), 2)
        self.assertEqual(state["pending"], [])
        self.assertEqual(state["edges"][0]["evidence"][0]["page"], 1)
        self.assertIn("collisions", state["edges"][0]["evidence"][0]["quote"])

    @patch.dict(os.environ, {"OPENAI_API_KEY": "test-only"})
    def test_pdf_provenance_duplicate_and_rejection(self):
        calls = []
        text = "A cache keeps frequently used data close."

        def fake_extract(pages, key):
            calls.append(pages)
            return Extraction(items=[
                Candidate(title="Cache", target="", relation="", page=1, quote=text),
                Candidate(title="Wrong page", target="", relation="", page=2, quote=text),
                Candidate(title="Invented", target="", relation="", page=1, quote="An invented quotation."),
            ])

        with TestClient(create_app(self.db, fake_extract)) as client:
            options = {"headers": {"Content-Type": "application/pdf"}}
            document = lecture_pdf(text)
            first = client.post("/api/documents?name=Lecture.pdf", content=document, **options)
            self.assertEqual(first.json(), {"duplicate": False, "count": 1})
            duplicate = client.post("/api/documents?name=Rename.pdf", content=document, **options)
            self.assertTrue(duplicate.json()["duplicate"])
            self.assertEqual(calls, [[text]])
            pending = self.state()["pending"]
            self.assertEqual(pending[0]["evidence"]["source"], "Lecture.pdf")
            self.assertEqual(self.review(pending[0], "rejected").status_code, 200)
            second = client.post(
                "/api/documents?name=Lecture2.pdf", content=lecture_pdf(text + " Another page note."), **options
            )
            self.assertEqual(second.json(), {"duplicate": False, "count": 0})
            invalid = client.post("/api/documents?name=Bad.pdf", content=b"not a pdf", **options)
            self.assertEqual(invalid.status_code, 422)
        self.assertEqual(self.state()["pending"], [])

    def test_built_pwa_is_served(self):
        if not Path("web/dist/index.html").is_file():
            self.skipTest("Build the frontend to test PWA routes.")
        self.assertIn("Graphu", self.client.get("/").text)
        manifest = self.client.get("/manifest.webmanifest").json()
        self.assertEqual(manifest["display"], "standalone")
        for icon in manifest["icons"]:
            self.assertEqual(self.client.get(icon["src"]).headers["content-type"], "image/png")
        self.assertEqual(self.client.get("/sw.js").status_code, 200)
