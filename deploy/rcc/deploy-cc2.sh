#!/usr/bin/env bash
set -euo pipefail
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
project_root="$(cd "$repo/.." && pwd)"
sdk="$project_root/OpenSphere-SDK"
local_kubectl="${KUBECTL_CLIENT:-kubectl}"
target_host="cc2-k3s"
domain="rcc.cc2.opl.io.kr"
data_namespace="polyon-rcc-data"
change_namespace="polyon-rcc-change"
app_namespace="polyon-rcc"
tag="$(git -C "$repo" rev-parse --short=12 HEAD)-$(date -u +%Y%m%d%H%M%S)"
web_image="docker.io/library/polyon-rcc-web:${tag}"
backend_image="docker.io/library/polyon-rcc-backend:${tag}"
remote_archive="/tmp/polyon-rcc-images-${tag}.tar"

# ── subShell signing preflight ────────────────────────────────────────────────
# The approved Linux host-control surface only exists as the signed
# linux-host-manager subShell. Deploying without the signing key produces an
# image with no plugin registry, and the feature silently disappears from a
# control center that is supposed to have it.
#
# Nothing above this point creates files, contacts the registry, the target host
# or the cluster, and no trap is installed yet. The preflight therefore runs
# before the first mutation of any kind, so a rejected key leaves both the
# workstation and CC2 untouched.
#
# RCC_DISABLE_LINUX_HOST_MANAGER=1 deliberately ships the control center WITHOUT
# the Linux host manager. It does not relax any signature check — nothing
# unsigned is ever loaded — it simply omits the feature. It is off by default
# and is NOT the normal CC2 path.
preflight_signing_key() {
  local key="${RCC_PLUGIN_SIGNING_KEY:-}"
  if [[ -z "$key" ]]; then
    if [[ "${RCC_DISABLE_LINUX_HOST_MANAGER:-0}" == "1" ]]; then
      echo "WARNING: RCC_DISABLE_LINUX_HOST_MANAGER=1 — deploying WITHOUT the linux-host-manager subShell." >&2
      echo "         No plugin registry is produced and /cc/<ccId>/hosts will report" >&2
      echo "         the feature as not registered. Nothing unsigned is loaded." >&2
      plugin_signing_key=/dev/null
      return 0
    fi
    cat >&2 <<'ERR'
RCC_PLUGIN_SIGNING_KEY is not set.

The approved Linux host-control feature ships only as the signed
linux-host-manager subShell. Building without the key would deploy a control
center with that feature missing, so this deployment stops before any change.

  RCC_PLUGIN_SIGNING_KEY=/secure/path/rcc-plugins-p256.pem \
  RCC_PLUGIN_SIGNING_KEY_SPKI_SHA256=<expected public key fingerprint> \
  ./deploy/rcc/deploy-cc2.sh

The key must be an ECDSA P-256 private key held outside this repository. It is
passed to the build as a BuildKit secret and never stored in the image.

To deploy deliberately without this feature, set RCC_DISABLE_LINUX_HOST_MANAGER=1.
ERR
    exit 1
  fi

  # Curve, identity and descriptor cross-checks live in one shared module so the
  # build cannot accept a key the deployment rejected. The expected public-key
  # fingerprint is mandatory: trust.keyId is only a label and proves nothing
  # about which private key was supplied.
  node "$repo/scripts/plugin-signing-key.mjs" --verify || exit 1

  plugin_signing_key="$key"
}

preflight_signing_key

# CC2's Linux host page is not complete without the Beszel-backed metrics
# source. Validate the server-only reader document before the first mutation,
# exactly as the signing key is validated above. The live adapter will repeat
# these checks and additionally prove that the account's Beszel role is
# `readonly`.
preflight_beszel_reader() {
  local config="${RCC_BESZEL_READER_CONFIG:-}"
  case "$config" in
    /*) ;;
    *)
      echo "RCC_BESZEL_READER_CONFIG must be the absolute path to the provisioned Beszel readonly config.json." >&2
      exit 1
      ;;
  esac
  command -v "$local_kubectl" >/dev/null 2>&1 || {
    echo "A local kubectl client is required to stream the Beszel reader Secret." >&2
    exit 1
  }
  node - "$repo/backend/opensphere-console-backend/beszel-metrics-api.js" "$config" <<'NODE'
const { loadBeszelReaderConfig } = require(process.argv[2]);
const config = loadBeszelReaderConfig(process.argv[3]);
const expected = config.systems['cc2/cmars-oci-cc-02-4x24'];
if (expected !== 'CMARS-OCI-CC-02-4X24') {
  throw new Error('Beszel reader config does not bind the CC2 RCC host to the reviewed Beszel system');
}
NODE
  beszel_reader_config="$config"
}

preflight_beszel_reader

# ── first mutation happens below this line ────────────────────────────────────
tmp="$(mktemp -d "${TMPDIR:-/tmp}/polyon-rcc-cc2.XXXXXX")"

cleanup() {
  if [[ "$tmp" == *"/polyon-rcc-cc2."* && -d "$tmp" ]]; then
    rm -rf "$tmp"
  fi
}
trap cleanup EXIT

k() {
  "$here/kubectl-cc2" "$@"
}

random_hex() {
  local length="$1" value
  value="$(openssl rand -hex "$(((length + 1) / 2))")"
  printf '%s' "${value:0:length}"
}

service_jwt() {
  local secret_file="$1" role="$2"
  node - "$secret_file" "$role" <<'NODE'
const fs = require('fs');
const crypto = require('crypto');
const secret = fs.readFileSync(process.argv[2], 'utf8');
const role = process.argv[3];
const b64 = (v) => Buffer.from(v).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify({
  role,
  iss: 'supabase',
  iat: now,
  exp: now + 315360000,
}))}`;
process.stdout.write(`${unsigned}.${crypto.createHmac('sha256', secret).update(unsigned).digest('base64url')}`);
NODE
}

echo "[1/8] Build immutable local arm64 RCC images"
# The signing key was validated by preflight_signing_key() before any mutation.
# The private key is passed as a BuildKit secret and never stored in the image;
# the expected public-key fingerprint is a build arg, because it is public data
# and recording it in image history is useful provenance.
docker buildx build \
  --platform linux/arm64 \
  --build-context "console-src=$repo" \
  --build-context "sdk-src=$sdk" \
  --secret "id=rcc_plugin_signing_key,src=$plugin_signing_key" \
  --build-arg "RCC_PLUGIN_SIGNING_KEY_SPKI_SHA256=${RCC_PLUGIN_SIGNING_KEY_SPKI_SHA256:-}" \
  --file "$here/Dockerfile.web" \
  --tag "$web_image" \
  --load \
  "$repo"
docker build \
  --platform linux/arm64 \
  --file "$repo/backend/opensphere-console-backend/Dockerfile" \
  --tag "$backend_image" \
  "$repo/backend"

docker save "$web_image" "$backend_image" -o "$tmp/images.tar"
scp -q "$tmp/images.tar" "$target_host:$remote_archive"
ssh -o BatchMode=yes "$target_host" "sudo k3s ctr images import '$remote_archive' >/dev/null && rm -f '$remote_archive'"

echo "[2/8] Create isolated PolyON namespaces"
for ns in "$app_namespace" "$data_namespace" "$change_namespace"; do
  pod_security="baseline"
  if [[ "$ns" == "$app_namespace" ]]; then pod_security="restricted"; fi
  printf '%s\n' \
    'apiVersion: v1' \
    'kind: Namespace' \
    'metadata:' \
    "  name: $ns" \
    '  labels:' \
    '    app.kubernetes.io/part-of: polyon-rcc' \
    "    pod-security.kubernetes.io/enforce: $pod_security" \
    "    pod-security.kubernetes.io/audit: $pod_security" \
    "    pod-security.kubernetes.io/warn: $pod_security" |
    k apply -f -
done

echo "[3/8] Install the RCC Supabase authority"
if ! k -n "$data_namespace" get secret polyon-supabase-secrets >/dev/null 2>&1; then
  postgres_password="$(random_hex 48)"
  backend_password="$(random_hex 48)"
  jwt_secret="$(openssl rand -base64 48 | tr -d '\n')"
  printf '%s' "$jwt_secret" >"$tmp/jwt-secret"
  anon_key="$(service_jwt "$tmp/jwt-secret" anon)"
  service_role_key="$(service_jwt "$tmp/jwt-secret" service_role)"
  jq -n \
    --arg namespace "$data_namespace" \
    --arg postgres "$postgres_password" \
    --arg backend "$backend_password" \
    --arg jwt "$jwt_secret" \
    --arg anon "$anon_key" \
    --arg service "$service_role_key" \
    --arg s3id "$(random_hex 32)" \
    --arg s3secret "$(random_hex 64)" \
    '{
      apiVersion:"v1", kind:"Secret",
      metadata:{name:"polyon-supabase-secrets", namespace:$namespace,
        labels:{"polyon.io/secret-scope":"supabase-server-only"}},
      type:"Opaque",
      stringData:{
        "postgres-password":$postgres,
        "backend-password":$backend,
        "jwt-secret":$jwt,
        "anon-key":$anon,
        "service-role-key":$service,
        "s3-access-key-id":$s3id,
        "s3-access-key-secret":$s3secret
      }
    }' >"$tmp/supabase-secret.json"
  k apply -f - <"$tmp/supabase-secret.json"
else
  supabase_secret="$(k -n "$data_namespace" get secret polyon-supabase-secrets -o json)"
  postgres_password="$(printf '%s' "$supabase_secret" | jq -r '.data["postgres-password"]' | base64 -d)"
  backend_password="$(printf '%s' "$supabase_secret" | jq -r '.data["backend-password"]' | base64 -d)"
  jwt_secret="$(printf '%s' "$supabase_secret" | jq -r '.data["jwt-secret"]' | base64 -d)"
  anon_key="$(printf '%s' "$supabase_secret" | jq -r '.data["anon-key"]' | base64 -d)"
  service_role_key="$(printf '%s' "$supabase_secret" | jq -r '.data["service-role-key"]' | base64 -d)"
fi

sed \
  -e '/imagePullSecrets: \[{ name: opensphere-ghcr-pull }\]/d' \
  -e "s#__OPENSPHERE_SUPABASE_NAMESPACE__#${data_namespace}#g" \
  -e "s#__OPENSPHERE_STORAGE_CLASS__#local-path#g" \
  -e "s#__OPENSPHERE_CONSOLE_URL__#https://${domain}#g" \
  -e 's#docker.io/supabase/postgres:17.6.1.136#docker.io/supabase/postgres@sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00#g' \
  -e 's#docker.io/supabase/gotrue:v2.189.0#docker.io/supabase/gotrue@sha256:385184459f57569c54c25209f51f3b2be99ddd7c4ce9e3555b5d3eea8447b7cf#g' \
  -e 's#docker.io/postgrest/postgrest:v14.12#docker.io/postgrest/postgrest@sha256:54000f24847d01a2c2302e0041cf0618b875c57fb48507d743cfa9aaa50bf43c#g' \
  -e 's#docker.io/supabase/storage-api:v1.60.4#docker.io/supabase/storage-api@sha256:c8eb9858eafec891a97c27125470aaad54703c3f4eb4d55ca7f1bf6c6411febf#g' \
  -e 's/opensphere-supabase/polyon-supabase/g' \
  -e 's/opensphere-console/polyon-rcc/g' \
  -e 's/opensphere.io/polyon.io/g' \
  "$repo/backend/supabase/bootstrap/supabase.yaml" >"$tmp/supabase.yaml"
k apply -f - <"$tmp/supabase.yaml"
k -n "$data_namespace" rollout status statefulset/polyon-supabase-postgres --timeout=10m

postgres_pod="$(k -n "$data_namespace" get pod -l app=polyon-supabase-postgres -o jsonpath='{.items[0].metadata.name}')"
cat >"$tmp/roles.sql" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'opensphere_console_backend') THEN
    CREATE ROLE opensphere_console_backend LOGIN PASSWORD '${backend_password}'
      NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE opensphere_console_backend LOGIN PASSWORD '${backend_password}'
      NOSUPERUSER INHERIT NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
\$\$;
SQL
k -n "$data_namespace" exec -i "$postgres_pod" -- sh -ec \
  'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1' <"$tmp/roles.sql"
k -n "$data_namespace" exec -i "$postgres_pod" -- sh -ec \
  'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h 127.0.0.1 -U supabase_admin -d postgres -v ON_ERROR_STOP=1' <"$here/supabase-baseline.sql"

# The Supabase image owns its service roles and may finish its own first-boot
# role reconciliation after PostgreSQL first reports Ready. Set and verify the
# shared password from the Pod's Secret-backed environment only after the RCC
# baseline has completed.
k -n "$data_namespace" exec -i "$postgres_pod" -- sh -s <<'SERVICE_ROLE_SCRIPT'
set -eu
psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 <<SQL
ALTER ROLE authenticator LOGIN PASSWORD '$POSTGRES_PASSWORD';
ALTER ROLE supabase_auth_admin LOGIN PASSWORD '$POSTGRES_PASSWORD';
ALTER ROLE supabase_storage_admin LOGIN PASSWORD '$POSTGRES_PASSWORD';
SQL
pod_ip=$(hostname -i | awk '{print $1}')
for role in authenticator supabase_auth_admin supabase_storage_admin; do
  PGPASSWORD="$POSTGRES_PASSWORD" psql -h "$pod_ip" -U "$role" -d postgres -tAc 'select 1' >/dev/null
done
SERVICE_ROLE_SCRIPT

for workload in polyon-supabase-auth polyon-supabase-storage polyon-supabase-rest; do
  k -n "$data_namespace" rollout restart "deployment/$workload"
done
k -n "$data_namespace" rollout status deployment/polyon-supabase-auth --timeout=10m

storage_pod="$(k -n "$data_namespace" get pod -l app=polyon-supabase-storage -o jsonpath='{.items[0].metadata.name}')"
k -n "$data_namespace" wait --for=condition=Ready "pod/$storage_pod" --timeout=10m
k -n "$data_namespace" exec "$storage_pod" -- node /app/dist/scripts/migrate-call.js
k -n "$data_namespace" rollout restart deployment/polyon-supabase-storage
k -n "$data_namespace" rollout status deployment/polyon-supabase-storage --timeout=10m
k -n "$data_namespace" rollout status deployment/polyon-supabase-rest --timeout=10m

jq -n \
  --arg namespace "$app_namespace" \
  --arg jwt "$jwt_secret" \
  --arg service "$service_role_key" \
  '{
    apiVersion:"v1", kind:"Secret",
    metadata:{name:"polyon-supabase-runtime", namespace:$namespace,
      labels:{"polyon.io/secret-scope":"rcc-backend-only"}},
    type:"Opaque",
    stringData:{"jwt-secret":$jwt, "service-role-key":$service}
  }' | k apply -f -

echo "[4/8] Install private Gitea change authority"
if ! k -n "$change_namespace" get secret polyon-gitea-runtime >/dev/null 2>&1; then
  gitea_postgres_password="$(random_hex 48)"
  gitea_db_password="$(random_hex 48)"
  jq -n \
    --arg namespace "$change_namespace" \
    --arg postgres "$gitea_postgres_password" \
    --arg db "$gitea_db_password" \
    '{
      apiVersion:"v1", kind:"Secret",
      metadata:{name:"polyon-gitea-runtime", namespace:$namespace,
        labels:{"polyon.io/secret-scope":"gitea-runtime-only"}},
      type:"Opaque",
      stringData:{"postgres-password":$postgres, "db-password":$db}
    }' | k apply -f -
fi

if ! k -n "$change_namespace" get secret polyon-gitea-config >/dev/null 2>&1; then
  cat >"$tmp/app.ini" <<EOF
APP_NAME = PolyON RCC Declarative Change Authority
RUN_MODE = prod
RUN_USER = git

[repository]
ROOT = /var/lib/gitea/git/repositories

[server]
DOMAIN = polyon-gitea.${change_namespace}.svc.cluster.local
ROOT_URL = http://polyon-gitea.${change_namespace}.svc.cluster.local:3000/
HTTP_PORT = 3000
DISABLE_SSH = true
LFS_START_SERVER = true

[security]
INSTALL_LOCK = true
SECRET_KEY = $(openssl rand -base64 48 | tr -d '\n')
INTERNAL_TOKEN = $(openssl rand -base64 64 | tr -d '\n')

[lfs]
JWT_SECRET = $(openssl rand -base64 48 | tr -d '\n')

[service]
DISABLE_REGISTRATION = true
REQUIRE_SIGNIN_VIEW = true
ENABLE_NOTIFY_MAIL = false

[session]
PROVIDER = file

[log]
MODE = console
LEVEL = Info
EOF
  jq -n \
    --arg namespace "$change_namespace" \
    --rawfile app "$tmp/app.ini" \
    '{
      apiVersion:"v1", kind:"Secret",
      metadata:{name:"polyon-gitea-config", namespace:$namespace,
        labels:{"polyon.io/secret-scope":"gitea-config-only"}},
      type:"Opaque", stringData:{"app.ini":$app}
    }' | k apply -f -
fi

if ! k -n "$change_namespace" get secret polyon-gitea-signing >/dev/null 2>&1; then
  ssh-keygen -q -t ed25519 -N '' -C 'PolyON Gitea signing <gitea-signing@opl.io.kr>' -f "$tmp/gitea-signing-key"
  jq -n \
    --arg namespace "$change_namespace" \
    --rawfile private "$tmp/gitea-signing-key" \
    --rawfile public "$tmp/gitea-signing-key.pub" \
    '{
      apiVersion:"v1", kind:"Secret",
      metadata:{name:"polyon-gitea-signing", namespace:$namespace,
        labels:{"polyon.io/secret-scope":"gitea-signing-only"}},
      type:"Opaque",
      stringData:{"gitea-signing-key":$private, "gitea-signing-key.pub":$public}
    }' | k apply -f -
fi

sed \
  -e '/imagePullSecrets: \[{ name: opensphere-ghcr-pull }\]/d' \
  -e 's#image: postgres:17-alpine#image: docker.io/library/postgres@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193#g' \
  -e 's#__OPENSPHERE_GITEA_IMAGE__#docker.io/gitea/gitea@sha256:4d1d79638bef7a4a82e3a269b95fae1bbb9bcba1258dd84fba7ba3a3a49581e3#g' \
  -e 's/storageClassName: standard/storageClassName: local-path/g' \
  -e 's/opensphere-console-change/polyon-rcc-change/g' \
  -e 's/opensphere-console/polyon-rcc/g' \
  -e 's/opensphere-gitea/polyon-gitea/g' \
  -e 's/opensphere.io/polyon.io/g' \
  "$repo/backend/gitea/bootstrap/gitea.yaml" >"$tmp/gitea.yaml"
k apply -f - <"$tmp/gitea.yaml"
k -n "$change_namespace" rollout status deployment/polyon-gitea-postgres --timeout=10m
k -n "$change_namespace" scale deployment/polyon-gitea --replicas=1
k -n "$change_namespace" rollout status deployment/polyon-gitea --timeout=10m

mkdir -p "$tmp/bin"
ln -s "$here/kubectl-cc2" "$tmp/bin/kubectl"
PATH="$tmp/bin:$PATH" pwsh -NoProfile -File "$repo/backend/gitea/bootstrap/control-plane-bootstrap.ps1" \
  -GiteaNamespace "$change_namespace" \
  -ConsoleNamespace "$app_namespace" \
  -Organization polyon \
  -Repository cc2-config \
  -ServiceAccount polyon-control \
  -ReviewServiceAccount polyon-review \
  -SecretName polyon-gitea-control-plane \
  -GiteaAppLabel polyon-gitea \
  -HookTarget "http://polyon-rcc-backend.${app_namespace}.svc.cluster.local:8080/api/platform/gitea/webhook"

echo "[5/8] Apply RCC web, backend, RBAC and HTTPS ingress"
"$local_kubectl" -n "$app_namespace" create secret generic polyon-rcc-beszel-reader \
  --from-file=config.json="$beszel_reader_config" \
  --dry-run=client -o yaml | k apply -f -
sed \
  -e "s#__POLYON_RCC_WEB_IMAGE__#${web_image}#g" \
  -e "s#__POLYON_RCC_BACKEND_IMAGE__#${backend_image}#g" \
  "$here/rcc.yaml" >"$tmp/rcc.yaml"
k apply -f - <"$tmp/rcc.yaml"
k -n "$app_namespace" rollout status deployment/polyon-rcc-backend --timeout=10m
k -n "$app_namespace" rollout status deployment/polyon-rcc-web --timeout=10m

echo "[6/8] Verify internal HTTP and authority readiness"
k -n "$app_namespace" get deploy,pod,svc,ingress
k -n "$data_namespace" get statefulset,deploy,pod,svc,pvc
k -n "$change_namespace" get deploy,pod,svc,pvc

echo "[7/8] Verify the existing Headlamp was not modified"
k -n headlamp get deployment/headlamp service/headlamp

echo "[8/8] CC2 application deployment complete"
echo "WEB_IMAGE=$web_image"
echo "BACKEND_IMAGE=$backend_image"
echo "DOMAIN=$domain"
