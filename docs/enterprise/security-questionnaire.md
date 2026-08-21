# Security questionnaire, stock answers

Answers to the questions vendors are usually asked. Written 2026-08-21. Where an
answer would imply a control verit does not have, it says so plainly. Nothing
here claims a certification verit does not hold. See
[`not-yet.md`](not-yet.md) for the explicit gap list.

## Company and product

**What does the product do?**
Reviews pull requests and posts a single GitHub Check that runs the repository's
own tests and reports the true result. It never claims a change is proven when
it is not.

**Is it self-hostable?**
Yes, and that is the default. Self-hosted, no data leaves your CI except the
review prompt to a model provider on your own account. The hosted dashboard is
optional.

## Data handling

**What customer data do you store?**
In hosted mode only: pull request metadata, the model's Understanding of a
change, the verdict, and the prove logs. See [`../data.md`](../data.md) for the
field list. In self-hosted mode verit stores nothing off your infrastructure.

**Do you store credentials or secrets?**
Ingest tokens are stored only as sha256 hashes. The signed-in user's GitHub
token is never written to the database; it lives only in a sealed browser
cookie. Prove logs pass through secret redaction before upload.

**Do you store source code?**
No. verit stores metadata, an Understanding, and prove logs. It does not store a
copy of your repository.

**Where is data stored, and in which regions?**
Neon Postgres and Cloudflare R2, in the region you choose when you provision
them. verit does not pin a region for you.

**How long is data retained?**
Prove logs for 30 days, run rows for 12 months, both from upload, enforced by a
scheduled deletion job. A repo's data can be erased on demand.

**Can we request deletion?**
Yes. `DELETE /api/repos/{owner}/{repo}` erases a repo's run rows and logs.

## Access control

**How is access to customer data controlled?**
Every run page and log is gated by GitHub read access to the repo it belongs to,
re-checked against GitHub on a short TTL. A user cannot see a repo they cannot
read on GitHub.

**Do you support SSO / SAML?**
Not today. Sign-in is GitHub OAuth only. See [`not-yet.md`](not-yet.md).

**Do you have role-based access control?**
Access is derived from GitHub repo read access, not a separate role model inside
verit. There is no verit-side admin role beyond that.

**Is there an audit log of access?**
Not today. See [`not-yet.md`](not-yet.md).

## Infrastructure and encryption

**Is data encrypted in transit?**
Yes. All traffic is HTTPS. The S3 client signs each request and puts the body
hash inside the signature, so an altered upload is rejected by the store.

**Is data encrypted at rest?**
Neon and Cloudflare R2 encrypt at rest as platform defaults. The session cookie
is additionally sealed with AES-256-GCM.

**Who are your subprocessors?**
GitHub, Neon, Vercel, Cloudflare R2, and the model provider you configure. Self
hosting removes all but the model provider. See the README subprocessor list.

## Development and operations

**Is the source auditable?**
Yes. verit is open source under AGPL-3.0. You can read every line that decides a
verdict.

**How do you handle a security report?**
Email efe@sardis.sh, not the issue tracker. See
[`../../SECURITY.md`](../../SECURITY.md).

**Do you have an incident runbook?**
Yes. [`../runbook.md`](../runbook.md) covers a false green, a store outage,
secret rotation, token revocation, and a provider outage.

**Do you hold SOC 2, ISO 27001, or similar?**
No. verit holds no third-party security certification today. This is stated
plainly and is not implied anywhere. See [`not-yet.md`](not-yet.md).

## Compliance

**Do you sign a DPA?**
A template is provided at [`dpa-template.md`](dpa-template.md). It is a starting
point for your legal review, not executed boilerplate.

**Are you a data processor or controller?**
For hosted-mode customer data, verit acts as a processor: it stores what your
Action uploads, on your instruction, and deletes it on schedule or on request.
