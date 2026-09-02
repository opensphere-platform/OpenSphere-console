# opensphere-platformconfig admission webhook — 런타임 이미지.
# 빌드는 호스트에서 크로스컴파일(GOOS=linux CGO_ENABLED=0) → 정적 바이너리만 패키징.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY webhook /usr/local/bin/webhook
USER 65532:65532
EXPOSE 8443
ENTRYPOINT ["/usr/local/bin/webhook"]
