# lynkeus documentation

The documentation site, built with [Starlight](https://starlight.astro.build). English pages are in
`src/content/docs/`, Spanish ones in `src/content/docs/es/`. The two are written separately, each for its
own reader: a page in one language is not a translation of the other.

```bash
npm install
npm run dev      # the site, reloading as pages change
npm run build    # the static site, into dist/
```

Needs Node 22 or newer.

## Versions

The header shows the version in `packages/cli/package.json`, and the site is built for publishing when a
release is tagged, so what is online describes what `npm install` gives. A feature added after the first
release says so where it is documented (`Since 0.3.0`, `Desde 0.3.0`). `npm run check-versions` fails when a
page names a version later than the one being released; the release build runs it.
