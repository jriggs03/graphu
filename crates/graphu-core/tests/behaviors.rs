//! The behaviors Graphu must keep (CLAUDE.md, "Behaviors that must hold").
//! The first two tests are ports of `tests/test_graphu.py`. The third Python test
//! ("built PWA is served") belongs to the server and is ported with it in step 3.

use graphu_core::graph;
use graphu_core::{sha256_hex, Candidate, ClaimKind, Error, Graphu, NewDocument, Notebook, Status};

fn concept(title: &str, page: i64, quote: &str) -> Candidate {
    Candidate { title: title.into(), target: String::new(), relation: String::new(), page, quote: quote.into(), symbol: None }
}

fn link(title: &str, target: &str, relation: &str, page: i64, quote: &str) -> Candidate {
    Candidate { title: title.into(), target: target.into(), relation: relation.into(), page, quote: quote.into(), symbol: None }
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
