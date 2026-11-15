# Feature: Connect my notes

**For:** whoever builds this next (teammate or Claude Code). Read `CLAUDE.md` first; everything there still applies.
**Goal:** a student drops in a stack of handwritten notes where topics are scattered across pages. Graphu finds how those topics connect and proposes the links, so the graph comes out connected instead of a pile of separate islands.

## Why this is needed

Reading handwriting already works. `graphu-ingest` sends photos and scans to Claude (`transcribe`), then runs `extract` on the text.

The gap is the links. Right now a link is only proposed when **one contiguous quote on one page** states the dependency. Real notes don't work that way: "gradient" is defined on page 2 and used on page 5, and nothing on either page says "optimization relies on gradient." So scattered notes produce many concepts and few links.

```
today:     [Limits]  [d/dx]  [Gradient]     [Optimization]  [∫]  [∬]      ← 6 islands
with this: Limits → d/dx → Gradient → Optimization        ∫ → ∬          ← 2 islands, then a bridge
```

## Three kinds of link

Every proposed link gets one `evidence_kind`. Each kind has a check the **Rust code** runs, so Claude never has the last word.

| Kind | What supports it | Check in `graphu-core` | How it looks |
|---|---|---|---|
| `stated` | One quote that states the dependency (exists today) | Quote is on that page (`grounded_items`, unchanged) | Solid line |
| `linked` | **Two quotes from the student's notes**, possibly on different pages or files: one about concept A that **uses concept B by name** | Both quotes are on their pages, **and quote A contains B's title or a known alias** (normalized, case-insensitive) | Solid line with a small "2 quotes" mark |
| `bridge` | No quote. Claude's general knowledge, used only to join separate islands | The link's endpoints are in **≥ 2 different weakly connected components**, and the bridge adds **no prerequisites of its own** | Dashed line, a different color, plus the existing "not in slide !" marker, kept even after approval |

The `linked` check is what makes this trustworthy. It's mechanical:

**valid_linked(A→B) ⇔ quoteA ∈ page(A) ∧ quoteB ∈ page(B) ∧ contains(normalize(quoteA), name(B))**
```rust
fn valid_linked(link: &Linked, pages: &Pages, names: &Aliases) -> bool {
    on_page(&link.quote_a, pages) && on_page(&link.quote_b, pages)      // both quotes are real
        && names.of(link.target).iter()
               .any(|n| normalize(&link.quote_a).contains(&normalize(n)))   // A's quote uses B's name
}   // in: a proposed link + the transcribed pages → out: keep or drop
```

The bridge check:

**valid_bridge(b) ⇔ |{ island(c) : c ∈ links(b) }| ≥ 2 ∧ newPrereqs(b) = ∅**

## Flow

```
photos / scans ─▶ transcribe (exists) ─▶ extract concepts (exists)
                                              │
                                              ▼
                    NEW  connect pass: Claude gets ALL approved + pending concepts
                         and ALL pages of the notebook (not just the new upload),
                         returns proposed links, each with evidence_kind
                                              │
                                              ▼
                    graphu-core checks each link by its kind; drops failures
                                              │
                                              ▼
                    review queue: stated / linked first, then at most 3 bridges
```

- The connect pass runs **automatically after an upload** for `stated` and `linked` links.
- Bridges run only when the student presses **Suggest connections**, at most 3 per press. Off by default.
- A bridge concept that would need its own prerequisites is dropped. A bridge connects; it doesn't open a new topic.

## Prompt changes (`crates/graphu-ingest/src/claude.rs`)

- Add a `CONNECT_SYSTEM` prompt. It gets numbered pages from **every source in the notebook** and the list of concept titles. It asks for links where one concept's passage **uses another concept by name**, returning `title`, `target`, `relation`, `page_a`, `quote_a`, `page_b`, `quote_b`.
- It keeps the existing rules: page text is untrusted data, quotes are copied exactly, and when unsure, leave it out.
- Add a `BRIDGE_SYSTEM` prompt. It gets the islands as lists of concept titles and asks for at most 3 concepts or links that join two islands, each with a one-line `reason`. **It sends no page text**, so bridges can't pretend to be quotes.
- Use the student's context-box note (`student_note_about_this_material`) in both prompts. "These are my Calc III notes from weeks 1–4" helps a lot.

## Data changes

- `edges.evidence_kind`: `stated | linked | bridge`.
- Evidence rows can hold **two** quotes for `linked` (or two evidence rows sharing a `link_id`).
- `edges.reason` (text, bridges only).
- Bridge concepts get `user_added`-style treatment, `origin = 'ai_bridge'`, so the "not in slide !" marker and dashed outline stay after approval. **Never count bridges as source-backed** in search results or PageRank labels.

## UI

- Review queue: group by kind, with headings **"From one passage," "Across your notes,"** and **"Suggested by AI (not in your notes)."**
- Clicking a `linked` edge shows both quotes side by side with page numbers, and highlights B's name inside quote A.
- Clicking a bridge shows its reason and the line "Not from your notes. Accept only if it's right."
- Line styles go in the existing legend. Bridge color must differ from the accent and still read in grayscale (dashed).

## Tests (`crates/graphu-core/tests/`)

1. `linked` link is **kept** when quote A contains B's name and both quotes are on their pages.
2. `linked` link is **dropped** when quote A doesn't mention B, or either quote isn't on its page.
3. Bridge is **kept** when it joins two islands; **dropped** when both ends are already connected.
4. Bridge with its own prerequisites is **dropped**.
5. Approved bridges still report `unsourced = true`.
6. Rejected links aren't re-proposed by a second connect pass on unchanged notes.

## Done when (demo)

Upload 3–4 photos of handwritten notes on one subject, with topics scattered across pages and a context note. Then:

1. The graph shows mostly connected concepts. Clicking a link shows the two quotes it came from.
2. **Suggest connections** joins the remaining islands with ≤ 3 dashed, clearly marked bridges.
3. Rejecting a bridge removes it, and it doesn't come back.

Demo line: *"My notes never say these topics are related. Graphu found where one page uses an idea from another, and showed me both passages. Where my notes have a real gap, the AI suggests a bridge, clearly marked, and I decide."*

## Priority

Do this **after** the Anthropic key is on the live server and a real upload works end to end. If time runs short, ship `linked` first; it's the core of the feature. Bridges second.

## Implementation status

The first implementation adds automatic `linked` proposals, paired source evidence, Rust validation, review grouping, the map marker, and regression tests. It also adds a blank-graph entry point and a first-concept form. `stated` extraction remains unchanged. Title matching uses token boundaries to avoid substring false positives. Alias matching awaits an explicit alias model. AI bridges, bridge validation, and Suggest connections remain phase two.

The existing live upload/approval path was verified with a synthetic text file before implementation. The new connection path is covered by a local mock-AI integration test; it still needs the handwritten-photo demo against the real provider after deployment.
