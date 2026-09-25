# Contributing

Thanks for helping. madcompany is plain Node (ESM, no build step).

```bash
npm install
npm test                               # node --test, about 5 seconds
node bin/madcompany.js demo /tmp/mc-demo    # a sample project
cd /tmp/mc-demo && node <repo>/bin/madcompany.js hq
```

- **Rules live in code.** Anything the spec says must always happen (dependencies, review by someone else, attempt limits, the deny list) belongs in `src/hq/core.js` or `src/hook.js`, with a test, not just in a prompt.
- **Keep agent-facing text short.** Tool descriptions and skills are read by models on every run.
- **The `.madcompany/` file formats are a public contract** (other tools read them). Change them only with a note in `CHANGELOG.md`.
- **Requirement IDs** in `docs/SPEC.md` are never renumbered. New ones go at the end of their section.
- The UI is dependency-free vanilla JS in `ui/`. Check light and dark mode and a narrow window.

Open an issue before a large change so we can agree on the approach.

## Releasing

For maintainers. Releases are published from GitHub Actions (`.github/workflows/release.yml`), never from a laptop.

1. On `main`, add a `## X.Y.Z (YYYY-MM-DD)` section at the top of `CHANGELOG.md` and commit it.
2. `npm version X.Y.Z` (or `patch`, `minor`, `major`). This bumps `package.json` and `package-lock.json`, commits, and tags `vX.Y.Z`.
3. `git push --follow-tags`

The `release` workflow then checks that the tag, `package.json` and `CHANGELOG.md` agree and that the tag is on `main`, runs the tests, publishes to npm and creates the GitHub Release with that changelog section as its notes. A prerelease such as `1.2.0-beta.1` goes to npm's `next` tag, so `npx madcompany` keeps installing the last stable version.

You can also release from the browser: after step 1 and a commit that bumps the version in `package.json` and `package-lock.json`, open **Actions → release → Run workflow** and enter the new tag. It tags the head of `main` once the tests pass.

If a release fails, fix the cause and run it again the same way with the tag. A version that's already on npm is never published twice.

**One-time setup:** npm has to trust the workflow. On npmjs.com, open the package's **Settings → Trusted Publisher**, choose **GitHub Actions** and enter user `lokkrish`, repository `madcompany`, workflow `release.yml`, with no environment. Then, under **Publishing access**, choose **Require two-factor authentication and disallow tokens**, so only the workflow (or a maintainer with 2FA) can publish.
