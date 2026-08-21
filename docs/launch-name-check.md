# npm name availability check

Checked 2026-08-21. GitHub account access is suspended so this could not be
verified there, but npm is a separate registry and was reachable directly.
Nothing was published. This is a check only.

Commands run: `npm view verit`, `npm view @verit/domain`, `npm view @verit/cli`
(a second scoped package, to probe whether the `@verit` scope itself is
claimed by anyone, not just whether `domain` is taken under it).

## Result

| Name | Status |
|---|---|
| `verit` (unscoped) | **Available.** No package registered. |
| `@verit/domain` | **Available.** No package registered, and nothing suggests the `@verit` scope is claimed by another npm user. |
| `@verit` scope | **Available**, as far as an unauthenticated `npm view` can tell. A scope itself is only definitively claimed by publishing the first package under it or registering the org; npm has no public "is this scope taken" endpoint short of that. |

Nothing was published as part of this check.

## Raw output

```
$ npm view verit
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/verit - Not found
npm error 404
npm error 404  'verit@*' is not in this registry.
npm error 404
npm error 404 Note that you can also install from a
npm error 404 tarball, folder, http url, or git url.

$ npm view @verit/domain
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/@verit%2fdomain - Not found
npm error 404
npm error 404  '@verit/domain@*' is not in this registry.
npm error 404
npm error 404 Note that you can also install from a
npm error 404 tarball, folder, http url, or git url.

$ npm view @verit/cli
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/@verit%2fcli - Not found
npm error 404
npm error 404  '@verit/cli@*' is not in this registry.
npm error 404
npm error 404 Note that you can also install from a
npm error 404 tarball, folder, http url, or git url.
```

`npm search @verit` was also run as a softer check (it hits npms.io search,
not the registry directly, and can lag or miss unlisted packages, so it is
not treated as authoritative here). It returned unrelated results
(`verit-test`, `eslint-config-verit`, both from an unrelated npm user
"voces", years old, nothing under an actual `@verit` scope), consistent with
the `npm view` results above.
