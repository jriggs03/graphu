//! Grounding: a proposal is only shown if its quote really is on the page it cites.
//! This is a line-for-line port of `grounded_items` in `backend/extraction.py`.

use crate::model::Candidate;

/// Collapse every run of whitespace to one space and trim the ends.
pub fn normalize(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The identity of a concept name: normalized and lowercased.
pub fn key_of(value: &str) -> String {
    normalize(value).to_lowercase()
}

/// Keep the candidates whose quote appears on the cited page. Everything else is dropped.
///
/// in:  proposals from the AI, plus the text of each page
/// out: the same proposals, cleaned up, minus any that fail a check
pub fn grounded_items(items: &[Candidate], pages: &[String]) -> Vec<Candidate> {
    let pages: Vec<String> = pages.iter().map(|page| normalize(page)).collect();
    let length = |value: &str| value.chars().count();
    let mut kept = Vec::new();
    for raw in items {
        let item = Candidate {
            title: normalize(&raw.title),
            target: normalize(&raw.target),
            relation: normalize(&raw.relation),
            quote: normalize(&raw.quote),
            page: raw.page,
            symbol: raw.symbol.as_deref().map(normalize).filter(|symbol| !symbol.is_empty()),
        };
        // The page must exist and the quote must be a sensible length.
        if item.page < 1 || item.page as usize > pages.len() {
            continue;
        }
        if !(12..=800).contains(&length(&item.quote)) {
            continue;
        }
        // The quote must appear on that page, word for word.
        if !pages[item.page as usize - 1].contains(&item.quote) {
            continue;
        }
        if !(1..=80).contains(&length(&item.title)) || length(&item.target) > 80 || length(&item.relation) > 60 {
            continue;
        }
        // A link needs both a target and a relation, and cannot point at itself.
        if item.target.is_empty() != item.relation.is_empty() || key_of(&item.title) == key_of(&item.target) {
            continue;
        }
        kept.push(item);
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(title: &str, target: &str, relation: &str, page: i64, quote: &str) -> Candidate {
        Candidate { title: title.into(), target: target.into(), relation: relation.into(), page, quote: quote.into(), symbol: None }
    }

    #[test]
    fn keeps_only_quotes_found_on_the_cited_page() {
        let pages = vec!["A cache keeps   frequently used\ndata close.".to_string(), "Second page text here.".to_string()];
        let quote = "A cache keeps frequently used data close.";
        let items = [
            candidate("Cache", "", "", 1, quote),
            candidate("Wrong page", "", "", 2, quote),
            candidate("No such page", "", "", 3, quote),
            candidate("Invented", "", "", 1, "An invented quotation."),
            candidate("Too short", "", "", 1, "A cache"),
            candidate("Cache", "cache", "is", 1, quote),
            candidate("Half a link", "Data", "", 1, quote),
            candidate("  Spaced   out ", "", "", 1, "A cache keeps\tfrequently used data close."),
        ];
        let kept = grounded_items(&items, &pages);
        let titles: Vec<&str> = kept.iter().map(|item| item.title.as_str()).collect();
        assert_eq!(titles, ["Cache", "Spaced out"]);
    }
}
