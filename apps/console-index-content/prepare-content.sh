#!/bin/sh
set -eu
test "$(cat /content/renderer-contract.txt)" = "console-index-renderer/v1"
cd /content
sha256sum -c SHA256SUMS >/dev/null
# Only this nonpersistent volume is writable; no network, credential or API use.
cp content.json renderer-contract.txt renderer-signature.txt SHA256SUMS /output/
mkdir -p /output/installation
cp installation/installation-milestones.json installation/installation-milestones.md /output/installation/
cd /output
sha256sum -c SHA256SUMS >/dev/null
printf '%s\n' 'Console index content verified and prepared.'
