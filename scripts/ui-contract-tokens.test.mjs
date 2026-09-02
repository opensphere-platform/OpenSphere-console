import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const contractSource = await readFile(new URL('../src/ui-contract.scss', import.meta.url), 'utf8');
const angularConfig = JSON.parse(await readFile(new URL('../angular.json', import.meta.url), 'utf8'));
const designKitFixture = JSON.parse(await readFile(
  new URL('../packages/contracts/fixtures/design-kit-type-token-consumer-v1.json', import.meta.url),
  'utf8',
));

const expectedValues = new Map([
  ['--os-ui-contract-id', '"opensphere.ui"'],
  ['--os-ui-contract-version', '"1.0"'],
  ['--os-type-display-size', '42px'],
  ['--os-type-display-weight', '300'],
  ['--os-type-display-line-height', '1.2'],
  ['--os-type-display-tracking', '0'],
  ['--os-type-headline-size', '32px'],
  ['--os-type-headline-weight', '400'],
  ['--os-type-headline-line-height', '1.25'],
  ['--os-type-headline-tracking', '0'],
  ['--os-type-title-size', '20px'],
  ['--os-type-title-weight', '600'],
  ['--os-type-title-line-height', '1.4'],
  ['--os-type-title-tracking', '0'],
  ['--os-type-body-size', '14px'],
  ['--os-type-body-weight', '400'],
  ['--os-type-body-line-height', '1.43'],
  ['--os-type-body-tracking', '0.16px'],
  ['--os-type-body-strong-weight', '600'],
  ['--os-type-caption-size', '12px'],
  ['--os-type-caption-weight', '400'],
  ['--os-type-caption-line-height', '1.33'],
  ['--os-type-caption-tracking', '0.32px'],
]);

function tokenValue(source, token) {
  const match = source.match(new RegExp(`${token.replaceAll('-', '\\-')}\\s*:\\s*([^;]+);`));
  return match?.[1].trim();
}

test('Main Shell publishes the documented opensphere.ui/1.0 type values', () => {
  for (const [token, expected] of expectedValues) {
    assert.equal(tokenValue(contractSource, token), expected, token);
  }
});

test('Main Shell supplies every semantic type variable in the pinned Design Kit fixture', () => {
  assert.equal(designKitFixture.contractId, 'opensphere.ui');
  assert.equal(designKitFixture.contractVersion, '1.0');
  assert.match(designKitFixture.source.revision, /^[0-9a-f]{40}$/u);
  assert.match(designKitFixture.source.sha256, /^[0-9a-f]{64}$/u);
  assert.ok(designKitFixture.consumedVariables.length > 0, 'Design Kit fixture must declare consumed variables');
  assert.deepEqual(
    designKitFixture.consumedVariables,
    [...new Set(designKitFixture.consumedVariables)].sort(),
    'Design Kit fixture variables must be unique and sorted',
  );
  for (const token of designKitFixture.consumedVariables) {
    assert.ok(tokenValue(contractSource, token), `${token} is missing from Main Shell`);
  }
});

test('Angular loads the Main Shell UI contract as a global stylesheet', () => {
  const styles = angularConfig.projects['opensphere-console'].architect.build.options.styles;
  assert.ok(styles.includes('src/ui-contract.scss'));
  assert.ok(styles.indexOf('src/ui-contract.scss') > styles.indexOf('src/styles.scss'));
});
