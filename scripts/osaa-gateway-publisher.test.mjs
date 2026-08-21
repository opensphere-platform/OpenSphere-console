import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const publisher = readFileSync(`${root}/scripts/Publish-LocalEdgeOsaaGateway.ps1`, 'utf8');

test('OSAA Gateway publisher is exact component-only edge tooling', () => {
  assert.match(publisher, /Installed release does not contain the canonical OSAA Gateway component/);
  assert.match(publisher, /backend\/opensphere-console-osaa-gateway\/\*/);
  assert.match(publisher, /\$componentChangedPaths/);
  assert.match(publisher, /\$allChangedPaths/);
  assert.doesNotMatch(publisher, /component scope contains unsupported paths/);
  assert.match(publisher, /affectedImages=@\(\$repository\)/);
  assert.match(publisher, /exactAffectedComponentSet=@\('osaaGateway'\)/);
  assert.match(publisher, /unchangedComponentBuildCount=0/);
  assert.match(publisher, /extension-presentation\.test\.js/);
  assert.match(publisher, /r2d2-prompt-boundary\.test\.js/);
  assert.doesNotMatch(publisher, /Publish-LocalEdge[.]ps1/);
});

test('publisher binds clean canonical main and exact digest tags', () => {
  assert.match(publisher, /branch --show-current/);
  assert.match(publisher, /rev-parse refs\/remotes\/origin\/main/);
  assert.match(publisher, /--provenance=mode=max/);
  assert.match(publisher, /--label opensphere\.io\/build-authority=localhost/);
  assert.match(publisher, /--label opensphere\.io\/release-class=pre-ga/);
  assert.match(publisher, /--label opensphere\.io\/ga-eligible=false/);
  assert.doesNotMatch(publisher, /opensphere\.io\.release-class/);
  assert.doesNotMatch(publisher, /opensphere\.io\.ga-eligible/);
  assert.match(publisher, /Set-RemoteTag -Repository \$repository -Digest \$digest -Tag \$releaseTag -Immutable/);
  assert.match(publisher, /Set-RemoteTag -Repository \$repository -Digest \$digest -Tag edge/);
});
