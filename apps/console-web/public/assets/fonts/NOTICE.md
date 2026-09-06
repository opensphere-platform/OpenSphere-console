# Console font asset notice

Console bundles unmodified IBM Plex WOFF2 files from the official version-pinned npm packages.
Upstream: https://github.com/IBM/plex. License: SIL Open Font License 1.1 (OFL-LICENSE.txt).
No font CDN, system installation, runtime package download, or sibling-repository mount is used.
Assets and this notice ship in the existing Console Web image under /assets/fonts/.

UI: IBM Plex Sans for Latin and IBM Plex Sans KR for Korean, weights 300/400/500/600/700.
Code: IBM Plex Mono, weights 400/600; unsupported intermediate weights match the nearest face.
These are existing UI weights, not a new type scale. Existing font sizes/spacing are unchanged.
Unlike the website ConfigMap transport, the Console image has no 1 MiB ConfigMap limit;
therefore Korean Light/Medium are also included. Only requested faces download in the browser.
Fallbacks are system-ui/Segoe UI for UI, Cascadia Code/Consolas for code. All faces use swap.
The isolated OS Shell frame embeds the same two Mono files as data URLs to retain its opaque
origin and existing CSP/COEP policies without granting new network or authentication access.

## Provenance

The ten shared assets were verified against the workspace website's pinned source hashes.
KR Light/Medium were extracted from @ibm/plex-sans-kr@1.1.0 after verifying the npm
package SHA-512 integrity. Files are not modified or subsetted. manifest.json records the
package path, weight, byte count and SHA-256 for every distributed file.

| File | Weight | Package | Original path | SHA-256 | Bytes |
| --- | --- | --- | --- | --- | --- |
| `IBMPlexMono-Regular.woff2` | 400 | `@ibm/plex-mono@2.5.0` | `fonts/complete/woff2/IBMPlexMono-Regular.woff2` | `ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350` | 49248 |
| `IBMPlexMono-SemiBold.woff2` | 600 | `@ibm/plex-mono@2.5.0` | `fonts/complete/woff2/IBMPlexMono-SemiBold.woff2` | `6a825b4824c01cbb401e829e5a066a1818411bcb3538b5a5792c5ca9b82343c3` | 50600 |
| `IBMPlexSans-Light.woff2` | 300 | `@ibm/plex-sans@1.1.0` | `fonts/complete/woff2/IBMPlexSans-Light.woff2` | `769209c2a0dbf2e3f012c22e4c604100cb3f1e7b8beb0ef77bc7d982d85509cc` | 66356 |
| `IBMPlexSans-Regular.woff2` | 400 | `@ibm/plex-sans@1.1.0` | `fonts/complete/woff2/IBMPlexSans-Regular.woff2` | `ba711a3085ff9f27440b6b9c4550cfc47c97bf36591d5da958b975bb3add8c1a` | 63020 |
| `IBMPlexSans-Medium.woff2` | 500 | `@ibm/plex-sans@1.1.0` | `fonts/complete/woff2/IBMPlexSans-Medium.woff2` | `5660f8a658f8bb50dbc005232f885eadffd2bc1c235c4f6fbb63469d1f9cde6d` | 66740 |
| `IBMPlexSans-SemiBold.woff2` | 600 | `@ibm/plex-sans@1.1.0` | `fonts/complete/woff2/IBMPlexSans-SemiBold.woff2` | `f78048030eab62e860efa39a0df79e2e5581bf122eb95b9bc42c0b8a4988d205` | 67060 |
| `IBMPlexSans-Bold.woff2` | 700 | `@ibm/plex-sans@1.1.0` | `fonts/complete/woff2/IBMPlexSans-Bold.woff2` | `fa7130d854a660b39a7fc9e6e0f2dc23dba5f1346e2adea3e1fe37b6d884133d` | 63012 |
| `IBMPlexSansKR-Light.woff2` | 300 | `@ibm/plex-sans-kr@1.1.0` | `fonts/complete/woff2/hinted/IBMPlexSansKR-Light.woff2` | `e227d5dd1654f0b2b0ad987369c165b11b295fca2a70c08deda56e52cde24e3f` | 432372 |
| `IBMPlexSansKR-Regular.woff2` | 400 | `@ibm/plex-sans-kr@1.1.0` | `fonts/complete/woff2/hinted/IBMPlexSansKR-Regular.woff2` | `055a35664c3c3965161c92292504c5633ba9604ec904edc1ed799bf2a436276d` | 438540 |
| `IBMPlexSansKR-Medium.woff2` | 500 | `@ibm/plex-sans-kr@1.1.0` | `fonts/complete/woff2/hinted/IBMPlexSansKR-Medium.woff2` | `c00dcd8a9c32a6b6ab8c6b3119e68b3d7aa6eba6f4441d5493019cc019dcdd1e` | 439816 |
| `IBMPlexSansKR-SemiBold.woff2` | 600 | `@ibm/plex-sans-kr@1.1.0` | `fonts/complete/woff2/hinted/IBMPlexSansKR-SemiBold.woff2` | `5ad7db28ba74d59fe14c260205c62ddb701320f4f098d8a45ef2757bebc29666` | 434484 |
| `IBMPlexSansKR-Bold.woff2` | 700 | `@ibm/plex-sans-kr@1.1.0` | `fonts/complete/woff2/hinted/IBMPlexSansKR-Bold.woff2` | `cf874a368dc2c2c0e4d1933c35611b849e48942023bfdd1fa11128475dbc4860` | 370492 |

Total: 12 files, 2,541,740 bytes.
