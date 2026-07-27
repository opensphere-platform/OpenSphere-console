VERSION ?= 0.1.0-cc2
GOFLAGS ?= -trimpath
LDFLAGS := -s -w -X main.Version=$(VERSION)

.PHONY: all test vet build build-arm64 clean

all: vet test build

vet:
	go vet ./...

test:
	go test ./...

build:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build $(GOFLAGS) -ldflags "$(LDFLAGS)" -o dist/rcc-node-agent ./cmd/rcc-node-agent

build-arm64:
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build $(GOFLAGS) -ldflags "$(LDFLAGS)" -o dist/rcc-node-agent-arm64 ./cmd/rcc-node-agent

clean:
	rm -rf dist
