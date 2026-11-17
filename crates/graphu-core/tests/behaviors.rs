//! The behaviors Graphu must keep (CLAUDE.md, "Behaviors that must hold").
//! The first two tests are ports of `tests/test_graphu.py`. The third Python test
//! ("built PWA is served") belongs to the server and is ported with it in step 3.

use graphu_core::graph;
use graphu_core::{sha256_hex, Candidate, ClaimKind, Error, Graphu, NewDocument, Notebook, Status};

fn concept(title: &str, page: i64, quote: &str) -> Candidate {
    Candidate { title: title.into(), target: String::new(), relation: String::new(), page, quote: quote.into(), symbol: None, heading: None, snippet: None, topic: None }
}

fn link(title: &str, target: &str, relation: &str, page: i64, quote: &str) -> Candidate {
    Candidate { title: title.into(), target: target.into(), relation: relation.into(), page, quote: quote.into(), symbol: None, heading: None, snippet: None, topic: None }
}

fn document(name: &str, text: &str, items: Vec<Candidate>) -> NewDocument {
    NewDocument {
        source_id: sha256_hex(text.as_bytes()), name: name.into(), context: "test".into(),
        pages: vec![text.into()], items, extracted: true, note: String::new(),
    }
}

fn approved(notebook: &Notebook) -> Vec<&str> {
    notebook.concepts.iter().filter(|c| c.status == Status::Approved).map(|c| c.label.as_str()).collect()
}

fn pending(notebook: &Notebook) -> usize {
    notebook.claims.iter().filter(|c| c.status == Status::Pending).count()
}

fn claim(notebook: &Notebook, title: &str, kind: ClaimKind) -> i64 {
    notebook.claims.iter().find(|c| c.title == title && c.kind == kind).unwrap().id
}

const HASH: &str = "sample-hash-tables";
const CALC: &str = "sample-calculus";

/// Port of `test_demo_review_and_persistence`.
#[test]
fn sample_review_and_persistence() {
    let directory = std::env::temp_dir().join(format!("graphu-test-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("state.sqlite3");
    let _ = std::fs::remove_file(&path);
    {
        let mut graphu = Graphu::open(&path).unwrap();
        graphu.ensure_samples().unwrap();
        let notebook = graphu.get_notebook(HASH).unwrap();
        assert_eq!(pending(&notebook), 4);
        assert!(approved(&notebook).is_empty(), "nothing is in the graph before review");

        // A link cannot be approved before both of its concepts.
        let link = claim(&notebook, "Chaining", ClaimKind::Edge);
        let refused = graphu.review_claim(HASH, link, Status::Approved).unwrap_err();
        assert_eq!(refused.status(), 409);

        for title in ["Hash table", "Chaining"] {
            graphu.review_claim(HASH, claim(&notebook, title, ClaimKind::Concept), Status::Approved).unwrap();
        }
        graphu.review_claim(HASH, claim(&notebook, "Hash function", ClaimKind::Concept), Status::Rejected).unwrap();
        graphu.review_claim(HASH, link, Status::Approved).unwrap();
        graphu.review_claim(HASH, link, Status::Approved).unwrap(); // approving twice is harmless

        // Seeding again changes nothing: the sample is not duplicated.
        graphu.ensure_samples().unwrap();
    }
    let reopened = Graphu::open(&path).unwrap();
    let notebook = reopened.get_notebook(HASH).unwrap();
    assert_eq!(approved(&notebook), ["Hash table", "Chaining"]);
    assert_eq!(pending(&notebook), 0);
    let edge = &notebook.edges[0];
    assert_eq!(edge.status, Status::Approved);
    assert_eq!(edge.evidence[0].page, 1);
    assert!(edge.evidence[0].quote.contains("collisions"));
    assert_eq!(edge.evidence[0].source, "Hash tables · sample notes");
    std::fs::remove_dir_all(&directory).unwrap();
}

/// Port of `test_pdf_provenance_duplicate_and_rejection`.
#[test]
fn provenance_duplicate_and_rejection() {
    let mut graphu = Graphu::in_memory().unwrap();
    let id = graphu.create_notebook("Systems").unwrap().id;
    let text = "A cache keeps frequently used data close.";
    let proposals = || vec![
        concept("Cache", 1, text),
        concept("Wrong page", 2, text),
        concept("Invented", 1, "An invented quotation."),
    ];

    let first = graphu.add_document(&id, document("Lecture.pdf", text, proposals())).unwrap();
    assert_eq!((first.duplicate, first.count, first.dropped), (false, 1, 2));

    // Same bytes under another name: blocked by the content hash.
    assert!(graphu.has_source(&id, &sha256_hex(text.as_bytes())).unwrap());
    let again = graphu.add_document(&id, document("Rename.pdf", text, proposals())).unwrap();
    assert!(again.duplicate);

    let notebook = graphu.get_notebook(&id).unwrap();
    let cache = notebook.claims.iter().find(|c| c.status == Status::Pending).unwrap();
    assert_eq!((cache.source.as_str(), cache.page, cache.quote.as_str()), ("Lecture.pdf", 1, text));
    graphu.review_claim(&id, cache.id, Status::Rejected).unwrap();

    // A different file that proposes the rejected claim again: it is not re-proposed.
    let longer = format!("{text} Another page note.");
    let second = graphu.add_document(&id, document("Lecture2.pdf", &longer, vec![concept("Cache", 1, text)])).unwrap();
    assert_eq!((second.duplicate, second.count), (false, 0));
    assert_eq!(pending(&graphu.get_notebook(&id).unwrap()), 0);
}

#[test]
fn sample_drops_the_ungrounded_proposal_and_marks_unsourced_concepts() {
    let mut graphu = Graphu::in_memory().unwrap();
    graphu.ensure_samples().unwrap();
    let notebook = graphu.get_notebook(CALC).unwrap();
    assert_eq!(approved(&notebook).len(), 10);
    assert_eq!(pending(&notebook), 11);
    assert!(!notebook.claims.iter().any(|c| c.title.contains("Stokes")), "its quote is not on the cited page");
    let week9 = notebook.batches.iter().find(|b| b.name.starts_with("Week 9")).unwrap();
    assert_eq!(week9.dropped, 1);
    let unsourced: Vec<&str> = notebook.concepts.iter().filter(|c| c.user_added).map(|c| c.label.as_str()).collect();
    assert_eq!(unsourced, ["Limits"], "the “Not in slide !” marker");
    let limits = notebook.concepts.iter().find(|c| c.id == "limits").unwrap();
    assert!(limits.comment.contains("Calc I"));
    let summary = graphu.list_notebooks().unwrap().into_iter().find(|n| n.id == CALC).unwrap();
    assert_eq!((summary.concepts, summary.pending), (10, 11));
}

#[test]
fn batches_merge_evidence_and_undo_per_item_and_per_batch() {
    let mut graphu = Graphu::in_memory().unwrap();
    graphu.ensure_samples().unwrap();
    let notebook = graphu.get_notebook(CALC).unwrap();
    let week9 = notebook.batches.iter().find(|b| b.name.starts_with("Week 9")).unwrap().id.clone();

    // The extra quote for an existing concept is proposed as a merge, not applied.
    let merge = notebook.claims.iter().find(|c| c.merge).unwrap();
    assert_eq!(merge.title, "Double integrals");
    let double = |n: &Notebook| n.concepts.iter().find(|c| c.id == "double integrals").unwrap().evidence.iter()
        .filter(|e| e.status == Status::Approved).count();
    assert_eq!(double(&notebook), 1);

    let notebook = graphu.review_batch(CALC, &week9, Status::Approved).unwrap();
    assert_eq!((approved(&notebook).len(), pending(&notebook)), (14, 0));
    assert_eq!(notebook.edges.iter().filter(|e| e.status == Status::Approved).count(), 17);
    assert_eq!(double(&notebook), 2);

    // Undo one item: the concept and the links that depend on it leave the graph.
    let vector_fields = claim(&notebook, "Vector fields", ClaimKind::Concept);
    let notebook = graphu.review_claim(CALC, vector_fields, Status::Pending).unwrap();
    assert_eq!(approved(&notebook).len(), 13);
    assert_eq!(notebook.edges.iter().filter(|e| e.status == Status::Approved).count(), 15);

    // Undo the whole batch, then restore it. Nothing is lost.
    let notebook = graphu.set_batch_undone(CALC, &week9, true).unwrap();
    assert_eq!((notebook.concepts.len(), notebook.sources.len()), (10, 2));
    let refused = graphu.review_claim(CALC, vector_fields, Status::Approved).unwrap_err();
    assert!(matches!(refused, Error::Conflict(_)));
    let notebook = graphu.set_batch_undone(CALC, &week9, false).unwrap();
    assert_eq!((notebook.concepts.len(), approved(&notebook).len()), (14, 13));
}

#[test]
fn sample_pack_adds_a_new_batch_once() {
    let mut graphu = Graphu::in_memory().unwrap();
    graphu.ensure_samples().unwrap();
    let packs = graphu.list_sample_packs(CALC).unwrap();
    assert_eq!(packs.len(), 1);
    let added = graphu.add_sample_pack(CALC, &packs[0].id).unwrap();
    assert_eq!((added.duplicate, added.count, added.dropped), (false, 8, 0));
    assert!(graphu.list_sample_packs(CALC).unwrap().is_empty());
    assert!(graphu.add_sample_pack(CALC, &packs[0].id).unwrap().duplicate);
}

#[test]
fn student_additions_have_no_source() {
    let mut graphu = Graphu::in_memory().unwrap();
    graphu.ensure_samples().unwrap();
    let notebook = graphu.add_concept(CALC, "  Continuity ").unwrap();
    let added = notebook.concepts.iter().find(|c| c.id == "continuity").unwrap();
    assert!(added.user_added && added.status == Status::Approved && added.evidence.is_empty());
    assert_eq!(graphu.add_concept(CALC, "continuity").unwrap_err().status(), 409);

    let notebook = graphu.add_edge(CALC, "limits", "continuity").unwrap();
    let edge = notebook.edges.iter().find(|e| e.id == "limits->continuity").unwrap();
    assert!(edge.user_added && edge.status == Status::Approved);
    assert_eq!(graphu.add_edge(CALC, "limits", "continuity").unwrap_err().status(), 409);
    assert_eq!(graphu.add_edge(CALC, "limits", "limits").unwrap_err().status(), 422);

    let notebook = graphu.set_comment(CALC, "continuity", "ask about this").unwrap();
    assert_eq!(notebook.concepts.iter().find(|c| c.id == "continuity").unwrap().comment, "ask about this");
}

#[test]
fn graph_queries() {
    let mut graphu = Graphu::in_memory().unwrap();
    graphu.ensure_samples().unwrap();
    let notebook = graphu.get_notebook(CALC).unwrap();
    let (ids, pairs) = graph::approved(&notebook);

    // What the most concepts rely on is drawn largest.
    let tiers = graph::tiers(&ids, &pairs);
    assert_eq!(tiers["limits"], 3);
    assert_eq!(tiers["optimization"], 1);
    let total: f64 = graph::pagerank(&ids, &pairs).values().sum();
    assert!((total - 1.0).abs() < 1e-9);

    // Need(t): everything reachable along relies-on links.
    let mut needed: Vec<String> = graph::need("double integrals", &pairs).into_iter().collect();
    needed.sort();
    assert_eq!(needed, ["derivatives", "double integrals", "integrals", "limits", "riemann sums"]);

    // The route lists prerequisites before what relies on them.
    let route = graph::route(&notebook, "double integrals");
    assert_eq!(route, ["limits", "riemann sums", "derivatives", "integrals", "double integrals"]);

    let notebook = graphu.set_target(CALC, Some("double integrals")).unwrap();
    assert_eq!(notebook.target.as_deref(), Some("double integrals"));
    assert_eq!(graphu.set_target(CALC, Some("green's theorem")).unwrap_err().status(), 422, "not approved yet");

    // Search covers names, quotes, the student's notes, and the text of cited slides.
    let found = |query: &str| graph::search(&notebook, query).into_iter().map(|m| (m.id, m.found_in)).collect::<Vec<_>>();
    assert_eq!(found("gradient"), [("gradient".to_string(), "name")]);
    // Riemann sums quotes these words; Integrals cites the same slide, so it matches too.
    assert_eq!(found("thin rectangles"), [("riemann sums".to_string(), "quote"), ("integrals".to_string(), "slide")]);
    assert_eq!(found("midterm"), [("limits".to_string(), "note")]);
    assert_eq!(found("steepest"), [("gradient".to_string(), "slide")]);
    assert!(found("zebra").is_empty());
}

#[test]
fn a_link_from_one_upload_can_wait_for_a_concept_from_another() {
    let mut graphu = Graphu::in_memory().unwrap();
    let id = graphu.create_notebook("  Data   structures ").unwrap().id;
    let text = "A heap is a tree. A priority queue is usually built on a heap.";
    let items = vec![
        concept("Heap", 1, "A heap is a tree."),
        concept("Priority queue", 1, "A priority queue is usually built on a heap."),
        link("Priority queue", "Heap", "is built on", 1, "A priority queue is usually built on a heap."),
        link("Heap", "Heap", "is", 1, "A heap is a tree."), // points at itself: dropped
    ];
    let added = graphu.add_document(&id, document("C:\\notes\\heaps.pdf", text, items)).unwrap();
    assert_eq!((added.name.as_str(), added.count, added.dropped), ("heaps.pdf", 3, 1));

    let notebook = graphu.get_notebook(&id).unwrap();
    assert_eq!(notebook.title, "Data structures");
    let batch = notebook.batches[0].id.clone();
    let notebook = graphu.review_batch(&id, &batch, Status::Approved).unwrap();
    let edge = &notebook.edges[0];
    assert_eq!((edge.from.as_str(), edge.to.as_str(), edge.relation.as_str(), edge.status), ("priority queue", "heap", "is built on", Status::Approved));
    assert_eq!(graphu.get_notebook("nope").unwrap_err().status(), 404);
}

#[test]
fn refuses_a_database_from_the_python_backend() {
    let path = std::env::temp_dir().join(format!("graphu-python-{}.sqlite3", std::process::id()));
    let _ = std::fs::remove_file(&path);
    rusqlite::Connection::open(&path).unwrap()
        .execute_batch("CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT); CREATE TABLE proposals (id INTEGER PRIMARY KEY);").unwrap();
    let refused = Graphu::open(&path).err().expect("the old layout is not opened");
    assert_eq!(refused.status(), 422);
    // Nothing was added to the old file.
    let tables: i64 = rusqlite::Connection::open(&path).unwrap()
        .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'", [], |row| row.get(0)).unwrap();
    assert_eq!(tables, 2);
    std::fs::remove_file(&path).unwrap();
}

#[test]
fn a_concept_can_carry_a_safe_picture() {
    let mut graphu = Graphu::in_memory().unwrap();
    graphu.ensure_samples().unwrap();
    let picture = "<svg viewBox=\"0 0 320 180\" xmlns=\"http://www.w3.org/2000/svg\"><circle cx=\"40\" cy=\"40\" r=\"20\"/><text x=\"10\" y=\"90\">position on the curve</text></svg>";
    let notebook = graphu.set_visual(CALC, "integrals", picture, "  Area under   a curve ").unwrap();
    let visual = notebook.concepts.iter().find(|c| c.id == "integrals").unwrap().visual.clone().unwrap();
    assert_eq!((visual.svg.as_str(), visual.caption.as_str()), (picture, "Area under a curve"));
    assert!(notebook.concepts.iter().find(|c| c.id == "limits").unwrap().visual.is_none());

    // Anything that could run code or reach outside is refused.
    for bad in [
        "<svg><script>alert(1)</script></svg>",
        "<svg onload=\"alert(1)\"></svg>",
        "<svg><a href=\"javascript:alert(1)\">x</a></svg>",
        "<svg><image href=\"https://example.com/x.png\"/></svg>",
        "<svg><foreignObject><div/></foreignObject></svg>",
        "<p>not a picture</p>",
    ] {
        assert_eq!(graphu.set_visual(CALC, "integrals", bad, "").unwrap_err().status(), 422, "{bad}");
    }
    assert_eq!(graphu.set_visual(CALC, "no such concept", picture, "").unwrap_err().status(), 404);
}

#[test]
fn a_graphbook_can_be_renamed_and_deleted() {
    let mut graphu = Graphu::in_memory().unwrap();
    graphu.ensure_samples().unwrap();
    let id = graphu.create_notebook("structures in c").unwrap().id;
    let text = "A struct groups named fields into one value.";
    graphu.add_document(&id, document("structs.txt", text, vec![concept("Structs", 1, text)])).unwrap();

    assert_eq!(graphu.rename_notebook(&id, "  Structures   in C ").unwrap().title, "Structures in C");
    assert_eq!(graphu.rename_notebook(&id, "   ").unwrap_err().status(), 422);

    graphu.delete_notebook(&id).unwrap();
    assert_eq!(graphu.get_notebook(&id).unwrap_err().status(), 404);
    assert_eq!(graphu.delete_notebook(&id).unwrap_err().status(), 404);
    assert_eq!(graphu.list_notebooks().unwrap().len(), 2, "only the samples remain");
    // The same file can be added again to a new graphbook, and its id does not clash.
    let again = graphu.create_notebook("Again").unwrap().id;
    assert!(!graphu.add_document(&again, document("structs.txt", text, vec![concept("Structs", 1, text)])).unwrap().duplicate);

    assert_eq!(graphu.delete_notebook(CALC).unwrap_err().status(), 409, "samples stay");
}

#[test]
fn the_student_can_choose_a_concepts_symbol() {
    let mut graphu = Graphu::in_memory().unwrap();
    graphu.ensure_samples().unwrap();
    let symbol = |n: &Notebook| n.concepts.iter().find(|c| c.id == "gradient").unwrap().symbol.clone();
    assert_eq!(symbol(&graphu.get_notebook(CALC).unwrap()), "∇f");
    assert_eq!(symbol(&graphu.set_symbol(CALC, "gradient", "  grad ").unwrap()), "grad");
    assert_eq!(symbol(&graphu.set_symbol(CALC, "gradient", "").unwrap()), "∇f", "empty goes back to the proposed symbol");
    assert_eq!(graphu.set_symbol(CALC, "gradient", "far too long a symbol").unwrap_err().status(), 422);
    assert_eq!(graphu.set_symbol(CALC, "nope", "x").unwrap_err().status(), 404);
}

/// A snippet (a formula or line of code) is checked against the page exactly like a quote.
#[test]
fn a_snippet_is_kept_only_if_it_is_on_the_cited_page() {
    let mut graphu = Graphu::in_memory().unwrap();
    let id = graphu.create_notebook("Autoencoders").unwrap().id;
    let pages = vec![
        "The encoder maps the input to a code:   h = f(x). The decoder maps it back.".to_string(),
        "Reconstruction: r = g(h). Training minimizes L(x, g(f(x))).".to_string(),
    ];
    let item = |title: &str, page: i64, quote: &str, heading: &str, snippet: &str| Candidate {
        title: title.into(), target: String::new(), relation: String::new(), page, quote: quote.into(), symbol: None,
        heading: Some(heading.into()), snippet: Some(snippet.into()), topic: None,
    };
    let items = vec![
        // Copied from page 1, with different spacing: kept after whitespace normalization.
        item("Encoder", 1, "The encoder maps the input to a code", "The encoder compresses the input.", "h  =  f(x)"),
        // On page 2, but cited on page 1: dropped, like a quote on the wrong page.
        item("Decoder", 1, "The decoder maps it back.", "The decoder rebuilds the input.", "r = g(h)"),
        // A formula from memory that is on no page: dropped.
        item("Loss", 2, "Training minimizes L(x, g(f(x))).", "The loss measures the reconstruction error.", "L = ||x - r||^2"),
        // No snippet at all is fine.
        item("Reconstruction", 2, "Reconstruction: r = g(h).", "", ""),
    ];
    let added = graphu.add_document(&id, NewDocument {
        source_id: sha256_hex(b"autoencoders"), name: "slides.pdf".into(), context: String::new(),
        pages, items, extracted: true, note: String::new(),
    }).unwrap();
    // A bad snippet does not cost the concept its place: all four are proposed.
    assert_eq!((added.count, added.dropped), (4, 0));

    let notebook = graphu.get_notebook(&id).unwrap();
    let concept = |key: &str| notebook.concepts.iter().find(|c| c.id == key).unwrap();
    let encoder = concept("encoder");
    assert_eq!(encoder.heading, "The encoder compresses the input.");
    let snippet = encoder.snippet.as_ref().unwrap();
    assert_eq!((snippet.text.as_str(), snippet.page, snippet.source.as_str()), ("h = f(x)", 1, "slides.pdf"));
    assert!(concept("decoder").snippet.is_none(), "cited on the wrong page");
    assert_eq!(concept("decoder").heading, "The decoder rebuilds the input.", "the summary is kept; it is tagged as AI");
    assert!(concept("loss").snippet.is_none(), "not on any page");
    assert!(concept("reconstruction").snippet.is_none() && concept("reconstruction").heading.is_empty());
}

#[test]
fn links_carry_no_heading_or_snippet_and_long_ones_are_dropped() {
    let pages = vec!["A heap is a tree. A priority queue is built on a heap: push is O(log n).".to_string()];
    let long = "x".repeat(301);
    let items = vec![
        Candidate { heading: Some("Links have no summary.".into()), snippet: Some("O(log n)".into()),
            ..link("Priority queue", "Heap", "is built on", 1, "A priority queue is built on a heap") },
        Candidate { heading: Some("h".repeat(201)), snippet: Some(long), ..concept("Heap", 1, "A heap is a tree.") },
        Candidate { snippet: Some("O(log n)".into()), ..concept("Priority queue", 1, "A priority queue is built on a heap") },
    ];
    let kept = graphu_core::ground::grounded_items(&items, &pages);
    assert_eq!(kept.len(), 3);
    assert!(kept[0].heading.is_none() && kept[0].snippet.is_none(), "a link");
    assert!(kept[1].heading.is_none() && kept[1].snippet.is_none(), "too long");
    assert_eq!(kept[2].snippet.as_deref(), Some("O(log n)"));
}

#[test]
fn an_older_database_gains_the_new_columns() {
    let path = std::env::temp_dir().join(format!("graphu-old-{}.sqlite3", std::process::id()));
    let _ = std::fs::remove_file(&path);
    {
        let mut graphu = Graphu::open(&path).unwrap();
        graphu.ensure_samples().unwrap();
    }
    // Put the file back to how it looked before headings and snippets existed.
    rusqlite::Connection::open(&path).unwrap()
        .execute_batch("ALTER TABLE claims DROP COLUMN heading; ALTER TABLE claims DROP COLUMN snippet;").unwrap();
    let graphu = Graphu::open(&path).unwrap();
    assert_eq!(graphu.get_notebook(CALC).unwrap().concepts.len(), 14);
    std::fs::remove_file(&path).unwrap();
}

#[test]
fn the_sample_shows_headings_and_only_snippets_that_are_on_the_page() {
    let mut graphu = Graphu::in_memory().unwrap();
    graphu.ensure_samples().unwrap();
    let notebook = graphu.get_notebook(CALC).unwrap();
    let derivatives = notebook.concepts.iter().find(|c| c.id == "derivatives").unwrap();
    assert!(derivatives.heading.starts_with("The derivative measures"));
    let snippet = derivatives.snippet.as_ref().unwrap();
    assert_eq!((snippet.text.as_str(), snippet.page), ("(f(x+h) − f(x)) / h", 1));
    let with_snippet: Vec<&str> = notebook.concepts.iter().filter(|c| c.snippet.is_some()).map(|c| c.id.as_str()).collect();
    assert_eq!(with_snippet, ["derivatives", "fundamental theorem", "divergence", "green's theorem"]);
    assert!(notebook.concepts.iter().find(|c| c.id == "limits").unwrap().heading.is_empty(), "the student's own concept has no AI summary");
}

/// Topics: a concept sits inside the topic its path names, to any depth, and the student can move it.
///
///   in:  "Sine waves" with topic "Transformers > Positional encoding"
///   out: Sine waves → Positional encoding → Transformers (a concept that acts as a topic)
#[test]
fn concepts_nest_inside_topics_and_can_be_moved() {
    let mut graphu = Graphu::in_memory().unwrap();
    let id = graphu.create_notebook("Deep learning").unwrap().id;
    let pages = vec!["Transformers stack attention layers. Positions are added with sine waves of many lengths. Dropout hides units at random.".to_string()];
    let inside = |title: &str, quote: &str, topic: &str| Candidate { topic: Some(topic.into()), ..concept(title, 1, quote) };
    let items = vec![
        inside("Transformers", "Transformers stack attention layers.", "Transformers"),
        inside("Sine waves", "Positions are added with sine waves", "Transformers >  Positional encoding"),
        concept("Dropout", 1, "Dropout hides units at random."),
    ];
    graphu.add_document(&id, NewDocument { source_id: "d".into(), name: "dl.pdf".into(), pages, items, extracted: true, ..NewDocument::default() }).unwrap();
    let parent_of = |notebook: &Notebook, key: &str| notebook.concepts.iter().find(|item| item.id == key).unwrap().parent.clone();

    let notebook = graphu.get_notebook(&id).unwrap();
    assert_eq!(parent_of(&notebook, "sine waves").as_deref(), Some("positional encoding"));
    assert_eq!(parent_of(&notebook, "transformers"), None, "a concept named by its own topic is that topic");
    assert_eq!(parent_of(&notebook, "dropout"), None);
    // "Positional encoding" is not a concept from the material, so it is listed as a topic.
    assert_eq!(notebook.topics.len(), 1);
    assert_eq!((notebook.topics[0].label.as_str(), notebook.topics[0].parent.as_deref(), notebook.topics[0].status),
        ("Positional encoding", Some("transformers"), Status::Pending));
    assert_eq!(notebook.concepts.len(), 3, "topics are not counted as concepts");

    // The topic is in the graph as soon as something inside it is approved.
    let claim = notebook.claims.iter().find(|claim| claim.title == "Sine waves").unwrap().id;
    let notebook = graphu.review_claim(&id, claim, Status::Approved).unwrap();
    assert_eq!(notebook.topics[0].status, Status::Approved);

    // The student decides: move Dropout into Transformers, then take Sine waves out to the top.
    let notebook = graphu.set_parent(&id, "dropout", Some("transformers")).unwrap();
    assert_eq!(parent_of(&notebook, "dropout").as_deref(), Some("transformers"));
    let notebook = graphu.set_parent(&id, "sine waves", None).unwrap();
    assert_eq!(parent_of(&notebook, "sine waves"), None);
    assert!(notebook.topics.is_empty(), "an empty topic is not shown");
    // Nothing can be put inside itself, directly or through its own contents.
    assert!(graphu.set_parent(&id, "transformers", Some("dropout")).is_err());
    assert!(graphu.set_parent(&id, "dropout", Some("no such topic")).is_err());
}
