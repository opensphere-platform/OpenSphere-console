# Console fonts

The existing Console Web image serves IBM Plex Sans (Latin), IBM Plex Sans KR
(Korean), and IBM Plex Mono (code). No external font CDN is required.

- Assets, pinned source packages, SHA-256 and license: `public/assets/fonts/`.
- Face declarations: `src/_fonts.scss`; shared UI/Mono and Clarity/Carbon family
  tokens: `src/styles.scss`. Existing font sizes and page spacing are preserved.
- Sans and Sans KR: 300/400/500/600/700. Mono: 400/600. Intermediate weights use
  CSS face matching. Synthetic weight is disabled on the normal Console UI.
- Form controls use the UI family; code, editors and highlighted text use Mono.
  Do not reintroduce `body * { font-family: ... !important }`.
- The isolated OS Shell frame embeds the same Mono files as data URLs during its
  existing build. CSP, COEP, session handling and transport permissions stay unchanged.
- `npm run build -- --configuration production` checks source and dist font
  files, hashes, face references, OFL notice and absence of Google Fonts.
- Web-only publication updates component `console`; the independent index-content
  image and API/DB/cluster resources are not part of this change.

Verification on 2026-09-06: production build, source/dist font checks and current
`verify-console-contracts.mjs` pass. The optional combined legacy Shell frontend
and index suite has 24 passing and 2 pre-existing failing checks. The failures
read Nginx API locations only from default.conf.template even though those routes
are now in target-api-routes.conf; the old checks also expect a retired admission
header and plugin-regex route. Neither Nginx file nor those checks is changed by
this font fix. This is not evidence of complete OS Shell functional acceptance.
