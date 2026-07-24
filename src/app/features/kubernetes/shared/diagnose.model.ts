// C3 Diagnose 타입(ADR-UI-004 D4 / P6-no-yaml-control-P0 §5). 읽기 전용 진단.
export type DiagSeverity = 'warning' | 'danger'; // 초록(정상)=카드 미표시

export interface DiagAction {
  label: string;
  kind: 'logs' | 'navigate' | 'editField' | 'explain';
  hint?: string; // logs=container명, editField=필드경로, navigate=대상 등
}

export interface Diagnosis {
  code: string;        // dedup 키
  severity: DiagSeverity;
  title: string;       // 평문 한국어 1줄
  detail?: string;
  actions: DiagAction[];
  source: string;      // 근거(필드 경로/이벤트) — 근거 없는 진단 금지(AC8)
}
