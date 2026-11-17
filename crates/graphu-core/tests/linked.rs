use graphu_core::{Candidate, Graphu, LinkedCandidate, NewDocument, Status};

const A: &str = "Optimization minimizes the loss by stepping against the gradient.";
const B: &str = "The gradient is the vector of partial derivatives.";
fn setup(g: &mut Graphu) -> (String, String, String, LinkedCandidate) {
    let id = g.create_notebook("Scattered notes").unwrap().id;
    let mut batches = Vec::new();
    for (source, title, quote) in [("a", "Optimization", A), ("b", "Gradient", B)] {
        let result = g.add_document(&id, NewDocument {
            source_id: source.into(), name: format!("{source}.txt"), pages: vec![quote.into()],
            items: vec![Candidate { title: title.into(), target: "".into(), relation: "".into(), page: 1, quote: quote.into(), symbol: None, heading: None, snippet: None, topic: None }],
            extracted: true, ..NewDocument::default()
        }).unwrap();
        batches.push(result.batch_id.unwrap());
    }
    (id, batches[0].clone(), batches[1].clone(), LinkedCandidate {
        title: "Optimization".into(), target: "Gradient".into(), relation: "relies on".into(),
        source_a: "a".into(), page_a: 1, quote_a: A.into(), source_b: "b".into(), page_b: 1, quote_b: B.into(),
    })
}

#[test]
fn keeps_two_quotes_and_requires_both_concepts_before_approval() {
    let mut g = Graphu::in_memory().unwrap();
    let (id, a, b, link) = setup(&mut g);
    assert_eq!(g.add_linked(&id, &b, &[link.clone()]).unwrap(), 1);
    let n = g.get_notebook(&id).unwrap();
    let c = n.claims.iter().find(|c| c.evidence_kind == "linked").unwrap();
    assert_eq!(c.evidence.len(), 2);
    assert_eq!(c.evidence[0].source, "a.txt");
    assert_eq!(c.evidence[1].source, "b.txt");
    assert!(!c.ready);
    assert!(g.review_claim(&id, c.id, Status::Approved).is_err());
    g.review_batch(&id, &a, Status::Approved).unwrap();
    let n = g.review_batch(&id, &b, Status::Approved).unwrap();
    assert_eq!(n.edges[0].status, Status::Approved);
    assert_eq!(n.edges[0].evidence_kind, "linked");
    assert!(!n.edges[0].user_added);
    assert_eq!(g.add_linked(&id, &b, &[link]).unwrap(), 0);
}

#[test]
fn rejects_bad_sources_pages_quotes_unknown_endpoints_and_missing_names() {
    for case in 0..8 {
        let mut g = Graphu::in_memory().unwrap();
        let (id, _, batch, mut link) = setup(&mut g);
        match case {
            0 => link.quote_a = "An invented passage mentioning gradient.".into(),
            1 => link.quote_b = "This was never written in the notes.".into(),
            2 => link.page_a = 2,
            3 => link.source_b = "another-notebook".into(),
            4 => link.page_b = 0,
            5 => link.target = "Unknown concept".into(),
            6 => link.quote_a = "Optimization minimizes the loss".into(),
            _ => link.target = link.title.clone(),
        }
        assert_eq!(g.add_linked(&id, &batch, &[link]).unwrap(), 0, "case {case}");
    }
}

#[test]
fn normalizes_whitespace_case_and_does_not_match_inside_words() {
    let mut g = Graphu::in_memory().unwrap();
    let (id, _, batch, mut link) = setup(&mut g);
    link.target = "GRADIENT".into();
    link.quote_a = A.replace(' ', "\n  ");
    assert_eq!(g.add_linked(&id, &batch, &[link.clone()]).unwrap(), 1);
    g.add_concept(&id, "rad").unwrap();
    link.target = "rad".into();
    assert_eq!(g.add_linked(&id, &batch, &[link]).unwrap(), 0);
}

#[test]
fn rejected_pair_stays_rejected_even_if_ai_rephrases_relation() {
    let mut g = Graphu::in_memory().unwrap();
    let (id, _, batch, mut link) = setup(&mut g);
    g.add_linked(&id, &batch, &[link.clone()]).unwrap();
    let n = g.get_notebook(&id).unwrap();
    let claim = n.claims.iter().find(|c| c.evidence_kind == "linked").unwrap().id;
    g.review_claim(&id, claim, Status::Rejected).unwrap();
    link.relation = "depends on".into();
    assert_eq!(g.add_linked(&id, &batch, &[link]).unwrap(), 0);
    assert!(g.get_notebook(&id).unwrap().edges.is_empty());
}

#[test]
fn undo_either_source_hides_link_and_restore_brings_it_back() {
    let mut g = Graphu::in_memory().unwrap();
    let (id, a, b, link) = setup(&mut g);
    g.add_linked(&id, &b, &[link.clone()]).unwrap();
    g.review_batch(&id, &a, Status::Approved).unwrap();
    g.review_batch(&id, &b, Status::Approved).unwrap();
    for batch in [&a, &b] {
        assert!(g.set_batch_undone(&id, batch, true).unwrap().edges.is_empty());
        assert_eq!(g.add_linked(&id, &b, &[link.clone()]).unwrap(), 0);
        assert_eq!(g.set_batch_undone(&id, batch, false).unwrap().edges.len(), 1);
    }
}

#[test]
fn paired_evidence_survives_reopen_and_notebook_delete_cleans_it_up() {
    let path = std::env::temp_dir().join(format!("graphu-linked-{}.sqlite3", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let id;
    {
        let mut g = Graphu::open(&path).unwrap();
        let (n, _, batch, link) = setup(&mut g);
        id = n;
        g.add_linked(&id, &batch, &[link]).unwrap();
    }
    {
        let mut g = Graphu::open(&path).unwrap();
        assert_eq!(g.get_notebook(&id).unwrap().edges[0].evidence.len(), 2);
        g.delete_notebook(&id).unwrap();
        let (id, _, batch, link) = setup(&mut g);
        assert_eq!(g.add_linked(&id, &batch, &[link]).unwrap(), 1);
    }
    std::fs::remove_file(path).unwrap();
}
