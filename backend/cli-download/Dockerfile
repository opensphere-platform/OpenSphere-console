# os-cli — headless CLI download 서빙 컨테이너 (CLIDownload binding operand).
# nginx-unprivileged(nonroot uid 101)가 opensphere-cli-* 바이너리 + index.json을 :8080 서빙.
#   바이너리는 Content-Disposition: attachment + octet-stream → 브라우저 인라인 렌더 대신 다운로드.
# 콘솔 바인딩: 셸 generic proxy /api/plugins/os-cli/<file> → os-cli.opensphere-system.svc:8080/<file>.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --chown=101:101 dist/ /srv/
EXPOSE 8080
