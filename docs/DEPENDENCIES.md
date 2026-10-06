# Dependency selection

Checked on 2026-09-12. Node 24.21.0 is the selected LTS runtime. The preexisting Node 20 installation was not used for verification. Official references consulted:

- [Node release status](https://nodejs.org/en/about/previous-releases)
- [Vite getting started and Node requirements](https://vite.dev/guide/)
- [React versions](https://react.dev/versions)
- [Express installation/version requirements](https://expressjs.com/en/starter/installing/)

Stable packages were resolved from the package registry, rather than copying source-repository pins. Exact direct/transitive resolutions are in package.json/package-lock.json. Selected major versions: React 19, Vite 8, Express 5, TypeScript 6, Tailwind 4, postgres.js 3, Dexie 4, Zod 4. A clean offline `npm ci`, typecheck and production build were exercised locally.

postgres.js 3.4.8's TransactionSql declaration loses its tagged-template call signature through Omit. `server/db.ts` adds the query signature to the transaction interface; it does not introduce a second connection or privileged fallback. Database behavior was tested against the restricted runtime role.

The production build explicitly sets NODE_ENV=production. Without that, a shared local `.env` with NODE_ENV=development caused development React to be bundled and service-worker registration to be omitted. Bundle chunks separate React, validation, IndexedDB and application code.

`qrcode.react` 4.2.0 (pinned exact) was added by the lead before wave 2 (LD-4, commit `a3bd8e3`) for cfdi's self-invoice QR and, in wave 3, public ordering's table QR codes. Its peer range is `react ^16.8 || ^17 || ^18 || ^19` (this repository pins React 19.2.7); consumers use the named export `QRCodeSVG` (`QRCodeCanvas` also exists) with `value`, `size`, `level`, `marginSize` (replaces the deprecated `includeMargin`) and `title` for accessibility. Wave-2 tracks never run `npm install`.
