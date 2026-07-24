import { Injectable, inject } from '@angular/core';
import { Observable, of, forkJoin } from 'rxjs';
import { map, switchMap, catchError } from 'rxjs/operators';
import { K8sService } from './k8s.service';
import { errText } from '../shared/k8s-error';
import { isRfc1123 } from '../shared/k8s-validate';
import {
  MutationIntent, MutationPlan, MutationOutcome, RiskLevel,
  SarAttrs, DryRunResult, MutationDiff, UndoHandle,
} from './mutation.types';

/**
 * MutationService — 단일 변경 관문(ADR-UI-004 D3 / P6-no-yaml-control-P0 §3).
 * 모든 쓰기가 통과: 검증 → SAR 사전점검 → 위험 3색 등급 → 서버 dryRun(?dryRun=All)
 *   → diff(🟡🔴만) → 확인(주입 콜백) → 실행 → undo/감사.
 * 신규 백엔드 0: 기존 K8sService write 5종 + 프록시 rawQuery passthrough + 임퍼소네이션만 사용.
 * 확인 모달은 소유하지 않는다(호출 컴포넌트가 MutationConfirmComponent로 confirm 콜백 제공).
 */
@Injectable({ providedIn: 'root' })
export class MutationService {
  private k8s = inject(K8sService);

  /** 관문 — confirm은 호출측이 주입(plan→사용자 확인 Observable<boolean>). */
  execute(intent: MutationIntent, confirm: (p: MutationPlan) => Observable<boolean>): Observable<MutationOutcome> {
    // 0) 생성 이름 검증
    if (intent.verb === 'create') {
      const nm = intent.body?.metadata?.name;
      if (nm && !isRfc1123(nm)) return of({ ok: false, error: `이름이 형식에 맞지 않습니다(소문자/숫자/하이픈): ${nm}` });
    }
    // 0) secrets는 백엔드가 전면 차단(403) → 관문에서 사전 거부
    const attrs = intent.sar ?? this.sarFromPath(intent);
    if (attrs.resource === 'secrets') {
      return of({ ok: false, error: '시크릿 쓰기는 현재 정책상 차단되어 있습니다(백엔드 403).' });
    }
    return this.plan(intent).pipe(
      switchMap((p) => {
        if (!p.sarAllowed) return of<MutationOutcome>({ ok: false, error: '이 작업을 수행할 권한이 없습니다.' });
        if (!p.dryRun.ok) return of<MutationOutcome>({ ok: false, error: `미리 검증 실패: ${p.dryRun.error}` });
        return confirm(p).pipe(
          switchMap((yes) => {
            if (!yes) return of<MutationOutcome>({ ok: false, error: '취소됨' });
            return this.dispatch(intent).pipe(
              map((result) => ({ ok: true, result, undo: this.buildUndo(intent) } as MutationOutcome)),
              catchError((e) => of<MutationOutcome>({ ok: false, error: errText(e) })),
            );
          }),
        );
      }),
      catchError((e) => of<MutationOutcome>({ ok: false, error: errText(e) })),
    );
  }

  /** ①~⑤: 위험등급 + SAR + (🟡🔴) dryRun + diff → MutationPlan. */
  plan(intent: MutationIntent): Observable<MutationPlan> {
    const { risk, reasons } = this.assessRisk(intent);
    const confirmTier: MutationPlan['confirmTier'] = risk === 'green' ? 'toast' : risk === 'yellow' ? 'modal' : 'modal+type';
    const sar$ = this.checkAccess(intent.sar ?? this.sarFromPath(intent));
    const dry$: Observable<DryRunResult> = risk === 'green' ? of({ ok: true }) : this.dryRun(intent);
    return forkJoin([sar$, dry$]).pipe(
      map(([sarAllowed, dryRun]) => {
        const diff = risk !== 'green' && dryRun.ok && dryRun.applied
          ? this.computeDiff(intent.before, dryRun.applied) : [];
        return { intent, risk, reasons, sarAllowed, dryRun, diff, confirmTier };
      }),
    );
  }

  /** SelfSubjectAccessReview — 첫 호출처. 실패(인프라)는 보수적으로 통과(백엔드 임퍼소네이션이 최종 게이트). */
  checkAccess(attrs: SarAttrs): Observable<boolean> {
    const body = {
      apiVersion: 'authorization.k8s.io/v1',
      kind: 'SelfSubjectAccessReview',
      spec: { resourceAttributes: { group: attrs.group, resource: attrs.resource, verb: attrs.verb, namespace: attrs.namespace, name: attrs.name, subresource: attrs.subresource } },
    };
    return this.k8s.post('/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', body).pipe(
      map((r: any) => r?.status?.allowed !== false),
      catchError(() => of(true)),
    );
  }

  /** 순수 함수 — 4신호(데이터소실/가용성/연쇄/환경) + verb 기본 → 등급·한국어 사유. 신호 누락 시 보수적 상향. */
  assessRisk(intent: MutationIntent): { risk: RiskLevel; reasons: string[] } {
    const rank: Record<RiskLevel, number> = { green: 0, yellow: 1, red: 2 };
    let risk: RiskLevel = 'green';
    const reasons: string[] = [];
    const bump = (r: RiskLevel, why: string) => { if (rank[r] > rank[risk]) risk = r; reasons.push(why); };
    const s = intent.signals ?? {};
    const path = intent.path.split('?')[0];

    if (intent.verb === 'remove') bump('yellow', '삭제 작업');
    if (intent.verb === 'replace') bump('yellow', '리소스 전체 교체(YAML)');
    if (s.targetsPersistentData) bump('red', '데이터 소실 위험(영구 볼륨/디스크)');
    if (s.affectsAvailability) bump('red', '가용성 영향(마지막 인스턴스/가용성 정책)');
    if ((s.cascadeRefs ?? 0) > 0) bump('yellow', `연쇄 영향 ${s.cascadeRefs}건`);
    if (s.envLabel === 'prod' || s.envLabel === 'protected') bump('red', `보호 환경(${s.envLabel})`);
    // best-effort: 영구 볼륨/네임스페이스 삭제는 신호 없어도 red
    if (intent.verb === 'remove' && /persistentvolume/i.test(path)) bump('red', '영구 볼륨 삭제 — 복구 불가');
    if (intent.verb === 'remove' && /\/namespaces\/[^/]+$/.test(path)) bump('red', '네임스페이스 삭제 — 내부 전체 소멸');

    if (reasons.length === 0) reasons.push('되돌리기 쉬운 안전한 변경');
    return { risk, reasons };
  }

  /** path에 ?dryRun=All 부착 후 dispatch. 실패=실제 write 미발행 신호. */
  dryRun(intent: MutationIntent): Observable<DryRunResult> {
    const p = intent.path + (intent.path.includes('?') ? '&' : '?') + 'dryRun=All';
    return this.raw(p, intent).pipe(
      map((applied) => ({ ok: true, applied } as DryRunResult)),
      catchError((e) => of({ ok: false, error: errText(e) } as DryRunResult)),
    );
  }

  /** before↔after 재귀 diff(잡음 필드 제거, 상위 100건). green이면 호출 skip. */
  computeDiff(before: any, after: any): MutationDiff[] {
    const out: MutationDiff[] = [];
    const walk = (b: any, a: any, path: string) => {
      if (b === a) return;
      const bo = b && typeof b === 'object';
      const ao = a && typeof a === 'object';
      if (!bo && !ao) {
        if (JSON.stringify(b) !== JSON.stringify(a)) {
          out.push({ path, before: b, after: a, kind: b === undefined ? 'add' : a === undefined ? 'remove' : 'change' });
        }
        return;
      }
      if (bo !== ao) { out.push({ path, before: b, after: a, kind: 'change' }); return; }
      const keys = new Set([...Object.keys(b || {}), ...Object.keys(a || {})]);
      for (const k of keys) walk(b?.[k], a?.[k], path ? `${path}.${k}` : k);
    };
    walk(before, after, '');
    return out
      .filter((d) => !/(^|\.)(managedFields|resourceVersion|generation|uid|creationTimestamp|status)(\.|$)/.test(d.path))
      .slice(0, 100);
  }

  // ── 내부 ──
  private dispatch(intent: MutationIntent): Observable<any> { return this.raw(intent.path, intent); }

  /** verb → K8sService 5종. content-type은 patchMerge/patchStrategic가 자체 주입(path+body만 전달). */
  private raw(path: string, intent: MutationIntent): Observable<any> {
    switch (intent.verb) {
      case 'create':
      case 'action': return this.k8s.post(path, intent.body);
      case 'patchMerge': return this.k8s.patchMerge(path, intent.body);
      case 'patchStrategic': return this.k8s.patchStrategic(path, intent.body);
      case 'replace': return this.k8s.replace(path, intent.body);
      case 'remove': return this.k8s.remove(path);
      default: return of(null);
    }
  }

  private buildUndo(intent: MutationIntent): UndoHandle | undefined {
    const bare = intent.path.replace(/\?.*$/, '');
    if (intent.verb === 'create') {
      const nm = intent.body?.metadata?.name;
      if (!nm) return undefined;
      return { label: '생성 취소(삭제)', run: () => this.k8s.remove(`${bare}/${nm}`) };
    }
    if (intent.verb === 'remove' && intent.before) {
      const body = JSON.parse(JSON.stringify(intent.before));
      if (body.metadata) { delete body.metadata.resourceVersion; delete body.metadata.uid; delete body.metadata.creationTimestamp; }
      delete body.status;
      const coll = bare.replace(/\/[^/]+$/, ''); // /name 제거 → 컬렉션
      return { label: '삭제 취소(재생성)', run: () => this.k8s.post(coll, body) };
    }
    if ((intent.verb === 'patchMerge' || intent.verb === 'patchStrategic') && intent.before) {
      const inverse = this.inverseMergePatch(intent.body, intent.before);
      return { label: '되돌리기', run: () => this.k8s.patchMerge(bare, inverse) };
    }
    if (intent.verb === 'replace' && intent.before) {
      return { label: '되돌리기', run: () => this.k8s.replace(bare, intent.before) };
    }
    return undefined;
  }

  /** 적용한 merge patch의 각 키를 before 값으로 되돌리는 역패치. */
  private inverseMergePatch(patch: any, before: any): any {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return before;
    const out: any = {};
    for (const k of Object.keys(patch)) out[k] = this.inverseMergePatch(patch[k], before?.[k]);
    return out;
  }

  /** path → SAR resourceAttributes. /api/v1/... 또는 /apis/<grp>/<ver>/... 파싱. */
  private sarFromPath(intent: MutationIntent): SarAttrs {
    const verbMap: Record<string, string> = { create: 'create', action: 'create', patchMerge: 'patch', patchStrategic: 'patch', replace: 'update', remove: 'delete' };
    const seg = intent.path.split('?')[0].split('/').filter(Boolean);
    let group = '';
    let idx = 0;
    if (seg[0] === 'api') { group = ''; idx = 2; }
    else if (seg[0] === 'apis') { group = seg[1]; idx = 3; }
    let rest = seg.slice(idx);
    let namespace: string | undefined;
    if (rest[0] === 'namespaces') { namespace = rest[1]; rest = rest.slice(2); }
    const resource = rest[0] || '';
    const name = rest[1];
    const subresource = rest[2];
    return { group, resource, verb: verbMap[intent.verb] || 'update', namespace, name, subresource };
  }
}
