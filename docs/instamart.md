# Instamart MCP spike (Sat 2026-11-21, 15-min timebox)

**Verdict: not usable today. Stay on the mock catalog.**

1. Auth works mechanically: `https://mcp.swiggy.com/im` returns 401 with OAuth 2.1 + PKCE metadata, Dynamic Client Registration accepts a custom client (`POST /auth/register` → 201), and `/auth/authorize` accepts an `http://localhost` redirect, then sends you to Swiggy phone + OTP login.
2. Every call runs as one end user's Swiggy account (phone OTP, user-scoped tokens). There is no server-to-server or household-level key, so the deployed server would need each household's own OAuth session.
3. v1 is invite-based. Only `http://localhost` is allowed without review. The deployed HTTPS redirect (Lightsail) and staging both need allowlisting through builders@swiggy.in (form + demo video). There is no SLA for developers, and production needs at least 48 h of green staging. None of that fits before the 23:00 freeze.
4. The public docs don't list the Instamart tools and don't say how cart, checkout, payment or address work, so a localhost-only demo still means discovering them live against a real account.
5. Plan: `buildCart` keeps one interface (`platform: "mock"`, per-line Instamart search URLs). An Instamart backend can drop in behind it after allowlisting (v1.1). Sources: mcp.swiggy.com/builders/docs/operate/access/, …/start/consumer/use-in-ai-client.md
