
---
[P001]
PARENT: NONE
TEXT: "The proxy failure is caused by a port mismatch between the router (c-thru) and the proxy server (claude-proxy) OR the proxy server is failing to bind to port 9997."
---

---
[Q002]
PARENT: P001
TEXT: "tools/c-thru is configured to use port 9997 for ANTHROPIC_BASE_URL"
---

---
[Q003]
PARENT: P001
TEXT: "tools/claude-proxy is configured to listen on port 9997"
---

---
[Q004]
PARENT: P001
TEXT: "Port 9997 is reachable and listening when proxy is active"
---
