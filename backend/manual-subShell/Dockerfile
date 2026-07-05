FROM node:22-alpine
WORKDIR /app
COPY --chmod=0644 server.js /app/server.js
COPY ui-shell/ /app/plugins/
ENV PLUGINS_DIR=/app/plugins PORT=8080
EXPOSE 8080
USER 1000
CMD ["node", "/app/server.js"]
