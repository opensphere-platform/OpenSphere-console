import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const publisher = readFileSync(`${root}/scripts/Publish-LocalEdgeOsaaChat.ps1`, 'utf8');

test('OSAA chat publisher is an exact Console and Gateway component path', () => {
  assert.match(publisher, /exactAffectedComponentSet=@\('console','osaaGateway'\)/);
  assert.match(publisher, /affectedImages=@\(\$consoleRepository,\$gatewayRepository\)/);
  assert.match(publisher, /unchangedComponentBuildCount=0/);
  assert.match(publisher, /allAffectedImagesBuiltBeforeChannelMove=\$true/);
  assert.doesNotMatch(publisher, /Publish-LocalEdge[.]ps1/);
});

test('both images verify before either edge channel moves', () => {
  const consoleBuild = publisher.indexOf('--metadata-file $consoleMetadata');
  const gatewayBuild = publisher.indexOf('--metadata-file $gatewayMetadata');
  const consoleVerification = publisher.indexOf('Assert-ImageMetadata -Repository $consoleRepository');
  const gatewayVerification = publisher.indexOf('Assert-ImageMetadata -Repository $gatewayRepository');
  const firstTagMove = publisher.indexOf('Set-RemoteTag -Repository $consoleRepository');
  assert.ok(consoleBuild >= 0 && gatewayBuild > consoleBuild);
  assert.ok(consoleVerification > gatewayBuild && gatewayVerification > consoleVerification);
  assert.ok(firstTagMove > gatewayVerification);
});

test('publisher binds canonical clean main, local edge authority, and exact digests', () => {
  assert.match(publisher, /branch --show-current/);
  assert.match(publisher, /rev-parse refs\/remotes\/origin\/main/);
  assert.match(publisher, /--platform linux\/amd64 --push --provenance=mode=max/);
  assert.match(publisher, /opensphere[.]io\/build-authority=localhost/);
  assert.match(publisher, /opensphere[.]io\/release-class=pre-ga/);
  assert.match(publisher, /opensphere[.]io\/ga-eligible=false/);
  assert.match(publisher, /@sha256:\[a-f0-9\]\{64\}/);
});
