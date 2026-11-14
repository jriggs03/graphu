# Graphu handoff for Claude

James plans to hand off Graphu to Claude. The current FastAPI and React scaffold demonstrates the core flow. James wants the next implementation in Rust for performance and wants the current UI redesigned.

## Rust implementation

Use Rust for the backend, including PDF text extraction, AI requests, provenance validation, review, and graph storage. Decide on the frontend stack as part of the redesign. Measure PDF parsing, AI request time, and graph loading separately to see where the Rust implementation improves the experience.

## Interface redesign

Treat the current visual design as temporary. Start from the student workflow and share a new visual direction with James before investing in polish. The product should let a student upload a lecture PDF, review suggested concepts and relationships alongside their page citations, then explore the approved graph and inspect its source evidence.

## Behavior to preserve

- Keep one responsive web experience with PWA installation.
- Check every proposed quote against its source page and require user approval before it enters the graph.
- Persist review decisions and graph data across restarts. Support adding more documents without erasing the graph or reintroducing rejected suggestions.
- Keep API keys server-side and retain a sample path that works without credentials.
- Use the existing tests as a reference for behaviors the Rust implementation should cover.

See [the README](README.md) for the current scaffold and [the hackathon notes](HACKATHON.md) for the build window, submission deadlines, and credits. The repository is private. Judges still need access and a separate hosted demo link.
