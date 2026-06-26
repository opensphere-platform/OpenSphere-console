# dupa-registry-controller 이미지 (의존성 0, node 내장만)
FROM docker.io/library/node:22-alpine
ENV PORT=8080
WORKDIR /app
COPY --chmod=0644 controllers/dupa-control/controller.js /app/controller.js
USER node
EXPOSE 8080
CMD ["node", "/app/controller.js"]
