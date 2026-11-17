//! Graph maths over a notebook: node sizes, the "need to know" path, and search.
//! The web UI does the same sums in the browser (`web/src/graph/model.ts`); these are here
//! for the callers that have no browser, such as the planned MCP server.
//!
//! A pair `(from, to)` means "`from` relies on `to`".

use std::collections::{HashMap, HashSet};

use crate::model::{Notebook, Status};

pub type Pair = (String, String);

/// The approved concepts and links of a notebook: the graph proper.
pub fn approved(notebook: &Notebook) -> (Vec<String>, Vec<Pair>) {
    let ids = notebook.concepts.iter().filter(|concept| concept.status == Status::Approved)
        .map(|concept| concept.id.clone()).collect();
    let pairs = notebook.edges.iter().filter(|edge| edge.status == Status::Approved)
        .map(|edge| (edge.from.clone(), edge.to.clone())).collect();
    (ids, pairs)
}

/// Approved learning dependencies, with approved endpoints and unique pairs.
pub fn prerequisites(notebook: &Notebook) -> (Vec<String>, Vec<Pair>) {
    let (ids, _) = approved(notebook);
    let allowed: HashSet<&String> = ids.iter().collect();
    let mut seen = HashSet::new();
    let pairs = notebook.edges.iter()
        .filter(|edge| edge.status == Status::Approved
            && crate::relations::is_requirement(&edge.relation)
            && allowed.contains(&edge.from) && allowed.contains(&edge.to))
        .map(|edge| (edge.from.clone(), edge.to.clone()))
        .filter(|pair| seen.insert(pair.clone())).collect();
    (ids, pairs)
}

/// PageRank on dependent → prerequisite links: what many concepts rely on scores high.
pub fn pagerank(ids: &[String], pairs: &[Pair]) -> HashMap<String, f64> {
    const DAMPING: f64 = 0.85;
    let n = ids.len() as f64;
    let mut out: HashMap<&str, Vec<&str>> = ids.iter().map(|id| (id.as_str(), Vec::new())).collect();
    let mut inc = out.clone();
    for (from, to) in pairs {
        if out.contains_key(from.as_str()) && inc.contains_key(to.as_str()) {
            out.get_mut(from.as_str()).unwrap().push(to);
            inc.get_mut(to.as_str()).unwrap().push(from);
        }
    }
    let mut rank: HashMap<&str, f64> = ids.iter().map(|id| (id.as_str(), 1.0 / n)).collect();
    for _ in 0..100 {
        let dangling: f64 = ids.iter().filter(|id| out[id.as_str()].is_empty()).map(|id| rank[id.as_str()]).sum();
        rank = ids.iter().map(|id| {
            let flow: f64 = inc[id.as_str()].iter().map(|other| rank[other] / out[other].len() as f64).sum();
            (id.as_str(), (1.0 - DAMPING) / n + DAMPING * dangling / n + DAMPING * flow)
        }).collect();
    }
    rank.into_iter().map(|(id, value)| (id.to_string(), value)).collect()
}

/// Three size tiers (1 small, 3 large), as in the approved prototype.
pub fn tiers(ids: &[String], pairs: &[Pair]) -> HashMap<String, u8> {
    let rank = pagerank(ids, pairs);
    let max = rank.values().cloned().fold(0.0, f64::max);
    rank.into_iter().map(|(id, value)| {
        let share = if max > 0.0 { value / max } else { 0.0 };
        (id, if share >= 0.6 { 3 } else if share >= 0.25 { 2 } else { 1 })
    }).collect()
}

/// Need(t): every concept reachable from `target` along relies-on links, plus `target` itself.
pub fn need(target: &str, pairs: &[Pair]) -> HashSet<String> {
    let mut seen = HashSet::from([target.to_string()]);
    let mut queue = vec![target.to_string()];
    while let Some(current) = queue.pop() {
        for (from, to) in pairs {
            if *from == current && seen.insert(to.clone()) {
                queue.push(to.clone());
            }
        }
    }
    seen
}

/// A learning order for Need(t): prerequisites always come before what relies on them.
pub fn route(notebook: &Notebook, target: &str) -> Vec<String> {
    let (ids, pairs) = prerequisites(notebook);
    if !ids.iter().any(|id| id == target) { return Vec::new(); }
    let needed = need(target, &pairs);
    let inside: Vec<&Pair> = pairs.iter().filter(|(from, to)| needed.contains(from) && needed.contains(to)).collect();
    fn depth(id: &str, inside: &[&Pair], memo: &mut HashMap<String, usize>, visiting: &mut HashSet<String>) -> usize {
        if let Some(&value) = memo.get(id) {
            return value;
        }
        if !visiting.insert(id.to_string()) {
            return 0; // a cycle: stop here
        }
        let value = inside.iter().filter(|(from, _)| from == id)
            .map(|(_, to)| depth(to, inside, memo, visiting) + 1).max().unwrap_or(0);
        visiting.remove(id);
        memo.insert(id.to_string(), value);
        value
    }
    let mut memo = HashMap::new();
    let label = |id: &str| notebook.concepts.iter().find(|concept| concept.id == id)
        .map(|concept| concept.label.clone()).unwrap_or_default();
    let mut order: Vec<(usize, String, String)> = needed.iter()
        .map(|id| (depth(id, &inside, &mut memo, &mut HashSet::new()), label(id), id.clone())).collect();
    order.sort();
    order.into_iter().map(|(_, _, id)| id).collect()
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Match {
    pub id: String,
    /// Where the query was found: `name`, `quote`, `note` or `slide`.
    pub found_in: &'static str,
}

/// Search concept names, quotes, the student's comments, and the text of cited slides.
pub fn search(notebook: &Notebook, query: &str) -> Vec<Match> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Vec::new();
    }
    let has = |text: &str| text.to_lowercase().contains(&query);
    let mut matches = Vec::new();
    for concept in &notebook.concepts {
        let on_slide = || concept.evidence.iter().any(|item| {
            notebook.sources.iter().find(|source| source.id == item.source_id)
                .and_then(|source| source.pages.get((item.page as usize).checked_sub(1)?)).is_some_and(|page| has(page))
        });
        let found_in = if has(&concept.label) || has(&concept.symbol) {
            "name"
        } else if concept.evidence.iter().any(|item| has(&item.quote)) {
            "quote"
        } else if has(&concept.comment) {
            "note"
        } else if on_slide() {
            "slide"
        } else {
            continue;
        };
        matches.push(Match { id: concept.id.clone(), found_in });
    }
    matches
}
