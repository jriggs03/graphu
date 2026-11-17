//! Relationship semantics independent of subject matter.
//! Unknown legacy labels remain inspectable but never imply a prerequisite.

/// The source concept requires the target concept. Legacy explicit labels are supported.
pub fn is_requirement(relation: &str) -> bool {
    matches!(relation.trim().to_lowercase().as_str(),
        "requires" | "relies on" | "depends on" | "requires understanding")
}

/// Canonical vocabulary. Direction always describes the source relative to the target.
pub const TYPES: &[&str] = &[
    "REQUIRES", "PART_OF", "IS_A", "USES", "CAUSES", "PRECEDES",
    "CONTRASTS_WITH", "ILLUSTRATES", "SUPPORTS", "MOTIVATES", "RELATED_TO",
];

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_explicit_dependencies_are_requirements() {
        for label in ["REQUIRES", " relies on ", "depends on"] {
            assert!(is_requirement(label));
        }
        // Comparison, chronology, composition and illustration across unrelated subjects.
        for label in ["CONTRASTS_WITH", "PRECEDES", "PART_OF", "ILLUSTRATES",
                      "CAUSES", "USES", "extends", "builds on", "unknown"] {
            assert!(!is_requirement(label), "{label}");
        }
    }
}
