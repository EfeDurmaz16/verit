# Verit domain language

| Term | Meaning |
|---|---|
| Understanding | Canonical what/why/how JSON (+ proof_refs, risks, out_of_scope) |
| ReviewDomain | Closed enum of review specialties (not tech stacks) |
| Focus | Optional second lens; must differ from primary domain |
| Proof page | json-render Spec within fixed catalog, primary human surface |
| GraphStore | Neo4j ontology + PR/git memory |
| DocumentStore | SQLite runs, proof blobs, FTS |
| skill_pack_hash | Content hash of compiled pack |
| author risks | Hints only. Never allowlist for reviewers |
| prove | Run the reviewed repo's own verification command; refuses any other checkout |
| ProofRef status | Verdict of an executed ref: `pass`/`fail`; absent means nothing was run |
| behavior-proof Check | `verit / behavior-proof` Check Run; neutral when no proof ran |
