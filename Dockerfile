# Build context: OpenSphere-Platform-V2 root.
# OpenSphere Console depends on sibling package OpenSphere-SDK.
FROM docker.io/library/node:24-alpine AS build
WORKDIR /app/OpenSphere-console
COPY OpenSphere-SDK /app/OpenSphere-SDK
RUN cd /app/OpenSphere-SDK && npm install --no-audit --no-fund && npm run build
COPY OpenSphere-console/package.json OpenSphere-console/package-lock.json ./
RUN npm ci --no-audit --no-fund --legacy-peer-deps
COPY OpenSphere-console .
RUN npx ng build --configuration production

FROM docker.io/library/nginx:1.27-alpine
COPY --from=build /app/OpenSphere-console/dist/opensphere-console/browser /usr/share/nginx/html
COPY OpenSphere-console/nginx/default.conf.template /etc/nginx/templates/default.conf.template
EXPOSE 8080
