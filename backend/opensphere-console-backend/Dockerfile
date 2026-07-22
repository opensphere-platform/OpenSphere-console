# console-identity — Kanidm 콘솔관리자 인증(Main Shell 관리 영역). identity 백엔드 재사용. dir context.
FROM docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
# Kanidm self-signed CA — REST/JWKS https 명시 CA 신뢰(/etc/kanidm-ca/ca.crt).
COPY kanidm-ca.crt /etc/kanidm-ca/ca.crt
COPY server.js /app/server.js
COPY supabase-auth.js /app/supabase-auth.js
COPY ui-shell/ /plugins/
ENV PORT=8080 PLUGIN_DIR=/plugins
EXPOSE 8080
USER 1001
CMD ["node", "/app/server.js"]
