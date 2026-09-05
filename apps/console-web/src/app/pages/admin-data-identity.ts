import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import Renew16 from '@carbon/icons/es/renew/16';
import { HttpService } from '../core/http.service';
import { CarbonIcon } from '../os/carbon-icon';
import { OsPageHeader } from '../os/os-page-header';
import { identityFailure, identityRuntimeReady, isIdentityFresh, parseIdentityStatus } from './data-identity-state';
import type { ComponentId, HealthState, IdentityComponent, IdentityStatus } from './data-identity-state';

@Component({
  selector: 'os-admin-data-identity',
  imports: [ClarityModule, RouterLink, CarbonIcon, OsPageHeader],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-data-identity.html',
  styles: [`
    .page-lead{display:flex;align-items:flex-start;gap:1rem;justify-content:space-between}.page-lead p{max-width:58rem}.page-meta{white-space:nowrap;display:flex;align-items:center;gap:.5rem;font-size:.65rem}
    .workspace-tabs button:focus-visible,a:focus-visible{outline:2px solid var(--os-accent);outline-offset:3px}.panel{margin:.8rem 0;padding:1rem;border:1px solid var(--os-hairline);background:var(--os-canvas)}h2{font-size:1rem;margin:0 0 .6rem}h3{font-size:.8rem}.muted,.help{color:var(--os-ink-muted);font-size:.72rem}.actions{display:flex;flex-wrap:wrap;gap:.6rem 1rem;margin:.7rem 0}.actions a{font-size:.72rem}.notice{padding:.7rem 1rem;margin:.7rem 0;border-left:3px solid #a15c00;background:var(--os-surface-1);font-size:.75rem}.status{font-size:.68rem;font-weight:600;white-space:nowrap}.ok{color:var(--os-success)}.warn{color:#8a5000}.danger{color:var(--os-danger)}.scroll{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:.72rem;text-align:left}caption{text-align:left;font-size:.8rem;font-weight:600;margin:.5rem 0}th,td{border-bottom:1px solid var(--os-hairline);padding:.55rem .65rem;vertical-align:top}th{background:var(--os-surface-1);font-size:.65rem}td small{display:block;color:var(--os-ink-muted);font-size:.63rem;margin-top:.25rem}.mono{font-family:monospace;overflow-wrap:anywhere;font-size:.68rem}dl{display:grid;grid-template-columns:9rem minmax(0,1fr);gap:.45rem;margin:.5rem 0}dt{color:var(--os-ink-muted);font-size:.7rem}dd{margin:0;font-size:.73rem}.two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.8rem}.domains{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.6rem}.domains .panel{margin:0}.empty{padding:1rem;color:var(--os-ink-muted)}.checks{min-width:45rem}.state-note{font-size:.65rem;margin:.25rem 0}
    @media(max-width:64rem){.domains,.two{grid-template-columns:1fr}.page-lead{flex-direction:column}.page-meta{white-space:normal}dl{grid-template-columns:1fr}.workspace-tabs{overflow-x:auto}}
  `],
})
export class AdminDataIdentity implements OnInit, OnDestroy {
  readonly icons = { renew: Renew16 };
  readonly tabs = [
    { id:'overview',label:'Overview',help:'기반 상태와 필요한 조치' },
    { id:'database',label:'Database',help:'DB 버전·데이터 보호' },
    { id:'auth',label:'Auth & Access',help:'운영자·세션·역할' },
    { id:'api',label:'API',help:'연결과 조회 근거' },
    { id:'storage',label:'Storage',help:'버킷 정책·복구' },
    { id:'security',label:'Security & DR',help:'백업·복원 실증' },
    { id:'integrations',label:'Integrations',help:'DB 접근 주체' },
  ];
  readonly activeTab = signal('overview');
  readonly status = signal<IdentityStatus | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly clock = signal(Date.now());
  readonly fresh = computed(() => { const s=this.status(); return Boolean(s && !this.error() && isIdentityFresh(s,this.clock())); });
  readonly runtimeReady = computed(() => { const s=this.status(); return Boolean(s && this.fresh() && identityRuntimeReady(s)); });
  readonly healthyCount = computed(() => this.fresh() ? this.status()?.data.components.filter(c=>c.state==='Ready').length || 0 : 0);
  private readonly http = inject(HttpService);
  private poll?: ReturnType<typeof setInterval>;
  private tick?: ReturnType<typeof setInterval>;
  private destroyed = false;
  ngOnInit(): void { void this.refresh(); this.poll=setInterval(()=>void this.refresh(),15000); this.tick=setInterval(()=>this.clock.set(Date.now()),5000); }
  ngOnDestroy(): void { this.destroyed=true; if(this.poll)clearInterval(this.poll); if(this.tick)clearInterval(this.tick); }
  async refresh(): Promise<void> {
    if(this.busy() || this.destroyed)return;
    this.busy.set(true);
    try {
      const response=await this.http.request('/api/identity/supabase/status',{cache:'no-store'});
      if(this.destroyed)return;
      if(!response.ok){ if(response.status===401 || response.status===403)this.status.set(null); this.error.set(identityFailure(response.status)); return; }
      let next: IdentityStatus;
      try { next=parseIdentityStatus(await response.json()); } catch { this.error.set(identityFailure('contract')); return; }
      this.status.set(next); this.error.set(''); this.clock.set(Date.now());
    } catch { if(!this.destroyed)this.error.set(identityFailure('network')); }
    finally { if(!this.destroyed)this.busy.set(false); }
  }
  tabKey(event: KeyboardEvent): void {
    const keys=['ArrowLeft','ArrowRight','Home','End']; if(!keys.includes(event.key))return;
    event.preventDefault(); const i=this.tabs.findIndex(t=>t.id===this.activeTab());
    const next=event.key==='Home'?0:event.key==='End'?this.tabs.length-1:(i+(event.key==='ArrowRight'?1:-1)+this.tabs.length)%this.tabs.length;
    this.activeTab.set(this.tabs[next].id);
    (event.currentTarget as HTMLElement).closest('[role="tablist"]')?.querySelector<HTMLButtonElement>('#di-tab-'+this.tabs[next].id)?.focus();
  }
  component(id: ComponentId): IdentityComponent { return this.status()!.data.components.find(c=>c.component===id)!; }
  state(c: IdentityComponent): HealthState { return this.fresh()?c.state:'Unknown'; }
  label(state: string): string { return ({Ready:'정상',Blocked:'차단',Unknown:'미확인',Degraded:'보완 필요',Partial:'일부 확인'} as Record<string,string>)[state] || '미확인'; }
  tone(state: string): string { return state==='Ready'?'status ok':state==='Blocked'?'status danger':'status warn'; }
  name(id: string): string { return ({database:'PostgreSQL',auth:'로그인 · Supabase Auth',dataApi:'데이터 API · PostgREST',storage:'파일 저장 · Storage',migration:'DB 구조 · Migration',rls:'데이터 접근 보호',backup:'백업 증거',restore:'격리 복원 증거',supabaseDatabase:'Supabase DB',supabaseStorage:'Supabase Storage',gitea:'Gitea'} as Record<string,string>)[id] || id; }
  reason(code: string | null | undefined): string {
    if(!code)return '판정 근거 확인됨';
    return ({RlsCoverageIncomplete:'RLS 보호 대상 또는 정책이 기준과 다릅니다.',RuntimeGrantPresent:'관리자 전용 테이블에 다른 접근 권한이 있습니다.',TableMissing:'필수 테이블이 없습니다.',TableUnclassified:'보호 방식이 분류되지 않은 테이블입니다.',RecoveryEvidenceUnavailable:'Recovery Owner가 기록한 복구 증거가 없습니다.',RecoveryEvidenceInvalid:'복구 증거 형식이 유효하지 않습니다.',RecoveryPolicyInvalid:'복구 증거의 유효기간·격리 시험 정책이 없습니다.',RecoveryEvidenceStale:'복구 증거 유효기간이 지났거나 시각이 잘못됐습니다.',BackupUnverified:'유효한 백업 검증 기록이 없습니다.',RestoreUnverified:'필수 복원 시험 근거가 부족합니다.',RestoreMigrationMismatch:'복원한 DB와 현재 migration이 일치하지 않습니다.',EvidenceUnavailable:'검증 근거가 연결되지 않았습니다.',LiveProbeUnavailable:'실시간 연결 점검이 없습니다.',DependencyTimeout:'서비스 응답 시간이 초과됐습니다.',AuthorityUnavailable:'서비스에 연결할 수 없습니다.',HealthCheckFailed:'서비스 상태 점검이 실패했습니다.',HealthContractInvalid:'서비스 응답 형식이 잘못됐습니다.',BaselineObjectsMissing:'필수 DB 함수 또는 테이블이 없습니다.',MigrationLedgerMissing:'마이그레이션 원장이 없습니다.',MigrationLedgerInvalid:'마이그레이션 원장 순서가 잘못됐습니다.',MigrationTargetMismatch:'설치된 DB 구조가 이 API 이미지의 목표 migration과 다릅니다.'} as Record<string,string>)[code] || code;
  }
  date(value: string | null | undefined): string { return value?new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',dateStyle:'short',timeStyle:'medium'}).format(new Date(value))+' KST':'기록 없음'; }
  size(bytes: number | null): string { return bytes===null?'버킷별 한도 미지정':`${Math.round(bytes/1024)} KiB`; }
}
