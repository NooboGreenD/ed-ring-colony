# EGS account: Frontier CAPI `/profile` returns HTTP 400 — case context

**Context recorded:** 25 October 2026  
**Status:** unresolved upstream symptom; app-side OAuth handling has been corrected.  
**Purpose:** preserve what is known, what is not known, and the next useful investigation so a later session does not restart the same login/linking checklist.

Related documents: [CAPI-ENTITLEMENT-FIX.md](CAPI-ENTITLEMENT-FIX.md), [CAPI-SITE-OWNERSHIP.md](CAPI-SITE-OWNERSHIP.md), [CAPI-400-FIX.md](CAPI-400-FIX.md). This case note is the current account-specific continuation and takes precedence over older generic troubleshooting steps.

## User-reported facts and checks already repeated

- The commander/account was linked by signing in with the **Epic Games Store** option. The user has rechecked linking many times.
- Do **not** ask the user to repeat Epic sign-in, unlink/relink, inspect Linked Thirdparty Accounts, or launch the game as if those actions had not been tried. A future investigation should add new evidence, not repeat that checklist.
- The observed Frontier identity platform is `frontier`. That is an identity claim returned by Frontier; on its own it does not prove which OAuth button the user selected or that the game entitlement is absent.

## Latest sanitized live diagnostic

Secrets and account-specific identifiers are intentionally omitted here. The submitted diagnostic showed:

| Area | Observed value | What it tells us |
|---|---|---|
| Site configuration | `siteUrlError=null`, client ID from env, shared key present, redirect URI matches expected site callback | No visible site URL / redirect mismatch in this probe |
| Link | `linked=true`, `active=true`, `scope=auth capi`, `accessExpired=false`, refresh token present | The site has an active saved binding and refresh credential; this is not a reported token-rejection state |
| Frontier identity | `platform=frontier`; commander name absent | Identity metadata is available, but does not establish EGS purchase entitlement |
| Stored profile | `saved=false`, no commander, credits, system, ship, or update time | No profile has been persisted; this is a data-fetch failure, not a display-only stale profile |
| Live request | `probed=true`, `/profile`, Live host `companion.orerve.net`, HTTP 400, `kind=no_entitlement`, `reason=entitlement_unavailable` | Frontier returned its purchase/entitlement refusal; no timeout was reported (`transportPhase=null`) |
| OAuth recovery | `needsReauth=false` | Current application correctly does not treat this response as proof that OAuth must be repeated |
| Request platform field | Not present on this diagnostic job | The job-level OAuth audience was not recorded; this does not mean the original login used “Auto” |

Frontier's response body was:

```text
Please <a class="alert-link" href="https://frontierstore.net/">Visit the store</a> to purchase Elite: Dangerous.
```

The raw HTML is part of Frontier's response. The UI safely escapes it, which is why markup can appear as visible `&lt;a...` text; it is a presentation/normalization issue, not the cause of the 400. Do not render this remote HTML with `dangerouslySetInnerHTML`.

The stored `lastError` still recommends launching the game and checking the store link. Those suggestions have already been tried repeatedly in this case and are not a useful next instruction to this user.

## Timeline: keep different failure modes separate

1. **Earlier job `27e8b9fa-fdbd-4588-be1f-160f1509c0a0`:** `/profile` ran for about 60.05 s and timed out while reading `response_body`. At that time the HTTP status was lost. That event did not prove OAuth loss or an entitlement refusal.
2. **Job `9c892143-8d36-4ed3-9c29-a048bd06f717`:** total about 2.4 s; worker claim 0 s, binding check 0.03 s, session check/refresh 0.8 s, `/profile` 1.52 s. It returned HTTP 400 with the purchase message. This is a fast HTTP response, not the earlier timeout.
3. **Latest status probe:** again reports HTTP 400 `no_entitlement` on `/profile`, no transport timeout, active binding, and no saved profile. The pasted JSON itself does not include per-stage timings or a job ID.

Never combine the 60-second timeout with the fast HTTP 400 into one root-cause claim. They are different attempts and different observed outcomes.

## What is supported, and what remains unproven

### Supported by current evidence

- The immediate blocker is Frontier CAPI failing to provide `/profile` data with a purchase/entitlement response.
- The site configuration visible in the diagnostic is internally consistent. OAuth scope is `auth capi`; the link is active and has a refresh token.
- This is not currently classified as a rejected/expired OAuth credential. Reauthorizing repeatedly is not justified by the latest evidence.
- `requestedPlatform` is absent because the manual sync/status-probe job has no saved OAuth audience. It is job metadata, not a reliable audit of the earlier Epic login.
- The app fix that keeps entitlement refusals from disabling OAuth is already merged. PR #185 corrected the false OAuth diagnosis/reauthorization loop; PR #186 clarified that an omitted job platform is not an “Auto” selection.

### Strong lead, not a proven account-specific diagnosis

Frontier issue [#21258: Epic Games Store commanders having troubles with cAPI](https://issues.frontierstore.net/issue-detail/21258) describes EGS cases where OAuth/identity checks can work while CAPI profile or journal requests fail. This is a strong match for the symptom, but it does not prove that Frontier has the same internal cause for this specific commander, nor that the issue tracker contains a current fix. Do not present the upstream diagnosis as confirmed until Frontier confirms it or a controlled comparison isolates it.

The HTTP 400 body alone also cannot distinguish an upstream EGS identity/entitlement defect from a genuine entitlement/account mapping problem inside Frontier. The user's repeated checks make another generic login checklist inappropriate; only Frontier's server-side account/entitlement records can conclusively distinguish those cases.

## Existing code behavior and an important diagnostic blind spot

- The website owns Frontier OAuth, refresh tokens, and CAPI requests. Colonial Helper uses the project's API token and uploads local Journal files; it must not create a second Frontier OAuth binding or receive Frontier tokens. See [CAPI-SITE-OWNERSHIP.md](CAPI-SITE-OWNERSHIP.md).
- `CapiClient.getProfile()` tries Live `/profile` first. On HTTP 400/404 it also tries `legacy-companion.orerve.net/profile`. If Legacy fails, it deliberately rethrows the original Live error. Therefore the current diagnostic's `host=companion.orerve.net` records the surfaced Live error; it **does not tell us what Legacy returned**. The Legacy fallback is an existing candidate path, not a confirmed workaround. Instrument its outcome before claiming it was successful or ineffective.
- The current generic error text still asks the user to launch the game and re-check linked accounts, despite those checks already having been repeated. Improve the EGS/no-entitlement copy so it states the binding is retained, avoids another login loop, and offers useful escalation/fallback information instead of recycling those steps.
- Normalize the Frontier HTML response to safe plain text for display (strip tags / decode a constrained set of entities); retain status and endpoint. Never inject the returned HTML into the page.

## Candidate workarounds to investigate later — not yet confirmed

These are investigation paths, not instructions already proven to solve this account:

1. **Observe the existing Live → Legacy fallback.** Add server-side, secret-free diagnostics for each host attempt (host, status, error kind, bounded/sanitized body, duration). Do not expose access/refresh tokens or make repeated rapid probes. If Legacy succeeds where Live fails, use that evidence to consider a narrowly scoped fallback; if it fails identically, record that as evidence against this route.
2. **Compare the same website-owned session's identity and CAPI result.** Capture sanitized `/me` or `/decode` identity, refresh outcome, and Live/Legacy `/profile` responses in one request trace. Do not ask the user to send tokens, cookies, or an unredacted diagnostic. The current probe has already established the visible Live 400; the missing piece is the fallback outcome and a clear per-stage trace.
3. **Use local Journal data for a partial profile where possible.** Colonial Helper already uploads Journal events independently of CAPI. Audit which fields can be reconstructed reliably (for example commander/FID, location, rank/progress, ship/loadout, and credits) from event types and real fixtures. Mark provenance and freshness, and never imply this is a complete/live CAPI profile. Keep the site as the only CAPI OAuth owner.
4. **Evaluate third-party data sources only after a field/permission audit.** EDSM, Inara, or community feeds may cover some public or user-authorized data, but no substitute has been verified here. Check API terms, credentials/consent, field coverage, freshness, and identity matching before designing an integration. Do not assume public feeds contain private commander profile data.
5. **Escalate to Frontier with a focused server-side report.** Include UTC timestamp, Frontier commander ID privately to their support, token identity platform, scope, endpoint/host, HTTP 400 and exact response, and state that OAuth/refresh are active. Reference issue #21258. Never include access or refresh tokens. Ask Frontier to verify EGS ownership/identity mapping and CAPI entitlement for that Frontier account, rather than asking the user to repeat login steps.

## Guardrails for the next session

- Do not re-open the Epic login/linking checklist unless new evidence specifically contradicts the user's report.
- Do not interpret `platform=frontier` or an absent job `requestedPlatform` as proof of a wrong login.
- Do not turn an entitlement 400 or a timeout into an OAuth revocation. Only a confirmed token/refresh rejection belongs in the reauthorization path.
- Do not claim that changing the OAuth audience, repeatedly refreshing, relinking, waiting a fixed number of days, or using Legacy solves this specific case without a measured result. The issue tracker is not evidence of a confirmed current fix.
- The current account has no stored profile, so a fallback should be explicit and partial rather than silently returning fabricated or stale values.

## Relevant code and test locations

- `src/lib/capi/client.ts` — Live and Legacy request behavior; inspect fallback observability.
- `src/lib/capi/failure.ts`, `src/lib/capi/entitlement.ts`, `src/lib/capi/syncPilot.ts` — entitlement classification and keeping OAuth active.
- `src/app/api/capi/status/route.ts` — live diagnostic probe; it currently exposes the surfaced failure, not a complete host-by-host trace.
- `src/app/account/capi/page.tsx`, `src/lib/capi/messages.ts` — user-facing guidance and safe display of remote error text.
- `scripts/tests/capi-entitlement.test.mjs`, `scripts/tests/capi-page.test.mjs`, `scripts/tests/capi-journal.test.mjs` — regression coverage.
