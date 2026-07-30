# Proposal: OAuth for the tldraw MCP server

Status: draft for discussion
Owner: TBD
Scope: `apps/mcp-app`

## Summary

The tldraw MCP server at `https://tldraw-mcp-app.tldraw.workers.dev/mcp` is currently open to anyone who knows the URL. This proposal makes it require a signed-in tldraw account, by turning the worker into an OAuth 2.1 protected resource with its own authorization server, backed by Clerk (the same identity system tldraw.com already uses) as the upstream identity provider.

Any signed-in tldraw.com user qualifies. There is no plan gate, allowlist, or staff restriction: the bar is having an account and being signed in, and nothing beyond that.

The recommendation is to run the authorization server inside our worker using `@cloudflare/workers-oauth-provider`, and to delegate the actual sign-in step to Clerk. This gives us MCP-spec-conformant discovery and dynamic client registration without exposing tldraw.com's Clerk instance as a public OAuth authorization server.

## Goals

- Only users signed in with a tldraw.com account can call the MCP server's tools — any account, with no further entitlement check.
- Work in the hosts we care about: Claude (desktop and web connectors), ChatGPT apps, Cursor, VS Code, and `mcp-remote`.
- Give the server a stable user identity it can attribute sessions, checkpoints, rate limits, and analytics to.
- Keep local development usable without forcing developers through a full OAuth dance.

## Non-goals

- Per-user quotas, billing, or plan gating. Identity is the prerequisite; policy, if it ever comes, is a separate decision.
- Multi-tenant sharing of canvases between users.
- Migrating existing anonymous sessions or their checkpoints to accounts.
- Changing the widget's rendering, tool surface, or the `exec` model.

## Where we are today

The worker (`src/worker.ts`) has one authentication mechanism, and it is not per-user:

```ts
const requireAuth = Boolean(env.MCP_AUTH_TOKEN)
// ...
if (requireAuth) {
	const auth = request.headers.get('Authorization')
	if (auth !== `Bearer ${env.MCP_AUTH_TOKEN}`) {
		return corsResponse(new Response('Unauthorized', { status: 401 }))
	}
}
```

That is a single shared static secret, all-or-nothing, and it is not currently set in production — `wrangler.toml` defines no `MCP_AUTH_TOKEN`, so the deployed server accepts every request. `server.json` publishes both remotes publicly. The relevant consequences:

- There is no user identity anywhere in the system. `sessionId` is a random UUID minted per Durable Object; `this.name` gives an MCP session ID, and nothing ties either to a person.
- Rate limiting (`src/worker.ts`) falls back to `mcp-ip:<ip>` when there's no session header, which is the only real abuse control on a worker that runs model-supplied JavaScript (`exec`) and spawns dynamic workers (`search`, via the `LOADER` binding).
- Analytics writes `session_start` with an opaque UUID, so we cannot answer "how many people use this" — only "how many sessions started".
- A static bearer token could not be adopted anyway: MCP hosts like Claude and ChatGPT expect the OAuth flow, not a hand-pasted header.

Two existing details matter for the authorization design, and are covered under [Authorization, not just authentication](#authorization-not-just-authentication):

- The MCP session's Durable Object is addressed by a session ID the client supplies (`mcp-session-id`), so nothing today prevents one caller from resuming another caller's session if they learn the ID.
- Canvas Durable Objects are addressed by an unguessable ID rather than by owner. On `main` today that is the `exec:<sha256(canvasId + code)>` rendezvous, whose key is fully derivable from the code being run. [#9547](https://github.com/tldraw/tldraw/pull/9547) replaces it with `canvas:<canvasId>` keyed on a crypto-random `canvasId`, which is a real improvement — but either way, possession of the identifier is the whole access check.

## What the MCP spec requires

The SDK in this repo (`@modelcontextprotocol/sdk` 1.26.0) supports protocol versions up to `2025-11-25`. Under the current authorization spec, an MCP server acting as an OAuth resource server must:

1. Serve OAuth protected resource metadata at `/.well-known/oauth-protected-resource/<path>` naming its authorization server(s).
2. Return `401` with a `WWW-Authenticate: Bearer resource_metadata="..."` header on unauthenticated requests, so clients can discover where to authenticate.
3. Accept only bearer tokens issued for this resource, and reject tokens issued for a different audience (RFC 8707 resource indicators).

The authorization server must support authorization code flow with PKCE, publish `/.well-known/oauth-authorization-server` metadata, and — for practical purposes with Claude and ChatGPT — support dynamic client registration (RFC 7591), because those hosts register themselves on the fly rather than using a pre-shared client ID.

The SDK ships `requireBearerAuth` and metadata router helpers, but they are Express-shaped (`req`/`res`/`next`) and not usable as-is in a Worker. The discovery documents themselves are small JSON payloads that are straightforward to serve directly.

## Options considered

### Option A (recommended): our worker is the authorization server, Clerk is the upstream IdP

Wrap the worker in `@cloudflare/workers-oauth-provider`. It implements `/authorize`, `/token`, `/register`, and the authorization server metadata document, storing grants in KV. Our `/authorize` handler redirects the user to Clerk to sign in, then completes the grant.

The library is designed for exactly this shape and integrates with `McpAgent`: the authenticated user is handed to the Durable Object as `this.props`. The `McpAgent` class in `agents` 0.5.1 already carries the plumbing — it is generic over a `Props` type, exposes `props?: Props`, and reads props from the execution context.

Pros:

- MCP tokens are ours. They are scoped to this server, revocable independently, and useless against tldraw.com's API.
- Dynamic client registration is exposed on our worker, where we control the rate limits and can prune clients — not on the Clerk instance that guards tldraw.com.
- This is the best-trodden path for remote MCP servers on Cloudflare, which matters a lot for host interop (see [Risks](#risks)).
- Works unchanged if we later want a second sign-in route (e.g. GitHub for the SDK docs audience).

Cons:

- We operate an authorization server: one more KV namespace, grant storage, and token lifetime decisions to own.
- Two token systems to reason about (ours and Clerk's) instead of one.

### Option B: Clerk is the authorization server directly

Clerk can act as an OAuth 2.1 authorization server and supports dynamic client registration; the worker would only serve protected resource metadata and verify Clerk-issued tokens.

Pros: much less code, one identity system, Clerk handles consent screens and token lifecycle.

Cons, and why this is not the recommendation:

- Enabling dynamic client registration creates a public, unauthenticated client registration endpoint on the same Clerk instance that protects tldraw.com. Clerk's own documentation calls out the security risk. Keeping that surface on a standalone worker is a meaningfully smaller blast radius.
- There is documented friction connecting Claude.ai custom connectors to MCP servers using Clerk OAuth ([anthropics/claude-ai-mcp#164](https://github.com/anthropics/claude-ai-mcp/issues/164) — Claude Code via `mcp-remote` worked, the Claude.ai connector did not). That issue is now closed without a published resolution, so it may well be fixed, but it is a dependency on someone else's interop rather than ours.
- It couples MCP token policy to the production Clerk instance's configuration.

Option B is a reasonable fallback if operating an authorization server turns out to be more work than expected. The protected-resource half of the work is identical either way, so the decision can be deferred slightly but not indefinitely.

### Option C: static shared token, documented

Set `MCP_AUTH_TOKEN` and hand it out. Rejected: it is not per-user, it cannot be revoked individually, hosts don't support pasting headers into connector configs, and it answers none of the goals.

## Recommended design

### Request surface

| Path                                                     | Auth                     | Notes                                                   |
| -------------------------------------------------------- | ------------------------ | ------------------------------------------------------- |
| `/mcp`, `/sse`                                           | Bearer token required    | 401 carries `WWW-Authenticate` with `resource_metadata` |
| `/.well-known/oauth-protected-resource/mcp` (and `/sse`) | Public                   | Points at `WORKER_ORIGIN` as the authorization server   |
| `/.well-known/oauth-authorization-server`                | Public                   | Served by `OAuthProvider`                               |
| `/authorize`, `/token`, `/register`                      | Public (OAuth endpoints) | `/register` is rate limited                             |
| `/callback`                                              | Public                   | Clerk redirect target                                   |
| `/health`, `/.well-known/openai-apps-challenge`          | Public                   | Unchanged                                               |
| Widget assets (`ASSETS`)                                 | Public                   | Unchanged — see below                                   |

The widget HTML, CSS, and JS stay public. The MCP host loads them into an iframe with no ability to attach our bearer token, and they contain no user data: all canvas state moves through authenticated MCP tool calls, not asset fetches.

### Shape of the change

`src/worker.ts` stops being the default export. The default export becomes the OAuth provider, which routes authenticated traffic into the existing handlers:

```ts
import OAuthProvider from '@cloudflare/workers-oauth-provider'

export default new OAuthProvider({
	apiHandlers: {
		'/mcp': TldrawMCP.serve('/mcp'),
		'/sse': TldrawMCP.serveSSE('/sse'),
	},
	defaultHandler: publicHandler, // /authorize UI, /callback, /health, challenge, 404
	authorizeEndpoint: '/authorize',
	tokenEndpoint: '/token',
	clientRegistrationEndpoint: '/register',
	scopesSupported: ['canvas'],
})
```

The existing rate limiting, CORS handling, and session checks move into a thin wrapper around the API handlers rather than disappearing.

`/authorize` redirects to Clerk's OAuth authorization endpoint with PKCE. `/callback` exchanges the code, reads the user from Clerk, and completes the grant with the props the Durable Object will see. A successful Clerk sign-in is the whole authorization decision — there is deliberately no entitlement lookup here, and adding one later means adding it in exactly this spot:

```ts
await env.OAUTH_PROVIDER.completeAuthorization({
	request: oauthReqInfo,
	userId: clerkUser.id,
	scope: ['canvas'],
	props: { userId: clerkUser.id, email, name },
})
```

`TldrawMCP` becomes generic over those props and reads the user in `init()`:

```ts
export class TldrawMCP extends McpAgent<
	Env,
	unknown,
	{ userId: string; email: string; name: string }
> {
	// this.props.userId is available in init()
}
```

New configuration:

- `OAUTH_KV` — KV namespace binding for grants and registered clients.
- `CLERK_MCP_CLIENT_ID` / `CLERK_MCP_CLIENT_SECRET` — secrets for the Clerk OAuth application.
- `CLERK_DOMAIN` — Clerk instance domain.
- `MCP_REQUIRE_AUTH` — var gating enforcement during rollout (see below).
- `MCP_AUTH_TOKEN` is retired once enforcement is on.

`server.json` needs no URL change. Clients discover authorization from the `401`, which is the point of the protected resource metadata.

### Authorization, not just authentication

Authenticating the request is necessary but not sufficient. Three existing behaviours need tightening once we have identity, and they are the part of this work most likely to be missed:

1. **Bind the MCP session to its user.** The Durable Object is addressed by the client-supplied `mcp-session-id`. On first `init()`, persist `props.userId` into the DO's `meta` table alongside `sessionId`; on every subsequent request, reject with `403` if the token's user does not match the stored one. Without this, a leaked or guessed session ID lets an authenticated user resume someone else's canvas.

2. **Give canvases an owner.** Canvas access is currently capability-based: whoever holds the identifier gets in. [#9547](https://github.com/tldraw/tldraw/pull/9547) tightens this considerably by moving from a content hash of the exec code to a crypto-random `canvasId`, which removes the guessability problem. What it does not do — because there is no identity to record — is tie a canvas to a person. Once there is one, stamp `ownerId` onto the canvas DO on creation and check it on access, so a leaked or shared `canvasId` stops being a full grant. This is the point where a capability model and an account model have to be reconciled, and it is worth deciding deliberately rather than inheriting: unguessable IDs are genuinely convenient for the widget handoff, and an owner check is not free.

   This item depends on #9547 and should be written against that PR's design, not `main`'s. The per-user salt approach that would have suited the old content-hash key is not the right fix for a random-ID scheme.

3. **Re-key rate limiting.** Switch the primary key from `mcp-session:<id>` / `mcp-ip:<ip>` to `mcp-user:<userId>`, keeping IP-based limiting for the unauthenticated endpoints — `/register` and `/authorize` in particular, which are public by necessity.

Analytics should record a hashed user ID so we can finally distinguish users from sessions.

### Local development

Requiring OAuth in local dev would be a real tax on the iteration loop documented in the README, which already involves rebuilding the widget and reconnecting the client on every change. `yarn dev` and `yarn dev:tunnel` should keep `MCP_REQUIRE_AUTH=false`, matching how `MCP_IS_DEV` is already overridden per-script. The tunnel setup does support the full flow when someone needs to test it, since Clerk requires an HTTPS redirect URI and the per-user tunnel hostname is stable.

## Rollout

Enforcement is the breaking part, so it lands last and separately.

1. **Land the plumbing, disabled.** OAuth provider, discovery endpoints, Clerk handler, and the props wiring, all behind `MCP_REQUIRE_AUTH=false`. The server keeps accepting anonymous traffic. The authorization changes above ship here too, since they're improvements regardless.
2. **Verify host by host.** Claude desktop connector, Claude web connector, ChatGPT apps, Cursor, VS Code, `mcp-remote`. This is the step most likely to surface surprises and should not be compressed.
3. **Dual-accept and measure.** Enable the OAuth path in production while still allowing anonymous requests. Log the authenticated/anonymous split for at least a week to size who breaks when we flip.
4. **Enforce.** Set `MCP_REQUIRE_AUTH=true`, remove the anonymous path, retire `MCP_AUTH_TOKEN`. Announce ahead of time — anyone with the server configured will need to reconnect and sign in, and their existing checkpoints will not carry over.

Existing anonymous sessions and their checkpoints are orphaned by the flip. This is acceptable: checkpoints are already evicted by an LRU capped at `MAX_CHECKPOINTS`, and the widget also persists to browser local storage. It should be stated in the announcement rather than quietly absorbed.

## Risks

- **Host interop is the biggest risk and it is not fully in our control.** Every MCP host implements the OAuth flow slightly differently, and connector-side failures produce opaque errors with no server-side logs to debug from — exactly the failure mode in the Clerk/Claude.ai report above. Mitigations: own the authorization server (Option A) rather than depending on a third party's, and treat step 2 of the rollout as a gate rather than a formality.
- **Dynamic client registration is a public unauthenticated endpoint.** Anyone can register a client. Rate limit `/register` by IP, cap stored clients, and prune registrations that never complete a grant.
- **Audience confusion.** Tokens must be rejected if issued for a different resource. Confirm `@cloudflare/workers-oauth-provider` handles RFC 8707 resource indicators as we need, rather than assuming it.
- **This proposal overlaps [#9547](https://github.com/tldraw/tldraw/pull/9547).** That PR reworks the exec flow this document's authorization section touches: it retires the `exec:<execKey>` rendezvous, deletes `src/shared/pending-requests.ts`, and re-addresses canvas DOs as `canvas:<canvasId>`. Nothing here conflicts with it — the OAuth layer sits above that plumbing — but the canvas-ownership work should be sequenced after it lands and designed against its model. Worth agreeing the ordering with its author before either side starts implementing.
- **`agents` version.** This repo is on `agents` 0.5.1. Props plumbing exists there, but 0.6.0 has since reworked OAuth handling. Decide early whether to upgrade as part of this work or pin deliberately; discovering the difference mid-implementation is worse than either.
- **Sign-in friction reduces usage.** Requiring an account will cost some casual usage of a server whose current appeal is that it works instantly from any client. That is the explicit trade being made here, not an unintended consequence — worth naming so it is a decision rather than a surprise in the analytics.

## Work breakdown

| Item                                                                               | Size                       |
| ---------------------------------------------------------------------------------- | -------------------------- |
| OAuth provider wiring, discovery endpoints, 401 semantics                          | M                          |
| Clerk OAuth application setup, `/authorize` + `/callback` handlers                 | M                          |
| Props into `McpAgent`, session-to-user binding, re-keyed rate limits and analytics | M                          |
| Exec rendezvous namespacing (server + widget, shipped together)                    | S                          |
| Host interop testing across five clients                                           | M, and hard to compress    |
| Dev scripts, `wrangler.toml`, README, secrets in CI                                | S                          |
| Dual-accept measurement window                                                     | 1 week elapsed, low effort |

## Decided

- **Which account counts as "logged in":** any signed-in tldraw.com user. No plan gate, no staff restriction, no allowlist.

## Open questions

1. **Should MCP identity link to tldraw.com data?** Today the MCP server shares no database with the dotcom app. Authenticating with Clerk creates the option of reading and writing the user's tldraw.com files from the canvas. That is a much larger scope and should be a separate decision, but it argues for keeping user IDs consistent with dotcom's from day one, which this design does.
2. **Do we keep the SSE transport authenticated the same way?** It is legacy, and dropping it at the same time as the auth flip would mean one breaking change instead of two.

## References

- [MCP authorization specification](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [cloudflare/workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider)
- [Cloudflare: build a remote MCP server](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)
- [Clerk: build an MCP server](https://clerk.com/docs/mcp/build-mcp-server)
- [clerk/mcp-tools](https://github.com/clerk/mcp-tools)
- [anthropics/claude-ai-mcp#164](https://github.com/anthropics/claude-ai-mcp/issues/164)
