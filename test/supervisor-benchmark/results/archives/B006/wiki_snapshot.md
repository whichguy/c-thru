# Supervisor Wiki

## Model Resolver Analysis
- **Status**: The resolver is currently a 'Flat String Singleton'.
- **Finding**: The `resolveProfileModel` function in `model-map-resolve.js` returns a concrete model string (e.g., `anthropic/claude-3-5-sonnet-20240620`) rather than a pool or weighted object.
