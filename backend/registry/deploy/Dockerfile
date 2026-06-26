# opensphere-registry 단일창구 — 런타임 이미지.
# 호스트에서 크로스컴파일(GOOS=linux CGO_ENABLED=0) → 정적 바이너리만 패키징.
FROM gcr.io/distroless/static:nonroot
COPY registry /usr/local/bin/registry
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/registry"]
