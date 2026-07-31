# Proposal: authentication for the board screenshot MCP server

Status: draft for discussion
Owner: TBD
Scope: `apps/dotcom/sync-worker` — the MCP server at `POST /api/app/mcp`

Companion to [`browser-run-thumbnails.md`](./browser-run-thumbnails.md), which documents the server this proposal covers.

## Summary

The MCP server at `POST /api/app/mcp` is anonymous by design. This proposes putting it behind a signed-in tldraw.com account, using OAuth 2.1 so that MCP clients (Claude, ChatGPT, Cursor) can complete the sign-in themselves.

**Any signed-in tldraw.com user qualifies.** There is no staff restriction, no `@tldraw.com` requirement, and no permanent allowlist — the bar is having an account and being signed in.

It assumes the friends-and-family feature flag work has already landed. This layer's job is to establish identity and hand a verified `userId` (and `email`, if the flag needs it) to that flag gate. The flag is a rollout control on the way to all signed-in users, not a narrower entitlement that replaces it.

The important thing to settle before any of the mechanism matters is whether auth is **required or optional**, because this server is not a private surface that leaked. It was built to serve public boards to anonymous agents, and requiring sign-in removes that use case deliberately. That fork is covered first, below, and everything after it assumes the answer.

## The fork: required or optional

The server exposes two read-only tools over boards that are _already public_ — published boards (`tldraw.com/p/:slug`) and anonymously-shared files (`tldraw.com/f/:slug`). Anyone can open those in a browser without an account. So requiring sign-in protects no board data that isn't already reachable; the existing gate in `resolveSharedBoardById` is a check on the _content_ ("is this board publicly viewable"), and auth would add a check on the _caller_.

What a caller check actually buys:

- **Per-user rate limits instead of per-IP.** The current limits key on `cf-connecting-ip` (`ip-info:`, `ip-shot:`). IP limits are weak in both directions — trivially evaded with a proxy pool, and punishing for anyone behind a shared NAT.
- **Attribution for Browser Rendering spend.** This is the surface that costs real money per cache miss. Today a spike is a hashed IP; with identity it's an account.
- **A path to per-plan quotas**, if screenshot capacity ever becomes something we meter.

What it costs: every current anonymous caller, and the "point any agent at a public tldraw board" story the server was built for.

**These two goals are separable, and that matters.** Optional auth — anonymous keeps working at today's limits, signed-in callers get a higher ceiling — delivers the cost-control and attribution benefits without removing the anonymous use case. If the goal is spend control, optional auth is the better instrument; if the goal is genuinely "no anonymous access to this service," required is correct and the anonymous use case is being retired on purpose.

This document proceeds on **required**, as asked. The mechanism below is identical either way — optional auth is the same OAuth plumbing with the 401 made conditional and the rate-limit tier chosen by whether a token was present — so nothing here is wasted if the call goes the other way.

The friends-and-family flag lands before this and makes the fork less binary in practice: required auth can be switched on for the flagged population first while everyone else keeps the anonymous path, then widened as the flag opens up. The target is still every signed-in user — the flag just stages getting there. See [What auth hands to the feature flag gate](#what-auth-hands-to-the-feature-flag-gate).

## Where we are today

`sharedBoardScreenshotMcp.ts` is a hand-rolled JSON-RPC handler on a single route (`worker.ts:186`), not an MCP SDK server. There are no sessions, no Durable Objects, and no per-caller state. Relevant specifics:

- **The protocol version is pinned to `2024-11-05`** (`MCP_PROTOCOL_VERSION`). This predates MCP authorization entirely — auth was introduced in `2025-03-26` and reworked in `2025-06-18`. **Upgrading the advertised protocol version is a prerequisite**, not a follow-up: there is no conformant way to bolt auth onto `2024-11-05`, and clients keying off the advertised version won't attempt a flow the server claims not to support.
- **Abuse control already exists and is not naive.** Three tiers of rate limit (per-IP, per-board, global Browser Run cap), a kill switch (`MCP_SCREENSHOT_ENABLED`), and telemetry with deliberately bounded cardinality. Auth is not the first line of defence here — it's a better key for a defence that's already built.
- **sync-worker is already a Clerk consumer.** `@clerk/backend` ^1.23.7 is a dependency, `CLERK_SECRET_KEY` / `CLERK_PUBLISHABLE_KEY` are in `Environment`, and `utils/tla/getAuth.ts` has `getAuth`/`requireAuth` with an `authorizedParties` allowlist. This is a much shorter path than starting cold.
- **There are no `.well-known` routes on the worker**, and no OAuth dependency anywhere in the repo.

## What the MCP spec requires

Verified against the SDK vendored in this repo and current docs, not from memory:

1. Serve OAuth protected resource metadata at `/.well-known/oauth-protected-resource/<path>`, naming the authorization server.
2. Return `401` with `WWW-Authenticate: Bearer resource_metadata="..."` when unauthenticated, so clients can discover where to authenticate.
3. Accept only tokens issued for this resource; reject tokens minted for a different audience (RFC 8707 resource indicators).

The authorization server needs authorization code + PKCE, `/.well-known/oauth-authorization-server` metadata, and — in practice, for Claude and ChatGPT — dynamic client registration (RFC 7591), because those clients register themselves at connect time rather than using a pre-shared client ID.

One routing wrinkle to confirm early: the public URL is `/api/app/mcp` while the worker route is `/app/mcp`, so the `/api` prefix is applied upstream. Protected resource metadata must be served at the resource's own origin and path, so **whether the worker can serve `/.well-known/...` at the public origin needs verifying before committing to a path layout.** Getting this wrong is a silent discovery failure — clients just never find the authorization server.

## Options

### Option A: Clerk as the authorization server

sync-worker already authenticates users with Clerk, and Clerk can act as an OAuth 2.1 authorization server with dynamic client registration. The worker serves protected resource metadata and verifies Clerk-issued tokens; Clerk owns `/authorize`, `/token`, `/register`, consent, and token lifecycle.

Pros: substantially less code, one identity system, no new token store, and it builds on wiring that is already here and already maintained.

Cons: enabling dynamic client registration creates a public, unauthenticated client registration endpoint on the production Clerk instance that also guards tldraw.com — Clerk's own docs flag this. It also couples MCP token policy to that instance's configuration. There is a report of Claude.ai connectors failing against Clerk-fronted MCP servers ([anthropics/claude-ai-mcp#164](https://github.com/anthropics/claude-ai-mcp/issues/164) — Claude Code via `mcp-remote` worked, the web connector did not); it's closed without a published resolution, so it may be fixed, but it's someone else's interop to depend on.

### Option B: sync-worker runs its own authorization server

Stand up `@cloudflare/workers-oauth-provider` in the worker, with Clerk as the upstream identity provider. Tokens are ours, scoped to this resource, revocable independently, and dynamic client registration sits on our endpoint where we control its rate limits.

Cons: we operate an authorization server — a KV namespace, grant storage, token lifetime decisions — and reason about two token systems instead of one. That's real ongoing surface for a server exposing two read-only tools over public data.

### Recommendation

**Option A**, on the grounds that the thing being protected is public board screenshots, and the proportionate answer is the one that adds least machinery to a worker that already speaks Clerk. Option B's main advantage — keeping dynamic client registration off the production Clerk instance — is a genuine security consideration and the reason to reverse this if the DCR exposure is judged unacceptable. Worth an explicit decision rather than defaulting.

Note this is the opposite call from what would suit a standalone worker with no existing identity story; it turns on sync-worker already being a Clerk consumer.

## Implementation sketch

The auth check sits in front of `sharedBoardScreenshotMcp` at `worker.ts:186`, after the `isMcpScreenshotEnabled` kill switch (so a disabled server still looks absent rather than unauthorized).

- Advertise a current protocol version in `initialize`.
- Serve protected resource metadata; return `401` + `WWW-Authenticate` from the route when no valid token is present.
- Verify the bearer token via Clerk, reusing `getClerkClient` and the `authorizedParties` pattern in `getAuth.ts`. MCP clients send bearer tokens, not cookies, so this is the token path rather than the existing session path.
- Re-key rate limits from `ip-info:` / `ip-shot:` to the authenticated user, keeping IP limits on anything still reachable unauthenticated.
- Swap the hashed-IP telemetry dimension for a hashed user ID. Per `browser-run-thumbnails.md`, hashed IP is written only on failed or rate-limited events; keep that shape and keep the dimension bounded.

Ballpark: the protocol upgrade and the discovery/401 handling are each small; Clerk token verification is small given what's already there; rate-limit and telemetry re-keying is small. The cost is concentrated in client interop testing, which is not compressible — Claude desktop and web, ChatGPT, Cursor, `mcp-remote`.

## What auth hands to the feature flag gate

The friends-and-family flag work lands **before** this, so auth is not the thing deciding who gets in. Auth's job is to produce a trustworthy identity; the flag decides how much of the signed-in population is switched on at any point in the rollout. The end state is every signed-in user — the flag is the dial that gets there safely, not a permanent restriction to a subset.

That keeps the split clean: the rollout can be widened without redeploying the auth layer, and auth never encodes who is eligible.

One wrinkle in the existing flag system is worth settling before the flag work lands, because it determines what auth has to put in the token:

- **`evaluateFlagForUser` takes `userId` only — there is no `email` parameter.** Percentage flags hash `userId + flagName` (`hashToPercentage`); boolean flags ignore the user entirely. Server-side flag evaluation has no email today.
- **Our existing email-based override is client-side.** `commenting_enabled` grants access to `@tldraw.com` emails regardless of the flag, and that check lives in the client (`TldrawApp.ts:96`, `useUser.tsx:38`), not in `featureFlags.ts`. Noted as prior art for _how_ email overrides have been done, not as a model for this gate: MCP callers are Claude and ChatGPT rather than our React app, so anything enforced there isn't enforced at all.

So the flag work picks one:

- **Gate on `userId`** — an allowlist during friends-and-family, or a percentage rollout, widening to everyone. Needs nothing new: the token carries `userId`, and this is exactly what `evaluateFlagForUser` is built for.
- **Gate on `email`** — only if the friends-and-family list is genuinely maintained as email addresses. The catch is that the server-side route to email is a Clerk API call (`users.getUser()`, as `requireAdminAccess` does), i.e. a per-request round trip on a path that is otherwise careful about spend. That wants a verified email claim in the Clerk session token, added as part of the flag work so the auth layer just reads it.

`userId` is the cheaper path and the one that matches how percentage rollouts already work here.

## Overlap and sequencing

- **The friends-and-family flag lands first.** This proposal assumes it exists and consumes it. The flag work owns the entitlement decision and the `userId`-vs-`email` question above; this work owns establishing identity and handing it over.
- **[#9774](https://github.com/tldraw/tldraw/pull/9774)** is actively rewriting `sharedBoardScreenshotMcp.ts` and its tests (cluster-based tools, cache key changes, new telemetry surfaces). Nothing here conflicts — auth wraps the route rather than changing tool internals — but this should land after it, or be written against its branch.
- **`apps/mcp-app` is a separate decision.** It's a different server with a different architecture (MCP SDK, `McpAgent`, Durable Objects), gated on a single shared `MCP_AUTH_TOKEN` that isn't set in production, with no per-user identity. It needs its own answer; the two shouldn't be bundled.

## Rollout

0. The friends-and-family flag lands (prerequisite, tracked separately).
1. Land the protocol upgrade on its own, verifying existing clients still work. This is separable and de-risks the rest.
2. Add discovery endpoints and token verification, with enforcement behind a flag, still accepting anonymous traffic.
3. Verify each client end to end. This is a gate, not a formality — connector-side OAuth failures produce opaque errors with nothing in our logs.
4. Measure the authenticated/anonymous split for at least a week before flipping, so the breakage is sized rather than discovered.
5. Enforce, and announce ahead of it.

Because the flag gate lands first, step 5 does not have to be all-or-nothing: enforcement can go on for flagged users while everyone else keeps the anonymous path, which is the friends-and-family shape anyway.

## Open questions

1. **Required or optional** — the fork at the top. The flag gate softens this: a flagged rollout is a natural staging ground for required auth, since the population that must be signed in is one we control.
2. **Does the flag gate on `userId` or `email`?** Owned by the flag work, but it determines whether the auth layer needs a verified email claim in the token. Worth settling before either lands.
3. **Does the `/api` prefix allow serving `.well-known` at the public origin?** Needs verifying before path layout is fixed.
4. **Is DCR on the production Clerk instance acceptable?** A no reverses the Option A recommendation.
5. **Should this be an issue rather than a PR?** A parallel session offered to file the OAuth work as a GitHub issue. This document covers the same ground, so one or the other should be the home for it — not both.

## References

- [MCP authorization specification](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [Clerk: build an MCP server](https://clerk.com/docs/mcp/build-mcp-server)
- [cloudflare/workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider)
- [anthropics/claude-ai-mcp#164](https://github.com/anthropics/claude-ai-mcp/issues/164)
