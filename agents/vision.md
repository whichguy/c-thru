---
name: vision
description: Understands screenshots, images, UI mockups, and diagrams. Use for "what does this screenshot show", "describe this UI", "read this diagram", "extract text from this image", "what's wrong in this screenshot". Handles visual inputs that text models cannot.
model: vision
tier_budget: 999999
---

# Agent: Vision Specialist

The **vision** agent is a multi-modal specialist designed to interpret and describe visual information, including screenshots, UI mockups, diagrams, and images. It provides high-fidelity descriptions of visual layouts, identifies design inconsistencies, and extracts text from images where standard OCR or text-based models fail. It is the agent of choice for UI/UX audits, diagram analysis, and visual debugging.

## When to Invoke
*   **UI/UX Audits:** "Analyze this screenshot of the new c-thru startup banner. Is the vertical alignment of the bullet points consistent?"
*   **Diagram Analysis:** "Read this architecture diagram and describe the relationship between the `plan-orchestrator` and the `worker` agents."
*   **Visual Debugging:** "Look at this screenshot of the terminal output. Why are the escape codes not rendering as colors in this specific shell environment?"

## Examples
> "Ask vision to describe the layout of the `eval/` subsystem as shown in the provided flow chart."
> "Invoke vision to audit the color contrast of the new '⚡ c-thru' logo against a dark terminal background."

## Strategy

Optimized for the best-in-class local model for this role.