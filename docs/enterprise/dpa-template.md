# Data Processing Addendum (template)

This is a starting template, not an executed agreement, and not legal advice.
Have your own counsel review and adapt it. Bracketed fields are placeholders.
It describes the hosted dashboard only; self-hosted verit stores no data off
your infrastructure and needs no DPA for that data.

This Addendum is entered into by [CUSTOMER LEGAL NAME] ("Customer", the
controller) and [PROVIDER LEGAL NAME] ("Provider", the processor) and forms part
of the agreement between them for use of the verit hosted dashboard (the
"Service").

## 1. Definitions

Terms such as "personal data", "processing", "controller", "processor", and
"data subject" have the meanings given in the applicable data protection law
[e.g. GDPR / UK GDPR / other]. "Customer Data" means the data the Customer's
GitHub Action uploads to the Service.

## 2. Roles

The Customer is the controller of Customer Data. The Provider is a processor and
processes Customer Data only to provide the Service and only on the Customer's
documented instructions, including those set out in this Addendum.

## 3. Scope of processing

- **Subject matter:** storing and displaying pull request review runs.
- **Duration:** for the term of the agreement, subject to the retention section.
- **Nature and purpose:** receiving uploaded run data, storing it, enforcing
  access to it, and deleting it on schedule or on request.
- **Categories of data:** pull request metadata (numbers, titles, URLs, author
  logins), a model-generated Understanding of a change, verdicts, and prove
  logs. Prove logs are redacted for common secret shapes before upload.
- **Categories of data subjects:** the Customer's developers whose GitHub logins
  and pull request activity appear in the above.
- **Data not processed:** the Service does not store a copy of source code, raw
  ingest tokens (only hashes), or users' GitHub tokens (held only in a sealed
  session cookie).

## 4. Instructions

The Provider processes Customer Data only on the Customer's instructions. The
Provider will tell the Customer if, in its view, an instruction breaches
applicable data protection law.

## 5. Confidentiality

The Provider ensures that anyone authorized to process Customer Data is bound by
confidentiality.

## 6. Security measures

The Provider maintains, at minimum:

- Encryption of Customer Data in transit (HTTPS) and at rest (platform defaults
  of Neon and Cloudflare R2).
- Access to run data gated by GitHub repository read access, re-checked against
  GitHub on a short interval.
- Ingest tokens stored only as sha256 hashes, compared in constant time, with a
  revocation path.
- Secret redaction of prove logs before storage.
- Session cookies sealed with AES-256-GCM.

The Customer acknowledges the current control gaps stated in `not-yet.md`,
including no SOC 2, no SSO, and no access audit log, as of its stated date.

## 7. Subprocessors

The Customer authorizes these subprocessors:

| Subprocessor | Purpose |
|---|---|
| GitHub | Source of pull requests and repository read-access decisions |
| Neon | Postgres hosting of run metadata |
| Vercel | Dashboard hosting |
| Cloudflare R2 | Object storage of prove logs |
| [MODEL PROVIDER] | Runs the review model, on the Customer's configured account |

The Provider will give the Customer [NOTICE PERIOD, e.g. 30 days] notice before
adding or replacing a subprocessor, during which the Customer may object.

## 8. Data subject requests

The Provider will assist the Customer in responding to data subject requests. As
the data is keyed by repository, the Customer can erase a repository's data at
any time with `DELETE /api/repos/{owner}/{repo}`.

## 9. Retention and deletion

- Prove logs are deleted 30 days after upload.
- Run rows are deleted 12 months after upload.
- On the Customer's request, or on termination, the Provider deletes the
  Customer's stored run data. Backups, if any, age out on their own cycle within
  [BACKUP WINDOW].

## 10. Personal data breach

The Provider will notify the Customer without undue delay, and in any case within
[NOTIFICATION WINDOW, e.g. 72 hours], after becoming aware of a personal data
breach affecting Customer Data, with the information the Customer needs to meet
its own obligations.

## 11. International transfers

Where Customer Data is transferred across borders, the parties will rely on a
lawful transfer mechanism [e.g. Standard Contractual Clauses], incorporated by
reference.

## 12. Audit

The Provider will make available information reasonably necessary to demonstrate
compliance with this Addendum. The Provider does not hold a SOC 2 or equivalent
report as of the date of this template; the parties will agree a proportionate
audit approach in its absence.

## 13. Return and deletion on termination

On termination the Provider deletes Customer Data per the retention section
unless law requires otherwise.

## 14. Order of precedence

If this Addendum conflicts with the agreement on the processing of personal
data, this Addendum controls.

Signed:

[CUSTOMER] ____________________  Date ____________

[PROVIDER] ____________________  Date ____________
