const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const consoleRoot = path.join(__dirname, '..', '..');
const gaWorkflow = fs.readFileSync(path.join(consoleRoot, '.github', 'workflows', 'publish-ga-images.yml'), 'utf8');
const angularConfig = JSON.parse(fs.readFileSync(path.join(consoleRoot, 'angular.json'), 'utf8'));
const localEdgePublisher = fs.readFileSync(path.join(consoleRoot, 'scripts', 'Publish-LocalEdge.ps1'), 'utf8');
const osShellDeployer = fs.readFileSync(path.join(consoleRoot, 'scripts', 'Deploy-LocalEdgeOsShell.ps1'), 'utf8');
const consoleDockerfile = fs.readFileSync(path.join(consoleRoot, 'Dockerfile'), 'utf8');
const osShellControlDockerfile = fs.readFileSync(path.join(consoleRoot, 'backend', 'os-shell-control', 'Dockerfile'), 'utf8');
const osShellControlManifest = fs.readFileSync(path.join(consoleRoot, 'backend', 'os-shell-control', 'deploy.yaml'), 'utf8');
const consoleBackendManifest = fs.readFileSync(path.join(consoleRoot, 'backend', 'opensphere-console-backend', 'deploy.yaml'), 'utf8');
const nginx = fs.readFileSync(path.join(consoleRoot, 'nginx', 'default.conf.template'), 'utf8');
const setupSourceLock = fs.readFileSync(
  path.join(consoleRoot, 'backend', 'opensphere-console-backend', 'setup-source.lock'),
  'utf8'
).trim();
const sdkSourceLock = fs.readFileSync(path.join(consoleRoot, 'sdk-source.lock'), 'utf8').trim();

test('GA is rebuilt by a manual GitHub workflow and never publishes edge', () => {
  assert.match(gaWorkflow, /^\s*workflow_dispatch:\s*$/m);
  assert.doesNotMatch(gaWorkflow, /^  push:/m);
  assert.match(gaWorkflow, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(gaWorkflow, /io\.opensphere\.channel=ga/);
  assert.match(gaWorkflow, /opensphere\.io\/build-authority=github-actions/);
  assert.match(gaWorkflow, /opensphere\.io\/release-class=ga/);
  assert.match(gaWorkflow, /opensphere\.io\/ga-eligible=true/);
  assert.match(gaWorkflow, /org\.opencontainers\.image\.version=\$\{\{ steps\.release\.outputs\.version \}\}/);
  assert.doesNotMatch(gaWorkflow, /crane tag [^\n]+ edge/);
  assert.match(gaWorkflow, /crane tag "\$repository@\$digest" ga/);
  assert.match(gaWorkflow, /crane tag "\$anchor_repository@\$anchor_digest" ga/);
});

test('GA channel moves only after a complete immutable Console BOM is prepared', () => {
  assert.match(gaWorkflow, /publish-ga:\s*\n\s+needs: \[publish\]/);
  assert.match(gaWorkflow, /source_tag="sha-\$\{GITHUB_SHA:0:7\}"/);
  assert.match(gaWorkflow, /release_tag="\$\(TZ=Asia\/Seoul date -d "@\$release_epoch" \+%Y%m%d%H%M\)"/);
  assert.match(gaWorkflow, /bom="\$RUNNER_TEMP\/opensphere-release-bom\.json"/);
  assert.match(gaWorkflow, /Do not move any channel tag until every immutable component was/);
  assert.match(gaWorkflow, /--argjson supportedPlatforms '\["linux\/amd64","linux\/arm64"\]'/);
  assert.match(gaWorkflow, /Advance GA with Console anchor last/);
  assert.match(sdkSourceLock, /^[a-f0-9]{40}$/);
  assert.match(gaWorkflow, /Resolve governed SDK revision/);
  assert.match(gaWorkflow, /ref: \$\{\{ steps\.sdk\.outputs\.revision \}\}/);
  assert.match(gaWorkflow, /SDK_SOURCE_REVISION=\$\{\{ steps\.sdk\.outputs\.revision \|\| github\.sha \}\}/);
});

test('Windows local edge publisher is host-native, GHCR-backed, and KST-versioned', () => {
  assert.match(localEdgePublisher, /\$env:OS -ne 'Windows_NT'/);
  assert.match(localEdgePublisher, /\$kubeContext -ne 'docker-desktop'/);
  assert.match(localEdgePublisher, /\$Platform -ne 'linux\/amd64'/);
  assert.match(localEdgePublisher, /--platform', \$Platform/);
  assert.match(localEdgePublisher, /--push/);
  assert.match(localEdgePublisher, /io\.opensphere\.channel=edge/);
  assert.match(localEdgePublisher, /io\.opensphere\.release-tag=\$releaseTag/);
  assert.match(localEdgePublisher, /org\.opencontainers\.image\.version=\$releaseTag/);
  assert.match(localEdgePublisher, /opensphere\.io\/build-authority=localhost/);
  assert.match(localEdgePublisher, /Set-RemoteTag -Repository .* -Tag \$releaseTag -Immutable/);
  assert.match(localEdgePublisher, /Set-RemoteTag -Repository .* -Tag edge/);
});

test('local edge publisher can rebuild only explicitly affected Console components', () => {
  // No component selector means the governed integrated release. An explicit
  // selector narrows the publication without weakening the full-release default.
  assert.match(localEdgePublisher, /\[string\[\]\]\$Components = @\('console', 'backend',/);
  const defaultComponents = localEdgePublisher.match(/\[string\[\]\]\$Components = @\(([^)]*)\)/)?.[1] || '';
  assert.doesNotMatch(defaultComponents, /cliArtifacts|osShellControl|osShellRuntime/);
  assert.match(localEdgePublisher, /\$auxiliaryComponentKeys = @\('cliArtifacts', 'osShellControl', 'osShellRuntime'\)/);
  assert.match(localEdgePublisher, /\$canonicalImages = @\(\$allImages \| Where-Object \{ \$_\.Key -notin \$auxiliaryComponentKeys \}\)/);
  assert.match(localEdgePublisher, /\$partialPublication = -not \$integratedPublication/);
  assert.match(localEdgePublisher, /Where-Object \{ \$requestedComponents\.Contains\(\$_.Key\) \}/);
  assert.match(localEdgePublisher, /OpenSphereEdgeComponentPublication/);
  assert.match(localEdgePublisher, /ValidateSet\('console', 'cliArtifacts', 'osShellControl', 'osShellRuntime', 'backend'/);
  assert.match(localEdgePublisher, /Key = 'cliArtifacts'; Image = 'opensphere-os-cli'/);
  assert.match(localEdgePublisher, /Key = 'osShellControl'; Image = 'opensphere-console-os-shell-control'/);
  assert.match(localEdgePublisher, /Image = 'opensphere-console-os-shell-control'; Context = \(Join-Path \$consoleCheckout 'backend'\)/);
  assert.match(localEdgePublisher, /backend\\os-shell-control\\Dockerfile/);
  assert.match(osShellControlDockerfile, /COPY os-shell-control\//);
  assert.match(osShellControlDockerfile, /COPY opensphere-console-backend\/os-shell-contract\.js/);
  assert.match(osShellControlDockerfile, /opensphere-console-backend\/os-shell-admission\.js/);
  assert.match(consoleDockerfile, /COPY OpenSphere-console\/nginx \.\/nginx/);
  assert.match(localEdgePublisher, /Key = 'osShellRuntime'; Image = 'opensphere-os-shell-runtime'/);
  assert.match(localEdgePublisher, /backend\\os-cli\\Dockerfile\.runtime/);
  assert.match(localEdgePublisher, /docker cp "\$\{cliEvidenceContainer\}:\/srv\/index\.json"/);
  assert.match(localEdgePublisher, /opensphere-cli-local-dev-v1/);
  assert.match(localEdgePublisher, /\$releaseArtifacts\['osShellRelease'\]/);
  assert.match(localEdgePublisher, /\$componentEvidence = \[ordered\]@\{\}/);
  assert.match(localEdgePublisher, /\[string\]\$SetupSourcePath = ''/);
  assert.match(localEdgePublisher, /SetupSourcePath must be a clean governed Setup CLI Git worktree/);
  assert.match(localEdgePublisher, /worktree add --detach \$setupCheckout \$setupSourceRevision/);
  assert.match(setupSourceLock, /^[a-f0-9]{40}$/);
  assert.match(localEdgePublisher, /setup-source\.lock/);
  assert.match(localEdgePublisher, /differs from governed lock/);
  assert.match(sdkSourceLock, /^[a-f0-9]{40}$/);
  assert.match(localEdgePublisher, /sdk-source\.lock/);
  assert.match(localEdgePublisher, /fetch --depth 1 origin \$sdkSourceRevision/);
  assert.match(localEdgePublisher, /io\.opensphere\.sdk-source-revision/);
  assert.match(localEdgePublisher, /inputs = \[ordered\]@\{/);
  assert.doesNotMatch(localEdgePublisher, /\$components = \[ordered\]@\{\}/i);
  assert.match(localEdgePublisher, /Advance selected component tags without moving a partial Console anchor/);
});

test('OS Shell local edge deploy is evidence-bound, non-interactive, and exact-digest only', () => {
  assert.match(osShellDeployer, /OpenSphereEdgeComponentPublication/);
  assert.match(osShellDeployer, /osShellControl/);
  assert.match(osShellDeployer, /osShellRuntime/);
  assert.match(osShellDeployer, /backend,cliArtifacts,console,osShellControl,osShellRuntime/);
  assert.match(osShellDeployer, /Assert-PrerequisiteDeployment -Deployment 'opensphere-console'/);
  assert.match(osShellDeployer, /Assert-PrerequisiteDeployment -Deployment 'opensphere-console-backend'/);
  assert.match(osShellDeployer, /Assert-PrerequisiteDeployment -Deployment 'os-cli'/);
  assert.match(osShellDeployer, /\$controlRepository = "\$canonicalRegistry\/opensphere-console-os-shell-control"/);
  assert.match(osShellDeployer, /\$runtimeRepository = "\$canonicalRegistry\/opensphere-os-shell-runtime"/);
  assert.match(osShellDeployer, /"\$\{Repository\}@\$\{Digest\}"/);
  assert.match(osShellDeployer, /docker-desktop/);
  assert.match(osShellDeployer, /migrate-only\.ps1/);
  assert.match(osShellDeployer, /0061_shell_session_ledger\.sql/);
  assert.match(osShellDeployer, /__OPENSPHERE_OS_SHELL_CONTROL_IMAGE__/);
  assert.match(osShellDeployer, /__OPENSPHERE_OS_SHELL_RUNTIME_IMAGE__/);
  assert.match(osShellDeployer, /__OPENSPHERE_CONSOLE_IMAGE__/);
  assert.match(osShellDeployer, /Count -ne 3/);
  assert.match(osShellDeployer, /Set-BackendOsShellActivation/);
  assert.match(osShellDeployer, /Set-ControlDeploymentActivation/);
  assert.match(osShellDeployer, /Set-ConsoleApiActivation/);
  assert.match(osShellDeployer, /OS_SHELL_ADMISSION_ENABLED/);
  assert.match(osShellDeployer, /OS_SHELL_CREDENTIAL_AUTHORITY_ENABLED/);
  assert.match(osShellDeployer, /OS_SHELL_CREDENTIAL_AUTHORITY_CERT_FILE/);
  assert.match(osShellDeployer, /OS_SHELL_CREDENTIAL_AUTHORITY_KEY_FILE/);
  assert.match(osShellDeployer, /name = 'shell-cred-tls'; containerPort = 8444/);
  assert.match(osShellDeployer, /name = 'shell-credential-authority-tls'; mountPath = '\/var\/run\/opensphere-shell-credential-authority'; readOnly = \$true/);
  assert.match(osShellDeployer, /secretName = 'opensphere-shell-credential-authority-tls'; optional = \$false/);
  assert.match(osShellDeployer, /name = 'opensphere-shell-control-runtime'; key = 'admission-secret'; optional = \$false/);
  assert.match(osShellDeployer, /name = 'opensphere-shell-control-runtime'; key = 'delegation-secret'; optional = \$false/);
  assert.match(osShellDeployer, /OS_SHELL_RUNTIME_CONTROL_ENABLED = 'true'/);
  assert.match(osShellDeployer, /OS_SHELL_ATTACH_ENABLED = 'true'/);
  assert.match(osShellDeployer, /OS_SHELL_RUNTIME_REGISTRATION_ENABLED = 'true'/);
  assert.match(osShellDeployer, /release:\/\/edge\//);
  assert.match(osShellDeployer, /osShellRelease\.cliManifest/);
  assert.match(osShellDeployer, /docker create --name \$cliEvidenceContainer \$cliArtifacts\.image/);
  assert.match(osShellDeployer, /Signed CLI manifest evidence differs from the exact cliArtifacts image/);
  assert.match(osShellDeployer, /opensphere-shell-control-ca/);
  assert.match(osShellDeployer, /CertificateRequest/);
  assert.match(osShellDeployer, /ECCurve\+NamedCurves\]::nistP256/);
  assert.match(osShellDeployer, /SubjectAlternativeNameBuilder/);
  assert.doesNotMatch(osShellDeployer, /Get-Command openssl|Invoke-Checked openssl/);
  assert.match(osShellDeployer, /icacls \$tlsDirectory \/inheritance:r \/grant:r/);
  assert.match(osShellDeployer, /opensphere-shell-api-tls/);
  assert.match(osShellDeployer, /opensphere-shell-reconciler-tls/);
  assert.match(osShellDeployer, /opensphere-shell-credential-authority-tls/);
  assert.match(osShellDeployer, /opensphere-shell-console-api-tls/);
  assert.doesNotMatch(osShellDeployer, /opensphere-shell-control-tls/);
  assert.match(osShellDeployer, /PrepareTrustOnly/);
  assert.match(osShellDeployer, /all four private leaves and both public CA projections must move together/);
  assert.match(osShellDeployer, /Assert-ExistingInternalTls/);
  assert.match(osShellDeployer, /CreateFromPem\(\$leafPem, \$keyPem\)/);
  assert.match(osShellDeployer, /X509ChainTrustMode\]::CustomRootTrust/);
  assert.match(osShellDeployer, /Assert-ExactCertificateDnsNames/);
  assert.match(osShellDeployer, /at least 24 hours remaining/);
  assert.match(osShellDeployer, /must be mounted only by Deployment/);
  assert.match(osShellDeployer, /auth can-i/);
  assert.doesNotMatch(osShellDeployer, /\/api\/platform\/releases|Invoke-LocalEdgePlatformRelease|MFA|aal2/i);
  assert.doesNotMatch(osShellDeployer, /kubectl set image/);
});

test('OS Shell release manifest is closed over exact workloads, services, trust and default-off source', () => {
  assert.equal((osShellControlManifest.match(/__OPENSPHERE_OS_SHELL_CONTROL_IMAGE__/g) || []).length, 3);
  assert.equal((osShellControlManifest.match(/__OPENSPHERE_OS_SHELL_RUNTIME_IMAGE__/g) || []).length, 3);
  assert.equal((osShellControlManifest.match(/__OPENSPHERE_CONSOLE_IMAGE__/g) || []).length, 1);
  assert.equal((osShellControlManifest.match(/^\s*replicas:\s*0\s*$/gm) || []).length, 4);
  for (const name of ['opensphere-shell-api', 'opensphere-shell-gateway', 'opensphere-shell-reconciler', 'opensphere-shell-console-api']) {
    assert.match(osShellControlManifest, new RegExp(`kind: Deployment[\\s\\S]{0,240}name: ${name}`));
  }
  for (const name of ['opensphere-shell-api', 'opensphere-shell-gateway', 'opensphere-shell-reconciler', 'opensphere-shell-credential-authority', 'opensphere-shell-console-api']) {
    assert.match(osShellControlManifest, new RegExp(`kind: Service[\\s\\S]{0,240}name: ${name}`));
  }
  for (const name of ['opensphere-shell-api-tls', 'opensphere-shell-reconciler-tls', 'opensphere-shell-console-api-tls']) {
    assert.match(osShellControlManifest, new RegExp(`secretName: ${name}`));
  }
  assert.match(consoleBackendManifest, /secretName: opensphere-shell-credential-authority-tls/);
  assert.match(osShellControlManifest, /configMap: \{ name: opensphere-shell-control-ca \}/);
  assert.match(osShellControlManifest, /ports: \[\{ name: console-api-tls, port: 8445, targetPort: console-api-tls \}\]/);
});

test('Console Nginx exchanges opaque browser sessions for OS Shell admission', () => {
  assert.match(nginx, /location = \/_os_shell_authn/);
  assert.match(nginx, /api\/internal\/os-shell-authn/);
  assert.match(nginx, /auth_request_set \$os_shell_admission \$upstream_http_x_os_shell_admission/);
  assert.match(nginx, /opensphere-shell-api\.opensphere-console\.svc\.cluster\.local/);
  assert.match(nginx, /opensphere-shell-gateway\.opensphere-console\.svc\.cluster\.local/);
  assert.match(nginx, /proxy_set_header X-OS-Shell-Admission \$os_shell_admission/);
  assert.match(nginx, /proxy_set_header Cookie ""/);
  assert.match(nginx, /proxy_set_header Authorization ""/);
  assert.doesNotMatch(nginx, /OS_SHELL_CONTROL_UPSTREAM_PENDING|os_shell_control_plane_pending/);
});

test('retag-only promotion workflow is absent because channel identity is immutable image metadata', () => {
  assert.equal(fs.existsSync(path.join(consoleRoot, '.github', 'workflows', 'promote-image-channel.yml')), false);
});

test('public Console GA workflow reads private Setup through a dedicated read-only secret', () => {
  const checkout = gaWorkflow.slice(
    gaWorkflow.indexOf('      - name: Require private Setup read credential'),
    gaWorkflow.indexOf('      - name: Checkout Cluster Manager'),
  );
  assert.match(checkout, /SETUP_REPOSITORY_SSH_KEY/);
  assert.match(checkout, /ssh-key: \$\{\{ secrets\.SETUP_REPOSITORY_SSH_KEY \}\}/);
  assert.match(checkout, /persist-credentials: false/);
  assert.doesNotMatch(checkout, /secrets\.GITHUB_TOKEN/);
});

test('production image build does not fetch external fonts while compiling', () => {
  const optimization = angularConfig.projects['opensphere-console'].architect.build.configurations.production.optimization;
  assert.equal(optimization.fonts, false);
});
