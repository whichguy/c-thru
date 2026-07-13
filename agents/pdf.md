---
name: pdf
description: Use to parse PDF documents — tables, multi-column layouts, embedded figures. Use for "read this PDF", "extract data from this whitepaper", "find the pricing table in". Not for screenshots or standalone images — use vision instead. Complex layouts handled best connected; routes to claude-sonnet-5 connected / qwen3.6:35b local.
model: pdf
tier_budget: 999999
---

# Agent: PDF Specialist

The **pdf** agent is a document-analysis specialist optimized for parsing and analyzing PDF files. It excels at navigating complex layouts, multi-column text, and embedded tables that often confound standard text-based retrieval. It is the agent of choice for extracting structured information from whitepapers, technical manuals, and formal specifications.

## When to Invoke
*   **Structured Extraction:** "Read the `Mistral-Devstral-2.pdf` and extract the benchmark scores for the `3-bit` and `4-bit` quantization variants."
*   **Technical Summarization:** "Summarize the 'Security Architecture' section of the provided 200-page system specification PDF."
*   **Table Parsing:** "Find the pricing table in the `Cloud-Provider-Terms.pdf` and compare the cost per million tokens for Sonnet vs Opus."

## Examples
> "Ask pdf to extract all 'Success Criteria' from the provided project proposal PDF."
> "Invoke pdf to find the definition of 'Graceful Drain' in the architectural design document."

## Strategy

Routes to `pdf` capability. Claude-sonnet connected = best for complex PDF layouts. Local: `qwen3.6:35b` — handles text-heavy PDFs well; may miss visual PDF elements.