# opensphere-console-dupa-controller 이미지. 빌드 컨텍스트 = 이 디렉터리(backend/dupa-control).
# Supabase audit and Gitea health are consumed through bounded HTTP APIs; the
# controller has no direct database driver or legacy storage dependency.
FROM docker.io/library/node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
ENV PORT=8080
WORKDIR /app
# Keep the package metadata layer even though the active controller uses only
# Node built-ins; it preserves deterministic runtime metadata and future checks.
COPY package.json /app/package.json
RUN apk upgrade --no-cache \
    && apk add --no-cache github-cli \
    && npm install --omit=dev --no-audit --no-fund \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY controller.js /app/controller.js
USER 1000:1000
EXPOSE 8080
CMD ["node", "/app/controller.js"]
