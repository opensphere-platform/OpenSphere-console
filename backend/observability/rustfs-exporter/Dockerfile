# backbone-rustfs-exporter — RustFS S3 사용량 메트릭(SigV4 폴링). 의존성 0(node 내장만).
FROM docker.io/library/node:22-alpine
WORKDIR /app
COPY exporter.js /app/exporter.js
ENV PORT=9209
USER node
EXPOSE 9209
CMD ["node", "/app/exporter.js"]
