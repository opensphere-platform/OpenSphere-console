import {generateKeyPairSync, sign} from 'node:crypto';
export function moduleFixture() {
  const now = Date.parse('2026-09-05T00:00:00Z');
  const {privateKey, publicKey} = generateKeyPairSync('ec',{namedCurve:'P-256'});
  const release = {schema:'opensphere.module-release/v1',id:'cluster-manager',channel:'edge',issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+86400_000).toISOString(),
    spec:{kind:'subShell',hostRef:'main',permissionProfile:'cluster-read',image:{repository:'ghcr.io/opensphere-platform/opensphere-shell-cluster-manager',digest:'sha256:'+'a'.repeat(64)},trust:{keyId:'test-key'},resolution:{requestedChannel:'edge',resolvedDigest:'sha256:'+'a'.repeat(64),buildAuthority:'localhost',signatureIdentity:'test-key'}}};
  function seal(value=release) {const bytes=Buffer.from(JSON.stringify(value));return JSON.stringify({schema:'opensphere.module-release-envelope/v1',keyId:'test-key',payload:bytes.toString('base64'),signature:sign('sha256',bytes,{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64')});}
  const envelope=seal();
  const index={schemaVersion:2,mediaType:'application/vnd.oci.image.index.v1+json',manifests:[{mediaType:'application/vnd.oci.image.manifest.v1+json',digest:release.spec.image.digest,size:100,platform:{os:'linux',architecture:'amd64'}}],annotations:{'opensphere.io/module-release':envelope}};
  return {now,release,envelope,index,seal,trustedKeys:{'test-key':publicKey.export({type:'spki',format:'der'}).toString('base64')}};
}
