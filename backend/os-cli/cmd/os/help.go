package main

import (
	"fmt"
	"io"
)

func printCommandHelp(out io.Writer, command string) bool {
	help, ok := commandHelp[command]
	if ok {
		fmt.Fprint(out, help)
	}
	return ok
}

func dynamicHelp(command, purpose string) string {
	return fmt.Sprintf("os %s — %s 동적 API 명령을 실행합니다.\n사용법: os %s <subcommand> [flags]\n하위명령: 설치된 Registry manifest에 정의됨\n플래그: -o json, --output json, --preview, --apply, --ca-bundle PEM\n예: os %s list -o json\n    os %s status\n", command, purpose, command, command, command)
}

var commandHelp = map[string]string{
	"login": "os login — 브라우저 승인 또는 일회성 토큰으로 CLI 디바이스를 등록합니다.\n사용법: os login [--web] [--label DEVICE] [--console URL] [--ca-bundle PEM]\n        os login --pat-stdin [--console URL]\n하위명령: 없음\n플래그: --web, --pat-stdin, --id-token TOKEN, --label NAME, --console URL, --registry URL, --api URL, --bff URL, --ca-bundle PEM\n예: os login --web --label build-laptop\n    os login --pat-stdin\n",
	"logout": "os logout — 서버 디바이스 신뢰와 로컬 보안 키를 함께 폐기합니다.\n사용법: os logout\n하위명령: 없음\n플래그: --ca-bundle PEM\n예: os logout\n",
	"whoami": "os whoami — 현재 CLI 세션과 주체 정보를 확인합니다.\n사용법: os whoami [-o json]\n하위명령: 없음\n플래그: -o json, --output json, --ca-bundle PEM\n예: os whoami\n    os whoami -o json\n",
	"device": "os device — 신뢰된 CLI 디바이스를 조회하거나 폐기합니다.\n사용법: os device list | revoke <device-id>\n하위명령: list, revoke\n플래그: -o json, --output json, --ca-bundle PEM\n예: os device list\n    os device revoke 0123456789abcdef\n",
	"token": dynamicHelp("token", "토큰 관련"),
	"auth-policy": dynamicHelp("auth-policy", "인증 정책"),
	"admin": dynamicHelp("admin", "관리자"),
	"registry": "os registry — Console Registry의 capability, plugin, template을 조회합니다.\n사용법: os registry [--kind capability|plugin|template] [-o json]\n하위명령: 없음\n플래그: --kind KIND, -o json, --output json, --ca-bundle PEM\n예: os registry --kind plugin\n    os registry -o json\n",
	"catalog": dynamicHelp("catalog", "카탈로그"),
	"backbone": dynamicHelp("backbone", "백본"),
	"observability": dynamicHelp("observability", "관측성"),
	"audit": dynamicHelp("audit", "감사"),
	"get": "os get — Kubernetes 스타일 리소스를 조회합니다.\n사용법: os get <resource> [name] [-o json]\n하위명령: 없음\n플래그: -o json, --output json, --ca-bundle PEM\n예: os get uipluginpackage\n    os get uipluginpackage shell -o json\n",
	"role": "os role — 사용자 역할을 조회, 부여 또는 회수합니다.\n사용법: os role list | grant <user> <role> | revoke <user> <role>\n하위명령: list, grant, revoke\n플래그: -o json, --output json, --ca-bundle PEM\n예: os role list\n    os role grant alice admin\n",
	"extensions": "os extensions — OCI 확장을 검사, 설치, 활성화 또는 조회합니다.\n사용법: os extensions inspect <image@sha256:digest> | install <image@sha256:digest> --reason TEXT | activate <module-id> | list\n하위명령: inspect, install, activate, list\n플래그: --reason TEXT, -o json, --output json, --ca-bundle PEM\n예: os extensions list\n    os extensions install ghcr.io/acme/mod@sha256:<digest> --reason approved\n",
	"setup": "os setup — 사설 CA 인증서 bundle을 로컬 설정에 저장합니다.\n사용법: os setup ca <file>\n하위명령: ca\n플래그: 없음\n예: os setup ca ./company-ca.pem\n",
}
