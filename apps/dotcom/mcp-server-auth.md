# Proposal: authentication for the board screenshot MCP server

Status: draft for discussion
Owner: TBD
Scope: `apps/dotcom/sync-worker` — the MCP server at `POST /api/app/mcp`

Companion to [`browser-run-thumbnails.md`](./browser-run-thumbnails.md), which documents the server this proposal covers.

## Summary

The MCP server at `POST /api/app/mcp` is anonymous by design. This proposes putting it behind a signed-in tldraw.com account, using OAuth 2.1 so that MCP clients (Claude, ChatGPT, Cursor) can complete the sign-in themselves.

**The eventual bar is any signed-in tldraw.com user** — no staff restriction, no `@tldraw.com` requirement, no permanent allowlist. **For now, feature flags restrict access to a specific subset of users**, and the rollout widens from there.

It assumes the friends-and-family feature flag work has already landed. This layer's job is to establish identity and hand a verified `userId` (and `email`, if the flag needs it) to that flag gate.

**Auth is required, not optional.** Every call to `/api/app/mcp` needs a valid token; there is no anonymous tier. This retires the "point any agent at a public tldraw board" use case the server was built for, deliberately.

On top of that, the server checks that the authenticated user **has access to the board they ask for**, rather than only checking that the board is publicly viewable. That second requirement is the larger change of the two, and it is what [Checking board access](#checking-board-access) covers.

## What this changes

Two things move at once, and it's worth separating them because they have different consequences.

**Requiring auth** buys:

- **Per-user rate limits instead of per-IP.** The current limits key on `cf-connecting-ip` (`ip-info:`, `ip-shot:`). IP limits are weak in both directions — trivially evaded with a proxy pool, and punishing for anyone behind a shared NAT.
- **Attribution for Browser Rendering spend.** This is the surface that costs real money per cache miss. Today a spike is a hashed IP; with identity it's an account.
- **A path to per-plan quotas**, if screenshot capacity ever becomes something we meter.

It costs every current anonymous caller. Since the tools only reach boards that are already public, that population is losing access to data it could still read by opening a browser — so the case for required auth rests on the operational benefits above and on the access check below, not on protecting board contents from people who can already see them.

**Adding a per-user access check** is the part that makes auth load-bearing. Once the gate is "can this user see this board" rather than "is this board public", identity is doing real work, and the server can in principle serve boards that are not public at all. Whether it _should_ is the open scope question in the next section.

The friends-and-family flag stages the rollout: required auth goes on for the flagged population first, then widens. The target is every signed-in user — the flag is the dial, not a narrower entitlement. See [What auth hands to the feature flag gate](#what-auth-hands-to-the-feature-flag-gate).

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

Cons: we operate an authorization server — a KV namespace, grant storage, token lifetime decisions — and reason about two token systems instead of one.

### Recommendation

**Option A**, on the grounds that it adds least machinery to a worker that already speaks Clerk. This is the opposite call from what would suit a standalone worker with no existing identity story; it turns on sync-worker already being a Clerk consumer.

**But the access check changes the weighting, and this should be re-examined rather than assumed.** The proportionality argument for Option A was strongest when the tools only reached public boards: a leaked token bought an attacker nothing they couldn't get from a browser. If [the access check admits private boards](#the-scope-question-this-raises), tokens minted through this flow become credentials for private user content, and Option B's advantages get more valuable — tokens scoped to this resource alone rather than usable against tldraw.com, revocable independently, and dynamic client registration kept off the Clerk instance that guards the main app.

So: Option A if the access check only tightens the public gate. If private boards are in scope, re-run the comparison before committing — the answer may well flip, and it is much cheaper to decide that now than to migrate token issuance later.

## Checking board access

Today the tools resolve a board through `resolveSharedBoardById`, which tries it as an anonymously-shared file and then as a published board. Both paths apply a **public-viewability** gate: published boards must be `published`, shared files must pass `isFileAnonymouslyViewable` (exists, not deleted, `shared` via link). The caller is irrelevant to that decision — the same board resolves the same way for everyone.

The requirement is to replace that with "can **this user** see this board". Composing it from what exists means: the user owns the file (`file.ownerId`), or the file belongs to a group they can access (`getRole` + `can(role, 'accessFiles')`), or the board is publicly viewable by the existing gate. That is `requireWriteAccessToFile` in `getAuth.ts` minus the `sharedLinkType === 'edit'` requirement — there is no read-access equivalent in the codebase yet, so one needs writing, ideally shared rather than inlined here.

### The scope question this raises

A user-scoped gate admits boards that are not public — the user's own private files. That is a genuine expansion of what this server does, from "screenshot public boards" to "screenshot any board you can see", and it should be an explicit decision:

- **Tighten only.** Keep the public-viewability gate and additionally require that the caller is signed in and flag-enabled. Private boards stay unreachable. Smallest change, no new exposure.
- **Extend to the user's own boards.** The tools become useful for private work, which is probably the point of authenticating in the first place. Larger security surface — see below.

The document assumes the second is intended, since checking "does this user have access" is otherwise indistinguishable from checking nothing. Confirm before building.

### The render pipeline assumes public boards, in three places

This is the part most likely to bite, and it isn't visible from the MCP handler alone. The share gate is re-applied at three separate points, and all three are anonymous-public checks:

1. `resolveSharedBoardById` / `resolveThumbnailBoard`, when the tool call arrives.
2. `loadBoardSnapshot`, which re-checks the publish/share gate as it reads.
3. `GET /app/thumbnail-render/snapshot`, which the render page calls to fetch snapshot data. Per `browser-run-thumbnails.md`, this deliberately re-checks the share gate "not just when the token was minted, so a board un-shared during the token's 5 minute window stops resolving."

**That third endpoint is unauthenticated.** It verifies the HMAC render token (`403` on invalid or expired) and carries no user context — `ThumbnailRenderJob` holds `kind`, `slug`, `pageId`, and render params, but no `userId`. Its safety today rests entirely on the board being public anyway: even if a token leaked, it only ever unlocks something the holder could already view.

Extending to private boards breaks that reasoning. Relaxing the gate at points 2 and 3 so private boards can render makes the render token the **sole** authority for reading a private board's contents, at an endpoint with no authentication. So if private boards are in scope, the token must bind the requesting user and the snapshot route must verify that user's access — not merely that the token is well-formed and unexpired. Adding `userId` to the signed job payload and re-running the access check in `getThumbnailSnapshot` is the straightforward version.

Two smaller consequences of the same change:

- **Cache keys need a viewer dimension, or the check has to precede the cache read.** Keys are `mcp/{kind}/{slug}/{version}/...` with no notion of who may see them. A cached private board would otherwise be served to any caller who names the right board id — the access check must gate the cache read, not just the render.
- **`resolveSharedBoardById`'s try-shared-then-published fallback becomes an existence oracle** if error messages distinguish "no such board" from "you can't see it". Keep the current single not-found message for both.

### Keep the gate separate, not relaxed

Planned work moves MCP screenshots to caller-specified viewports, leaving the fixed-size thumbnail render for the image generation flow. That splits two surfaces which today share `resolveThumbnailBoard`, `loadBoardSnapshot`, and the render token path — and they will no longer share an access model. MCP becomes user-scoped; OG images and thumbnails must stay strictly public, because they are served to crawlers and link unfurlers with no user at all.

So the user-scoped check should be **a new gate alongside the existing one, not a relaxation of the shared helpers**. Loosening `loadBoardSnapshot` or the snapshot route in place would silently let the OG image route render private boards — a board owner's private file appearing in a link unfurl is exactly the failure this note exists to prevent. Whatever shape it takes, the public-only path must keep a gate that cannot be satisfied by a user-scoped token.

Two more consequences of the viewport change, neither blocking but both worth designing around now:

- **Arbitrary viewports are much less cacheable.** The current key space is small and bounded (one entry per page, theme, and version); caller-chosen viewports make near-every call a miss, so Browser Run spend per call rises sharply. That strengthens the case for per-user quotas rather than weakening it, and viewport parameters will need bounding so a caller can't request an absurd render size.
- **The render token gains viewport parameters**, which is the same payload that would gain `userId` for private-board access. Worth doing both in one change to the signed job rather than two.

## Implementation sketch

The auth check sits in front of `sharedBoardScreenshotMcp` at `worker.ts:186`, after the `isMcpScreenshotEnabled` kill switch (so a disabled server still looks absent rather than unauthorized).

- Advertise a current protocol version in `initialize`.
- Serve protected resource metadata; return `401` + `WWW-Authenticate` from the route when no valid token is present. Every call needs one — there is no anonymous path.
- Verify the bearer token via Clerk, reusing `getClerkClient` and the `authorizedParties` pattern in `getAuth.ts`. MCP clients send bearer tokens, not cookies, so this is the token path rather than the existing session path.
- Evaluate the feature flag for the authenticated user; deny if not enabled.
- Replace the public-viewability gate with a per-user access check, and make it gate the cache read as well as the render. See [Checking board access](#checking-board-access).
- Re-key rate limits from `ip-info:` / `ip-shot:` to the authenticated user. IP limits still matter for the unauthenticated endpoints — `/app/thumbnail-render/snapshot` and anything OAuth exposes — so they stay there.
- Swap the hashed-IP telemetry dimension for a hashed user ID. Per `browser-run-thumbnails.md`, hashed IP is written only on failed or rate-limited events; keep that shape and keep the dimension bounded.

Ballpark: the protocol upgrade, discovery/401 handling, Clerk token verification, and rate-limit and telemetry re-keying are each small. The two that aren't: threading a user-scoped access check through the render pipeline, and client interop testing across Claude desktop and web, ChatGPT, Cursor, and `mcp-remote`. Neither compresses well.

## What auth hands to the feature flag gate

The friends-and-family flag work lands **before** this, so auth is not the thing deciding who gets in. Auth produces a trustworthy identity; the flag decides which users are switched on. Initially that's a specific subset, widening to all signed-in users. Keeping the split clean means the rollout widens without redeploying the auth layer, and auth never encodes who is eligible.

**The current flag system cannot express "these specific users."** `FeatureFlagValue` is `BooleanFeatureFlag | PercentageFeatureFlag` (`packages/dotcom-shared/src/types.ts:313`): boolean is all-or-nothing, and percentage is a pseudo-random bucket — `hashToPercentage(userId + flagName) < percentage`. A percentage rollout gives you _a_ subset, never _the_ subset you picked. Naming specific users needs either a new flag type (`type: 'allowlist'`, with `userIds`) or an allowlist stored beside the flag. This is the flag work's problem rather than this proposal's, but it is worth knowing before that work starts, because "gate it behind a flag" sounds like it needs no new flag machinery and here it does.

Two related findings about what the allowlist can key on:

- **`evaluateFlagForUser` takes `userId` only — there is no `email` parameter.** Server-side flag evaluation has no access to email today.
- **Our existing email-based override is client-side.** `commenting_enabled` grants access to `@tldraw.com` emails regardless of the flag, and that check lives in the client (`TldrawApp.ts:96`, `useUser.tsx:38`), not in `featureFlags.ts`. Noted as prior art for _how_ email overrides have been done, not as a model for this gate: MCP callers are Claude and ChatGPT rather than our React app, so anything enforced there isn't enforced at all.

So the flag work picks a key:

- **`userId`** — the token carries it, `evaluateFlagForUser` already takes it, and nothing new is needed beyond the allowlist type itself.
- **`email`** — only if the subset is genuinely maintained as email addresses. The server-side route to email is a Clerk API call (`users.getUser()`, as `requireAdminAccess` does), i.e. a per-request round trip on a path that is otherwise careful about spend. That wants a verified email claim in the Clerk session token, added as part of the flag work so the auth layer just reads it.

`userId` is the cheaper path. Email is more convenient for maintaining a human-readable list, which is a real consideration for a hand-picked subset — worth weighing rather than defaulting.

## Overlap and sequencing

- **The friends-and-family flag lands first.** This proposal assumes it exists and consumes it. The flag work owns the entitlement decision and the `userId`-vs-`email` question above; this work owns establishing identity and handing it over.
- **[#9774](https://github.com/tldraw/tldraw/pull/9774)** is actively rewriting `sharedBoardScreenshotMcp.ts` and its tests (cluster-based tools, cache key changes, new telemetry surfaces). Nothing here conflicts — auth wraps the route rather than changing tool internals — but this should land after it, or be written against its branch.
- **`apps/mcp-app` is a separate decision.** It's a different server with a different architecture (MCP SDK, `McpAgent`, Durable Objects), gated on a single shared `MCP_AUTH_TOKEN` that isn't set in production, with no per-user identity. It needs its own answer; the two shouldn't be bundled.

## Rollout

0. The friends-and-family flag lands, including whatever allowlist mechanism it needs (prerequisite, tracked separately).
1. Land the protocol upgrade on its own, verifying existing clients still work. Separable, and it de-risks the rest.
2. Add discovery endpoints and token verification. Announce the cutover date — every existing anonymous caller breaks at step 4.
3. Verify each client end to end. This is a gate, not a formality — connector-side OAuth failures produce opaque errors with nothing in our logs.
4. Enforce for flag-enabled users, denying everyone else. Because auth is required, there is no anonymous path to fall back to, so this is the breaking moment rather than a soft launch.
5. Land the per-user board access check, with the render pipeline changes it needs.
6. Widen the flag as confidence builds.

Steps 4 and 5 are separable and worth keeping apart: step 4 is the disruptive one for existing callers, step 5 is the one with security surface in the render pipeline. Landing them together means debugging both classes of problem at once.

## Open questions

1. **Does the access check admit private boards, or only tighten the public gate?** The larger of the two scope questions — it determines whether the render pipeline work in [Checking board access](#checking-board-access) is needed at all.
2. **How does the flag name specific users?** The current flag types can't express an allowlist. Owned by the flag work, but it blocks the rollout.
3. **Does the flag gate on `userId` or `email`?** Determines whether the auth layer needs a verified email claim in the token.
4. **Does the `/api` prefix allow serving `.well-known` at the public origin?** Needs verifying before path layout is fixed.
5. **Is DCR on the production Clerk instance acceptable?** A no reverses the Option A recommendation.
6. **Should this be an issue rather than a PR?** A parallel session offered to file the OAuth work as a GitHub issue. This document covers the same ground, so one or the other should be the home for it — not both.

## References

- [MCP authorization specification](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [Clerk: build an MCP server](https://clerk.com/docs/mcp/build-mcp-server)
- [cloudflare/workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider)
- [anthropics/claude-ai-mcp#164](https://github.com/anthropics/claude-ai-mcp/issues/164)
