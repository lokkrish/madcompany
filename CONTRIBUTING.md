# Contributing

Thanks for helping. Storyfront is plain Node (ESM, no build step).

```bash
npm install
npm test                               # node --test, about 5 seconds
node bin/storyfront.js demo /tmp/sf    # a sample project
cd /tmp/sf && node <repo>/bin/storyfront.js hq
```

- **Rules live in code.** Anything the spec says must always happen (dependencies, review by someone else, attempt limits, the deny list) belongs in `src/hq/core.js` or `src/hook.js`, with a test, not just in a prompt.
- **Keep agent-facing text short.** Tool descriptions and skills are read by models on every run.
- **The `.storyfront/` file formats are a public contract** (other tools read them). Change them only with a note in `CHANGELOG.md`.
- **Requirement IDs** in `docs/SPEC.md` are never renumbered. New ones go at the end of their section.
- The UI is dependency-free vanilla JS in `ui/`. Check light and dark mode and a narrow window.

Open an issue before a large change so we can agree on the approach.
