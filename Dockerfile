# OpenSphere Console (Angular shell) — 2-stage 자체 빌드 (독자 lifecycle 규약)
# build: node 22 → runtime: nginx (정적 서빙 + 엔진 프록시, dynamic-ui §11)

# node 24 = npm 11 (로컬 lockfile 생성기와 동일 계열 — npm10의 optional-dep lock 버그 회피)
FROM docker.io/library/node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
# Clarity 18 + Angular 22는 공식 미지원 peer 조합(동작 검증됨) → legacy-peer-deps 필요
RUN npm ci --no-audit --no-fund --legacy-peer-deps
COPY . .
RUN npx ng build --configuration production

FROM docker.io/library/nginx:1.27-alpine
# SPA 정적 파일
COPY --from=build /app/dist/opensphere-shell/browser /usr/share/nginx/html
# 프록시 설정 — SHELL_SERVICE_TOKEN은 기동 시 envsubst로 주입(이미지에 토큰 없음)
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080
