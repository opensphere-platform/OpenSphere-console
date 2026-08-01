#!/bin/sh
set -eu

database_host="${OPENSPHERE_STORAGE_DATABASE_HOST:-opensphere-supabase-postgres.opensphere-console-data.svc.cluster.local}"
database_port="${OPENSPHERE_STORAGE_DATABASE_PORT:-5432}"
rest_host="${OPENSPHERE_STORAGE_REST_HOST:-opensphere-supabase-rest.opensphere-console-data.svc.cluster.local}"
rest_port="${OPENSPHERE_STORAGE_REST_PORT:-3000}"

wait_for_service() {
  service_name="$1"
  service_host="$2"
  service_port="$3"
  attempt=0

  while :; do
    attempt=$((attempt + 1))
    if getent hosts "$service_host" >/dev/null 2>&1 \
      && nc -z -w 2 "$service_host" "$service_port" >/dev/null 2>&1; then
      echo "[opensphere-storage] ${service_name} dependency ready after ${attempt} attempt(s)"
      return 0
    fi

    if [ "$attempt" -eq 1 ] || [ $((attempt % 15)) -eq 0 ]; then
      echo "[opensphere-storage] waiting for ${service_name} at ${service_host}:${service_port} (attempt ${attempt})" >&2
    fi
    sleep 2
  done
}

wait_for_service "PostgreSQL" "$database_host" "$database_port"
wait_for_service "PostgREST" "$rest_host" "$rest_port"

exec /usr/local/bin/docker-entrypoint.sh "$@"
