import {releaseLabel} from '../core/release-display';
import { ChangeDetectionStrategy, Component, ElementRef, Input, OnDestroy, OnInit, ViewChild, computed, effect, inject, signal } from '@angular/core';
import { RouterLink, ActivatedRoute, Router } from '@angular/router';
import { ClarityModule } from '@clr/angular';
import { HttpService } from '../core/http.service';
import { AuthService } from '../core/auth.service';
import { PluginControlClient, Registration, OperationReceipt } from '../core/plugin-control-client.service';
import { ExtensionHostService } from '../core/extension-host.service';
import { PLATFORM_MODULES, ModuleCandidate, moduleCandidate, moduleCatalogFresh, moduleStatus, operationStage, operationInProgress, validInstallReceipt } from './module-installation-state';

interface Snapshot { schema: string; revision: string; stale: boolean; observedAt: string; inventory: { descriptors: ModuleCandidate[] }; sources: Record<string, {ready: boolean; reason?: string}>; }
interface Candidate { descriptorId: string; image: string; catalogRevision: string; channel: string; compatibilityVersion: string; sourceRevision: string; }
interface Receipt extends OperationReceipt { executionPlan?: {descriptorId?: string}; planRevision?: string; actorRef?: string; reason?: string; error?: {code?: string; message?: string}; }

/** CON-FR-007/014/017 · C_WEB · RT-MODULE-01: existing C_API/C_REG/C_EXT contracts. */
@Component({
  selector: 'os-admin-modules', imports: [RouterLink, ClarityModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-modules.html', styleUrl: './admin-modules.scss',
})
export class AdminModules implements OnInit, OnDestroy {
  @Input() embedded=false;
  @ViewChild('installationDrawer', {static: true}) private drawer!: ElementRef<HTMLDialogElement>;
  readonly releaseLabel=releaseLabel;
  readonly search=signal('');
  readonly visibleModules=computed(()=>this.modules.filter(m=>(m.name+' '+m.description).toLowerCase().includes(this.search().toLowerCase())));
  readonly pictogram=(id:string)=>'/assets/pictograms/'+({ 'cluster-manager':'cloud-infrastructure-management',foundation:'microservices',workspace:'connected-ecosystem',developer:'developer-tools',pulse:'systems','ai-workbench':'intelligence' } as Record<string,string>)[id]+'.svg';
  private readonly http = inject(HttpService);
  private readonly auth = inject(AuthService);
  private readonly control = inject(PluginControlClient);
  private readonly extensions = inject(ExtensionHostService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly modules = PLATFORM_MODULES;
  readonly snapshot = signal<Snapshot | null>(null);
  readonly registrations = signal<Registration[]>([]);
  readonly fresh = signal(false);
  readonly runtimeFresh = signal(false);
  readonly busy = signal(false);
  readonly loaded = signal(false);
  readonly reviewOpen = signal(false);
  readonly reviewError = signal('');
  readonly error = signal('');
  readonly registryState = signal('확인 중');
  readonly selected = signal('');
  readonly candidate = signal<Candidate | null>(null);
  readonly receipt = signal<Receipt | null>(null);
  readonly reason = signal('');
  readonly stages = ['설치 확인', '설치 접수', '배포 중', '실제 동작 검증', '설치 완료'];
  readonly submitted = computed(() => Boolean(this.receipt()?.operationId));
  readonly installedReceiptReady = computed(() => this.receipt()?.state === 'Verified' && this.status(this.selected()).ready
    && this.registrations().find(r => r.name === this.selected())?.status.currentDigest === this.receipt()?.targetRef?.split('@')[1]);
  readonly activeStage = computed(() => operationStage(this.receipt()?.state || ''));
  readonly operationPending = computed(() => operationInProgress(this.receipt()?.state || ''));
  readonly selectedModule = computed(() => this.modules.find(m => m.id === this.selected()));
  readonly status = (id: string) => moduleStatus(this.fresh(), moduleCandidate(id, this.snapshot()?.inventory?.descriptors || []), this.registrations().find(r => r.name === id), this.runtimeFresh());
  readonly available = (id: string) => moduleCandidate(id, this.snapshot()?.inventory?.descriptors || []);
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private refreshing = false;
  private installKey = '';
  private submittedBody = '';
  private inspectionEpoch = 0;

  constructor() {
    effect(() => {
      const open = this.reviewOpen();
      const mfa = this.auth.stepUpRequired();
      const dialog = this.drawer?.nativeElement;
      // Native top-layer dialog must release focus while the shared MFA modal is active.
      if (dialog?.open && (!open || mfa)) dialog.close();
      else if (dialog && open && !mfa && !dialog.open) dialog.showModal();
    });
  }

  async ngOnInit() {
    const op = this.route.snapshot.queryParamMap.get('operation');
    if (op && /^[0-9a-f-]{36}$/.test(op)) this.receipt.set({ operationId: op } as Receipt);
    await this.refresh();
    if (this.receipt()?.executionPlan?.descriptorId) {
      this.selected.set(this.receipt()!.executionPlan!.descriptorId!.replace(/^extension\./, ''));
      this.reviewOpen.set(true);
    }
    this.schedule();
  }
  ngOnDestroy() { this.stopped = true; clearTimeout(this.timer); this.closeReview(); }
  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(async () => { await this.refresh(); this.schedule(); }, 5000);
  }
  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.http.request(path, init);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${body.message || body.error?.message || body.error || '요청 실패'} (HTTP ${response.status})`);
    return body as T;
  }
  async refresh() {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    try {
      const [catalogResult, registrationResult] = await Promise.allSettled([
        this.json<Snapshot>('/api/v1/registry', {cache: 'no-store'}), this.control.registrationsSnapshot(),
      ]);
      if (registrationResult.status === 'fulfilled' && Array.isArray(registrationResult.value.items)) {
        this.registrations.set(registrationResult.value.items);
        this.runtimeFresh.set(registrationResult.value.projection?.state === 'live' && registrationResult.value.projection.ready === true);
      } else { this.runtimeFresh.set(false); }
      if (catalogResult.status === 'rejected') throw catalogResult.reason;
      const snapshot = catalogResult.value;
      if (snapshot.schema !== 'opensphere.registry-catalog/v1' || !/^sha256:[a-f0-9]{64}$/.test(snapshot.revision)
        || !Array.isArray(snapshot.inventory?.descriptors)) throw new Error('설치 목록 응답이 유효하지 않습니다.');
      this.snapshot.set(snapshot);
      this.fresh.set(moduleCatalogFresh(snapshot));
      if (this.candidate() && this.candidate()!.catalogRevision !== snapshot.revision && !this.submittedBody) {
        this.candidate.set(null); this.reviewError.set('배포 목록이 바뀌었습니다. 현재 배포본을 다시 확인하세요.');
      }
      this.error.set('');
    } catch (error) { this.fresh.set(false); this.error.set(String(error)); }
    this.loaded.set(true);
    try {
      const connection = await this.control.registryCredentialStatus();
      this.registryState.set(connection.phase || connection.configurationState || '확인 필요');
    } catch { this.registryState.set('연결 확인 실패'); }
    const previous = this.receipt();
    if (previous?.operationId) {
      try {
        const receipt = await this.json<Receipt>(`/api/platform/operations/${previous.operationId}`, {cache: 'no-store'});
        if (!validInstallReceipt(receipt) || receipt.operationId !== previous.operationId) throw new Error('설치 작업 식별자가 일치하지 않습니다.');
        this.receipt.set(receipt);
        if (receipt.state === 'Verified' && previous.state !== 'Verified') await this.extensions.reload();
      } catch (error) { this.error.set(String(error)); }
    }
    this.refreshing = false;
  }
  async inspect(id: string) {
    if (this.busy() || this.operationPending() || this.submittedBody && this.candidate() || !this.status(id).installable) return;
    const epoch = ++this.inspectionEpoch;
    this.busy.set(true); this.reviewError.set(''); this.candidate.set(null); this.selected.set(id); this.receipt.set(null);
    this.reviewOpen.set(true);
    // A modal native dialog enters the top layer immediately, traps focus and makes the page inert.
    // Closing it invalidates this inspection so a late network response cannot reopen an old review.
    if (!this.drawer.nativeElement.open) this.drawer.nativeElement.showModal();
    this.installKey = crypto.randomUUID(); this.submittedBody = '';
    try {
      const result = await this.json<{data: {candidate: Candidate}}>('/api/admin/extensions/inspect', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({descriptorId: `extension.${id}`, catalogRevision: this.snapshot()!.revision}),
      });
      if (this.stopped || epoch !== this.inspectionEpoch || !this.reviewOpen()) return;
      const candidate = result.data?.candidate;
      if (candidate?.descriptorId !== `extension.${id}` || candidate.catalogRevision !== this.snapshot()?.revision
        || !/^ghcr\.io\/opensphere-platform\/[a-z0-9._-]+@sha256:[a-f0-9]{64}$/.test(candidate.image)) throw new Error('설치 후보가 현재 선택과 일치하지 않습니다.');
      this.candidate.set(candidate); this.reason.set(`Console Drawer에서 ${this.selectedModule()?.name || id} 설치 확인`);
    } catch (error) { if (epoch === this.inspectionEpoch && !this.stopped) this.reviewError.set(String(error)); }
    finally { if (epoch === this.inspectionEpoch) this.busy.set(false); }
  }
  closeReview(event?: Event) {
    event?.preventDefault();
    ++this.inspectionEpoch;
    this.reviewOpen.set(false);
    if (!this.submittedBody) { this.candidate.set(null); this.busy.set(false); }
    if (this.drawer?.nativeElement.open) this.drawer.nativeElement.close();
  }
  async install() {
    const candidate = this.candidate();
    if (!candidate || this.busy() || !this.fresh() || !this.runtimeFresh()) return;
    if (this.reason().trim().length < 8) return;
    this.busy.set(true); this.error.set('');
    this.submittedBody ||= JSON.stringify({descriptorId: candidate.descriptorId, catalogRevision: candidate.catalogRevision, reason: this.reason().trim()});
    try {
      const receipt = await this.json<Receipt>('/api/admin/extensions/install', {
        method: 'POST', headers: {'content-type':'application/json','x-os-idempotency-key': this.installKey}, body: this.submittedBody,
      });
      if (!validInstallReceipt(receipt) || receipt.targetRef !== candidate.image) throw new Error('설치 작업 응답을 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.');
      this.receipt.set(receipt); this.candidate.set(null);
      await this.router.navigate([], {relativeTo: this.route, queryParams: {operation: receipt.operationId}, queryParamsHandling: 'merge'});
      await this.refresh();
    } catch (error) { this.reviewError.set(`${String(error)}. 응답이 불명확한 경우 같은 설치 요청으로 재시도합니다.`); }
    finally { this.busy.set(false); }
  }
}
