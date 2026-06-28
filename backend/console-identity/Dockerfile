# console-identity — Kanidm 콘솔관리자 인증(Main Shell 관리 영역). identity 백엔드 재사용. dir context.
FROM node:20-alpine
WORKDIR /app
# Kanidm self-signed CA — REST/JWKS https 명시 CA 신뢰(/etc/kanidm-ca/ca.crt).
COPY kanidm-ca.crt /etc/kanidm-ca/ca.crt
COPY server.js /app/server.js
COPY ui-shell/ /plugins/
ENV PORT=8080 PLUGIN_DIR=/plugins
EXPOSE 8080
USER 1001
CMD ["node", "/app/server.js"]
