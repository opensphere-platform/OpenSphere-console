# dupa-registry-controller 이미지. 빌드 컨텍스트 = 이 디렉터리(backend/dupa-control).
# 의존성: pg(node-postgres) — 감사로그 PostgreSQL 영속(④, docs/BACKBONE-ARCHITECTURE.md). 그 외는 node 내장.
FROM docker.io/library/node:22-alpine
# Kanidm self-signed CA — 호출자 id_token JWKS(ES256) https 검증용. 감사 P0-1.
# ⚠️ /etc/* 하위로 COPY하면 자동 생성 디렉터리를 USER node가 traverse 못 해 EACCES(→ca=null→DEPTH_ZERO).
#   controller.js가 읽히는 WORKDIR(/app)에 함께 두고 KANIDM_CA_PATH로 지정한다(검증된 위치).
ENV PORT=8080 KANIDM_CA_PATH=/app/kanidm-ca.crt
WORKDIR /app
# 의존성 먼저(레이어 캐시) — pg는 순수 JS라 네이티브 빌드 없음(alpine 호환).
COPY package.json /app/package.json
RUN npm install --omit=dev --no-audit --no-fund
COPY controller.js /app/controller.js
COPY db.js /app/db.js
COPY storage.js /app/storage.js
COPY kanidm-ca.crt /app/kanidm-ca.crt
USER node
EXPOSE 8080
CMD ["node", "/app/controller.js"]
