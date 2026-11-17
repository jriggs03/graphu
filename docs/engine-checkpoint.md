# Graph engine checkpoint

## Audit

The running application uses Rust core/storage, an ingestion crate calling Claude with structured JSON, an Axum API, and React/TypeScript. Upload parsing retains pages. Extraction produces candidates; grounding verifies exact normalized quotes and snippets; SQLite stores reviewable claims; notebooks aggregate claims into concepts and edges. Cross-source linking retains two quotes. Approval, undo, incremental ingestion, and grouped topics already exist.

The main correctness defect was treating every edge as a learning dependency, both in extraction instructions and route generation. The prompt explicitly equated mentioning or using another concept with requiring it.

## Implemented first increment

- Extraction and cross-source linking request typed semantic relationships with explicit direction.
- The prompt distinguishes composition, use, comparison, chronology, and prerequisites.
- Rust route generation and browser learning routes traverse only REQUIRES and explicit legacy equivalents.
- Rust traversal excludes unapproved endpoints and deduplicates pairs.
- Learn first / Used by panels filter to prerequisite types. Other links remain available in the graph and edge inspector.
- Unknown existing relation labels are preserved without automatically entering a learning path.
- Regression tests protect semantic edges from becoming prerequisites. The existing sample route expectation changes because its non-prerequisite relation no longer qualifies.

No database migration was necessary for this increment: existing relation text supports the vocabulary. This is a compatibility policy, not a complete new schema.

## Next implementation increments

1. Introduce versioned canonical relationship and assertion-origin fields. Keep origin (explicit source claim, pedagogical inference, manual assertion) independent of review status. Existing stated/linked evidence labels describe extraction method and cannot establish entailment. Backfill legacy assertions as unverified rather than declaring them source-explicit.
2. Validate extraction relationship enums and attach auditable rejection reasons. Exact quote matching is already implemented; semantic support still depends on model output and human review.
3. Derive a goal-aware learning response with required/helpful/optional classifications, inclusion reasons, known-concept exclusions, depth bounds, cycle diagnostics, and explicit AND/OR groups.
4. Use that response for browser routes, relationship inspection, and ranking. Reconcile structural layout and edge arrows with each relationship's direction.
5. Add annotated synthetic fixtures across mathematics, computing, natural science, history, and humanities, plus a reusable precision/recall, unsupported-edge, evidence, and false-prerequisite evaluation command.
6. Test real PDFs and annotate source-supported components for recall. The DATA 4620 lecture and screenshot have not been inspected in this increment.

## Verification limits

A successful build and fixture tests do not establish extraction accuracy across subjects. No paid model extraction or deployed app verification was performed for this increment. Existing inferred or incorrectly classified legacy prerequisite claims still need review. The current cycle-safe route does not report cycles, and this change does not implement the complete overhaul.
