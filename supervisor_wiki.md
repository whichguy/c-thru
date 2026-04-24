# Supervisor Wiki

## Model Resolver Analysis
- **Status**: The resolver is currently a 'Flat String Singleton'.
- **Finding**: The `resolveProfileModel` function in `model-map-resolve.js` returns a concrete model string (e.g., `anthropic/claude-3-5-sonnet-20240620`) rather than a pool or weighted object.

## [BRIDGES] - Multi-Environment Tooling
- **[GCP:GAS]:** Sovereign Tool: mcp-gas-deploy. Use ls(), exec(), status(). [E7]
- **[DOCKER]:** Sovereign Tool: Bash (docker cli). Use docker inspect, docker logs. [E8]
- **[WEB]:** Sovereign Tool: WebFetch. Use fetch_url(). [E9]

## [EVIDENCE_VAULT] (Additions)
- [E7]: agents/evaluator.md -> MCP registration verified.
- [E8]: tools/c-thru-cleanup -> Docker commands active.
- [E9]: GEMINI.md -> stdlib fetchers defined.
