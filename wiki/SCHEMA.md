---
schema_version: 2
---
# Wiki Schema v2

Dirs: wiki/{entities,sources,queries,maintenance}, raw/ (LLM-write-protected, hook enforced)
Global tier: ~/.claude/wiki/topics/ (Sonnet auto-writes) — /wiki-load searches both tiers

## Page Formats

**Entity** (entities/SLUG.md):
  ---
  name: Entity Name
  type: entity
  description: "One-line retrieval hook — what it IS + 2-3 search terms in parens"
  tags: [tag1, tag2]
  confidence: high | medium | low
  last_verified: YYYY-MM-DD
  created: YYYY-MM-DD
  last_updated: YYYY-MM-DD
  sources: [source-slug-1]
  related: [entity-slug-1]
  ---
  # Entity Name
  Overview (2-3 sentences).
  - **From [Source]:** 2-3 sentences per source (bullet list, NOT separate headers)
  → See also: related-entity-links

**Source** (sources/SLUG.md):
  ---
  name: Source Title
  type: source
  source_type: article | paper | gist | session_log | doc | code | book | other
  url_or_path: https://...
  ingested: YYYY-MM-DD
  confidence: high | medium | low
  tags: [tag1, tag2]
  ---
  # Title
  SOURCE_TYPE | DATE | URL-or-path | Ingested: DATE
  Summary (3-5 paragraphs). Concepts (bulleted key:description). Relevance (1-2 sentences).
  → Related: entity-links

**Query** (queries/SLUG.md):
  # Query: Question
  Asked: DATE | Pages: slug-list
  Answer with citations. Evidence bullets. Gaps section.

## Rules
1. Never write raw/ (hook blocks it)
2. Always update index.md after wiki changes
3. Always append log.md after ingest/query/lint
4. Entity pages: add "- **From [Source]:**" bullet — never overwrite existing entries
5. Cross-link entities. Prefer update over create. Lint before bulk ops.
6. Frontmatter fields are all optional at write time (lint advisory only, never blocking)

## Formats
Log: `[YYYY-MM-DD HH:MM] TYPE detail` (INIT,INGEST,QUERY,LINT,SESSION_START,SESSION_END,EXTRACT)
Log rotation: >500 entries → /wiki-lint suggests archive
Index: `| page-path | summary | YYYY-MM-DD |` — every page gets a row, never remove rows
Slugs: lowercase, hyphens, max 50 chars

## Notes
Entity extraction is LLM judgment (intentional). Concurrent ingests may race on index.md (accepted).
Hooks do NOT parse YAML frontmatter — schema changes are invisible to the control path.
