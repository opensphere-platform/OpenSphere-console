# opensphere-platformconfig admission webhook — 런타임 이미지.
# 빌드는 호스트에서 크로스컴파일(GOOS=linux CGO_ENABLED=0) → 정적 바이너리만 패키징.
FROM gcr.io/distroless/static:nonroot
COPY webhook /usr/local/bin/webhook
USER 65532:65532
EXPOSE 8443
ENTRYPOINT ["/usr/local/bin/webhook"]
