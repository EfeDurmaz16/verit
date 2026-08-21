# What verit does not have yet

Written 2026-08-21. This page exists so no other page has to imply a control
verit does not hold. If something here changes, change it here first and date
it.

verit is early. The pieces that decide a verdict are real and run in this
repository's own CI on every pull request. The enterprise and compliance
controls below are not built. None of them are claimed anywhere in these docs.

## No certifications

- **No SOC 2.** verit has not completed a SOC 2 Type I or Type II audit and
  holds no SOC 2 report.
- **No ISO 27001** or any other third-party security certification.
- **No penetration test report** from an external firm to share.

If you receive a document that appears to show a verit certification, it is not
genuine. verit holds none as of the date above.

## No enterprise auth

- **No SSO / SAML.** Sign-in is GitHub OAuth only.
- **No SCIM** user provisioning.
- **No verit-side roles.** Access is derived from GitHub repo read access, not a
  separate permission model inside verit.

## No audit log

- There is **no access audit log**. The dashboard does not record who viewed
  which run. Access is enforced per request, but views are not logged for later
  review.
- There is no admin activity log beyond the operational commands in the runbook.

## Operational maturity

- The hosted dashboard works but has had one operator. Treat its setup docs as a
  first draft, as the README already says.
- There is **no formal uptime SLA** and no status page.
- Retention and erasure are implemented and tested, but have not been exercised
  at scale.

## What is real today

So this page is not read as "nothing works": the verdict path, the honest
`neutral` behavior, the Understanding schema and its validation, the GitHub
Action, the CLI, the live workspace, secret redaction before upload, scheduled
retention, on-demand erasure, and ingest-token revocation are all built and
covered by tests. The gaps above are about enterprise and compliance controls,
not about whether the review itself works.
