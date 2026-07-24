import { Diagnosis, DiagAction } from './diagnose.model';

/**
 * C3 규칙 SSOT(ADR-UI-004 D4 / §5.2, 전략 §2.4 표 1:1). 순수 함수.
 * Pod containerStatuses(waiting/lastState) + Warning 이벤트 → 평문 한국어 진단 + 추천 액션.
 * overview(Health 집계)·App View·상세 카드가 모두 이 모듈을 import(중복 금지).
 * secrets: CreateContainerConfigError는 ConfigMap만 안내(Secret 값 미표시 — 백엔드 403).
 */
const A = {
  logs: (hint?: string): DiagAction => ({ label: '최근 로그', kind: 'logs', hint }),
  explain: (): DiagAction => ({ label: '설명 더 보기', kind: 'explain' }),
  cfg: (): DiagAction => ({ label: '연결된 설정 보기', kind: 'navigate', hint: 'config' }),
  image: (): DiagAction => ({ label: '이미지 주소 확인', kind: 'editField', hint: 'image' }),
  mem: (): DiagAction => ({ label: '메모리 한도 올리기', kind: 'editField', hint: 'resources.limits.memory' }),
  nodes: (): DiagAction => ({ label: '노드 여유 보기', kind: 'navigate', hint: 'nodes' }),
  health: (): DiagAction => ({ label: '헬스체크 설정', kind: 'editField', hint: 'probes' }),
  disk: (): DiagAction => ({ label: '디스크 상태 보기', kind: 'navigate', hint: 'pvc' }),
};

function waitingRule(reason: string, container: string): Diagnosis | null {
  const source = `containerStatuses[${container}].state.waiting.reason=${reason}`;
  switch (reason) {
    case 'CrashLoopBackOff':
      return { code: 'CrashLoopBackOff', severity: 'danger', title: '앱이 켜지자마자 계속 죽고 있어요(재시작 반복).', detail: '보통 코드 오류나 잘못된 설정입니다.', actions: [A.logs(container), A.cfg(), A.explain()], source };
    case 'ImagePullBackOff':
    case 'ErrImagePull':
      return { code: 'ImagePull', severity: 'danger', title: '앱 이미지를 받아오지 못합니다.', detail: '이미지 이름 오타이거나 비공개 저장소 인증이 없을 수 있어요.', actions: [A.image(), A.explain()], source };
    case 'CreateContainerConfigError':
      return { code: 'ConfigError', severity: 'danger', title: '설정(ConfigMap)이 없거나 잘못 연결됐습니다.', detail: '참조하는 ConfigMap/키를 확인하세요.', actions: [A.cfg(), A.explain()], source };
    case 'CreateContainerError':
      return { code: 'ContainerError', severity: 'danger', title: '컨테이너를 생성하지 못했습니다.', detail: '커맨드/마운트/설정을 확인하세요.', actions: [A.logs(container), A.explain()], source };
    default:
      return null;
  }
}

export function diagnosePod(pod: any): Diagnosis[] {
  const out: Diagnosis[] = [];
  const cs = pod?.status?.containerStatuses ?? [];
  for (const c of cs) {
    const w = c?.state?.waiting?.reason;
    if (w) { const d = waitingRule(w, c.name); if (d) out.push(d); }
    if (c?.lastState?.terminated?.reason === 'OOMKilled') {
      out.push({ code: 'OOMKilled', severity: 'danger', title: '메모리가 부족해 강제 종료됐습니다(OOMKilled).', detail: '메모리 한도를 올리거나 사용량을 줄이세요.', actions: [A.mem(), A.logs(c.name)], source: `containerStatuses[${c.name}].lastState.terminated.reason=OOMKilled` });
    }
  }
  return out;
}

export function diagnoseEvents(events: any[]): Diagnosis[] {
  const out: Diagnosis[] = [];
  for (const e of events ?? []) {
    if (e?.type !== 'Warning') continue;
    const r = e?.reason;
    const source = `event.reason=${r}`;
    if (r === 'FailedScheduling') {
      if (/persistentvolumeclaim|unbound|volume/i.test(e?.message || '')) {
        out.push({ code: 'PVCUnbound', severity: 'warning', title: '디스크(볼륨) 준비가 안 됐습니다.', detail: 'PVC 바인딩 상태를 확인하세요.', actions: [A.disk(), A.explain()], source });
      } else {
        out.push({ code: 'Unschedulable', severity: 'warning', title: '띄울 자리가 없습니다(스케줄 실패).', detail: '노드 자원 부족이거나 배치 조건 불일치입니다.', actions: [A.nodes(), A.explain()], source });
      }
    } else if (r === 'Unhealthy') {
      out.push({ code: 'Unhealthy', severity: 'warning', title: "켜졌지만 '준비됨' 신호를 안 보냅니다(헬스체크 실패).", detail: '헬스체크 경로/지연 설정을 확인하세요.', actions: [A.health(), A.explain()], source });
    } else if (r === 'FailedMount') {
      out.push({ code: 'FailedMount', severity: 'warning', title: '볼륨 마운트에 실패했습니다.', detail: 'PVC/ConfigMap 마운트 연결을 확인하세요.', actions: [A.disk(), A.explain()], source });
    }
  }
  return out;
}

/** 병합 + code dedup + danger 우선 정렬. overview·App View·카드 공용 진입점. */
export function diagnose(pod: any, events: any[]): Diagnosis[] {
  const all = [...diagnosePod(pod), ...diagnoseEvents(events)];
  const seen = new Set<string>();
  const dedup: Diagnosis[] = [];
  for (const d of all) { if (!seen.has(d.code)) { seen.add(d.code); dedup.push(d); } }
  return dedup.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'danger' ? -1 : 1));
}
