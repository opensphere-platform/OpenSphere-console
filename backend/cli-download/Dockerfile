# os-cli — headless CLI download 서빙 컨테이너 (CLIDownload binding operand).
# nginx-unprivileged(nonroot uid 101)가 opensphere-cli-* 바이너리 + index.json을 :8080 서빙.
#   바이너리는 Content-Disposition: attachment + octet-stream → 브라우저 인라인 렌더 대신 다운로드.
# 콘솔 바인딩: 셸 generic proxy /api/plugins/os-cli/<file> → os-cli.opensphere-system.svc:8080/<file>.
FROM docker.io/nginxinc/nginx-unprivileged@sha256:592b23aa79a6e6c08ba4b20f1fff700e1328895705966722608e115d62e52d39
USER root
RUN apk del --no-cache curl
USER 101
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --chown=101:101 dist/ /srv/
EXPOSE 8080
