# opensphere-catalog-api — 네이티브 카탈로그/API 엔진 (mainShell B/E). zero-dep.
FROM node:20-alpine
WORKDIR /app
COPY --chmod=0644 server.js /app/server.js
ENV PORT=8080
EXPOSE 8080
USER 1001
CMD ["node", "/app/server.js"]
