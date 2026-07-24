import { CommonModule } from '@angular/common';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClarityModule } from '@clr/angular';
import { CEPH_PROVIDER_GUIDE, CephPlan, CephProviderGuide, CephService, CephStatus } from '../core/ceph.service';

@Component({
  selector: 'app-res-ceph',
  standalone: true,
  imports: [CommonModule, FormsModule, ClarityModule],
  template: `
    <header class="cm-ceph-page-head">
      <div class="cm-ceph-page-head__copy">
        <p class="cm-ceph-eyebrow">Kubernetes child storage</p>
        <h1>Ceph External Storage</h1>
        <p class="cm-ceph-summary">Ceph은 Console에 직접 마운트하지 않습니다. 선택한 Kubernetes 클러스터에 Rook External Mode와 Ceph CSI를 구성하고, Console은 연결 상태와 참조 정보만 관리합니다.</p>
      </div>
      <div class="cm-ceph-page-head__actions">
        <button class="btn btn-outline" type="button" [disabled]="loading() || busy()" (click)="load()">다시 검사</button>
        <button class="btn btn-primary" type="button" [disabled]="busy() || status()?.kubernetes?.ready !== true || status()?.ownerPrerequisites?.ready !== true || !!status()?.connection" (click)="openConnect()">외부 Ceph 연결</button>
      </div>
    </header>

    <div *ngIf="error()" class="alert alert-danger" role="alert">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">{{ error() }}</span></div></div>
    </div>
    <div *ngIf="notice()" class="alert alert-success" role="status">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">{{ notice() }}</span></div></div>
    </div>
    <div *ngIf="status()?.ownerPrerequisites?.ready === false" class="alert alert-warning" role="status">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">
        <strong>Ceph 제어 준비 미완료:</strong> {{ status()?.ownerPrerequisites?.blockers?.join(' · ') }}
      </span></div></div>
    </div>

    <section class="dependency" *ngIf="status() as s">
      <div class="dependency-title">
        <span class="sequence">1</span>
        <div><strong>Kubernetes 연결</strong><span>Ceph 연결보다 먼저 성립해야 하는 부모 클러스터</span></div>
        <span class="label" [class.label-success]="s.kubernetes.ready" [class.label-danger]="!s.kubernetes.ready">{{ s.kubernetes.ready ? 'Ready' : 'Blocked' }}</span>
      </div>
      <dl>
        <dt>Cluster fingerprint</dt><dd>{{ s.kubernetes.id || '확인 불가' }}</dd>
        <dt>Kubernetes</dt><dd>{{ s.kubernetes.version || '확인 불가' }}</dd>
        <dt>Nodes</dt><dd>{{ s.kubernetes.readyNodes || 0 }}/{{ s.kubernetes.nodes || 0 }} Ready</dd>
      </dl>
      <div class="connector" aria-hidden="true"></div>
      <div class="dependency-title child">
        <span class="sequence">2</span>
        <div><strong>Ceph External 연결</strong><span>Rook operator · external CephCluster · Ceph CSI</span></div>
        <span class="label" [class.label-success]="s.state === 'Ready'" [class.label-warning]="s.state === 'Degraded' || s.state === 'NotConfigured'" [class.label-danger]="s.state === 'Blocked'">{{ s.state }}</span>
      </div>
      <p class="status-message">{{ s.message }}</p>
    </section>

    <div class="alert alert-info" role="note">
      <div class="alert-items"><div class="alert-item static"><span class="alert-text">
        <strong>보안 경계:</strong> provider export는 허용된 ConfigMap·제한된 CSI Secret·StorageClass만 통과합니다. 원문 자격 증명은 Console/Backbone에 저장하지 않고 대상 Kubernetes Secret에만 기록됩니다. 외부 Ceph pool·filesystem·data는 생성하거나 삭제하지 않습니다.
      </span></div></div>
    </div>

    <section class="readiness-board" *ngIf="status() as s">
      <div class="card-head">
        <div><h2>외부 Ceph 연결 준비</h2><p>Consumer Kubernetes와 Provider Ceph의 조건을 모두 충족해야 연결을 시작할 수 있습니다.</p></div>
        <span class="label" [class.label-success]="s.ownerPrerequisites?.ready" [class.label-warning]="!s.ownerPrerequisites?.ready">
          {{ s.ownerPrerequisites?.ready ? 'Consumer Ready' : 'Consumer 준비 필요' }}
        </span>
      </div>
      <div class="readiness-grid">
        <article class="readiness-panel">
          <h3>Consumer Kubernetes 실측</h3>
          <ul class="status-checks">
            <li>
              <span class="status-dot" [class.ready]="s.kubernetes.ready"></span>
              <span><strong>Kubernetes</strong><small>{{ s.kubernetes.readyNodes || 0 }}/{{ s.kubernetes.nodes || 0 }} nodes Ready</small></span>
              <a *ngIf="!s.kubernetes.ready" class="prereq-action" href="/p/cluster-manager">상태 점검</a>
            </li>
            <li>
              <span class="status-dot" [class.ready]="consumerNamespacesReady(s)"></span>
              <span><strong>전용 namespace</strong><small>rook-ceph · opensphere-ceph-imports</small></span>
              <a *ngIf="!consumerNamespacesReady(s)" class="prereq-action" href="/manage/change-control?template=ceph-rook-prerequisite&amp;source=runtime-owner">일괄 설치 요청</a>
            </li>
            <li>
              <span class="status-dot" [class.ready]="s.ownerPrerequisites?.cephClusterCrdReady"></span>
              <span><strong>CephCluster CRD</strong><small>signed platform release가 사전 설치</small></span>
              <a *ngIf="!s.ownerPrerequisites?.cephClusterCrdReady" class="prereq-action" href="/manage/change-control?template=ceph-rook-prerequisite&amp;source=crd">CRD 설치 요청</a>
            </li>
            <li>
              <span class="status-dot" [class.ready]="s.ownerPrerequisites?.operatorReady"></span>
              <span><strong>Rook operator {{ providerGuide(s).rookVersion }}</strong><small>rook-ceph namespace에서 Ready</small></span>
              <a *ngIf="!s.ownerPrerequisites?.operatorReady" class="prereq-action" href="/manage/change-control?template=ceph-rook-prerequisite&amp;source=operator">Operator 설치 요청</a>
            </li>
            <li>
              <span class="status-dot" [class.ready]="s.ownerPrerequisites?.missingPermissions?.length === 0"></span>
              <span><strong>Cluster Manager RBAC</strong><small>{{ s.ownerPrerequisites?.missingPermissions?.length || 0 }}개 누락</small></span>
              <a *ngIf="(s.ownerPrerequisites?.missingPermissions?.length || 0) > 0" class="prereq-action" href="/manage/change-control?template=ceph-rook-prerequisite&amp;source=runtime-rbac">RBAC 적용 요청</a>
            </li>
            <li>
              <span class="status-dot optional" [class.ready]="s.ownerPrerequisites?.snapshotApiReady"></span>
              <span><strong>VolumeSnapshot API</strong><small>선택 사항 · 없으면 snapshot class 생성을 생략</small></span>
              <a *ngIf="!s.ownerPrerequisites?.snapshotApiReady" class="prereq-action optional" href="/manage/change-control">설치 검토</a>
            </li>
          </ul>
          <div *ngIf="s.ownerPrerequisites?.ready === false" class="prereq-next">
            <p><strong>설치가 필요한가요?</strong> Rook·CRD·RBAC는 브라우저에서 임의 Helm 명령으로 설치하지 않고, 서명된 플랫폼 변경으로 요청·승인·적용합니다.</p>
            <div>
              <a class="btn btn-sm btn-outline" href="/manual?doc=help-center%2Fperspective-02-k8s-cluster-ceph">설치 가이드</a>
              <a class="btn btn-sm btn-primary" href="/manage/change-control?template=ceph-rook-prerequisite&amp;source=readiness">Rook 선행요소 설치 요청</a>
              <button class="btn btn-sm btn-outline" type="button" [disabled]="loading() || busy()" (click)="load()">설치 후 다시 검사</button>
            </div>
          </div>
          <div *ngIf="s.ownerPrerequisites?.blockers?.length" class="blocker-list">
            <strong>현재 차단 사유</strong>
            <ul><li *ngFor="let blocker of s.ownerPrerequisites.blockers">{{ blocker }}</li></ul>
          </div>
        </article>

        <article class="readiness-panel">
          <h3>대상 Ceph에서 받아야 할 정보</h3>
          <dl class="provider-info">
            <ng-container *ngFor="let item of providerGuide(s).requiredInformation">
              <dt>{{ item.label }} <span *ngIf="item.secret" class="label label-info">민감</span></dt>
              <dd>{{ item.description }}</dd>
            </ng-container>
          </dl>
          <p class="scope-note"><strong>입력하지 않는 정보:</strong> {{ providerGuide(s).unsupportedInputs.join(' · ') }}</p>
        </article>
      </div>

      <article class="provider-preparation">
        <h3>대상 Ceph 필수 준비</h3>
        <div class="preparation-grid">
          <div *ngFor="let item of providerGuide(s).requiredPreparation">
            <strong>{{ item.label }}</strong><span>{{ item.description }}</span>
          </div>
        </div>
        <div class="network-contract">
          <strong>필수 네트워크</strong>
          <span>모든 Kubernetes node → MON TCP {{ providerGuide(s).network.monitorTcpPorts.join('/') }}, OSD·MDS public TCP {{ providerGuide(s).network.cephDaemonTcpRange }}</span>
        </div>
        <div class="command-block">
          <span>Provider Ceph 관리자 실행 예시 · RBD 또는 CephFS 인자를 실제 이름으로 확정</span>
          <code>{{ providerGuide(s).export.commandTemplate }}</code>
        </div>
      </article>
    </section>

    <ng-container *ngIf="status() as s">
      <section class="connection-card" *ngIf="s.connection as connection; else emptyConnection">
        <div class="card-head">
          <div><h2>연결 정보</h2><p>Rook External Mode · {{ connection.chartVersion }}</p></div>
          <button class="btn btn-danger-outline" type="button" [disabled]="busy()" (click)="openDisconnect()">연결 해제</button>
        </div>
        <dl class="connection-meta">
          <dt>FSID fingerprint</dt><dd><code>{{ connection.fsidFingerprint }}</code></dd>
          <dt>연결한 사용자</dt><dd>{{ connection.connectedBy }}</dd>
          <dt>연결 시각</dt><dd>{{ connection.connectedAt | date:'yyyy-MM-dd HH:mm:ss' }}</dd>
          <dt>Secret references</dt><dd>{{ connection.secretRefs.length }}개 · 값 비노출</dd>
          <dt>Ceph 상태</dt><dd>{{ s.rook?.cephCluster?.state || 'Unknown' }} · {{ s.rook?.cephCluster?.health || 'Unknown' }}</dd>
        </dl>

        <clr-datagrid>
          <clr-dg-column>Consumer resource</clr-dg-column>
          <clr-dg-column>상태</clr-dg-column>
          <clr-dg-column>세부</clr-dg-column>
          <clr-dg-row>
            <clr-dg-cell><strong>Rook operator</strong></clr-dg-cell>
            <clr-dg-cell><span class="label" [class.label-success]="s.rook?.operator?.status === 'deployed'">{{ s.rook?.operator?.status || 'not-installed' }}</span></clr-dg-cell>
            <clr-dg-cell>revision {{ s.rook?.operator?.revision || 0 }}</clr-dg-cell>
          </clr-dg-row>
          <clr-dg-row>
            <clr-dg-cell><strong>External CephCluster</strong></clr-dg-cell>
            <clr-dg-cell><span class="label" [class.label-success]="s.rook?.cluster?.status === 'deployed'">{{ s.rook?.cluster?.status || 'not-installed' }}</span></clr-dg-cell>
            <clr-dg-cell>{{ s.rook?.cephCluster?.state || 'Unknown' }}</clr-dg-cell>
          </clr-dg-row>
          <clr-dg-row *ngFor="let storage of s.csi?.storageClasses || []">
            <clr-dg-cell><strong>StorageClass/{{ storage.name }}</strong></clr-dg-cell>
            <clr-dg-cell><span class="label label-success">Ready</span></clr-dg-cell>
            <clr-dg-cell>{{ storage.provisioner }} · reclaim {{ storage.reclaimPolicy }}</clr-dg-cell>
          </clr-dg-row>
          <clr-dg-footer>{{ (s.csi?.storageClasses?.length || 0) + 2 }}개 consumer resource</clr-dg-footer>
        </clr-datagrid>
      </section>
      <ng-template #emptyConnection>
        <section class="empty-state">
          <h2>외부 Ceph이 아직 연결되지 않았습니다</h2>
          <p>Kubernetes가 Ready인 경우 Ceph 관리자가 생성한 Rook provider export JSON으로 연결할 수 있습니다.</p>
          <button class="btn btn-primary" type="button" [disabled]="!s.kubernetes.ready || s.ownerPrerequisites?.ready !== true || busy()" (click)="openConnect()">연결 Wizard 시작</button>
        </section>
      </ng-template>
    </ng-container>

    <clr-modal [(clrModalOpen)]="connectOpen" [clrModalClosable]="!busy()" [clrModalSize]="'lg'">
      <h3 class="modal-title">외부 Ceph 연결 Wizard</h3>
      <div class="modal-body">
        <ol class="wizard-progress" aria-label="연결 단계">
          <li [class.active]="step() >= 1">Kubernetes 확인</li>
          <li [class.active]="step() >= 2">Provider export</li>
          <li [class.active]="step() >= 3">계획 및 승인</li>
        </ol>

        <section *ngIf="step() === 1" class="wizard-step">
          <h4>1. Consumer와 Provider 연결 준비 확인</h4>
          <p>Ceph 연결 리소스는 아래 Kubernetes 클러스터에만 설치됩니다. 대상 Ceph 관리자와 함께 storage·network·최소권한 export 준비를 확인하십시오.</p>
          <dl *ngIf="status() as s" class="connection-meta">
            <dt>Cluster fingerprint</dt><dd>{{ s.kubernetes.id }}</dd>
            <dt>Version</dt><dd>{{ s.kubernetes.version }}</dd>
            <dt>Nodes</dt><dd>{{ s.kubernetes.readyNodes }}/{{ s.kubernetes.nodes }} Ready</dd>
          </dl>
          <div class="alert alert-danger" *ngIf="status()?.kubernetes?.ready !== true">
            <div class="alert-items"><div class="alert-item static"><span class="alert-text">Kubernetes가 Ready가 아니므로 Ceph 연결을 진행할 수 없습니다.</span></div></div>
          </div>
          <div class="alert alert-danger" *ngIf="status()?.ownerPrerequisites?.ready !== true">
            <div class="alert-items"><div class="alert-item static"><span class="alert-text">Rook namespace·CRD·operator·runtime RBAC가 준비되지 않아 연결을 진행할 수 없습니다.</span></div></div>
          </div>
          <fieldset class="prep-confirmations">
            <legend>Provider Ceph 확인</legend>
            <label><input type="checkbox" name="providerStorageConfirmed" [(ngModel)]="providerStorageConfirmed"> Ceph health, RBD pool 초기화 및/또는 CephFS/MDS Active를 확인했습니다.</label>
            <label><input type="checkbox" name="providerNetworkConfirmed" [(ngModel)]="providerNetworkConfirmed"> 모든 Kubernetes node에서 MON 3300/6789 및 OSD·MDS 6800-7568/TCP 경로를 확인했습니다.</label>
            <label><input type="checkbox" name="providerExportConfirmed" [(ngModel)]="providerExportConfirmed"> consumer 전용 cluster name과 restricted auth로 생성한 Rook {{ providerGuide(status()).rookVersion }} JSON export를 준비했습니다.</label>
          </fieldset>
        </section>

        <section *ngIf="step() === 2" class="wizard-step">
          <h4>2. Rook provider export JSON 입력</h4>
          <p>Ceph provider에서 Rook <code>create-external-cluster-resources.py --format json</code>으로 생성한 제한 권한 export를 입력하십시오. 관리자 keyring·RGW·임의 리소스는 검증 필터가 거부합니다.</p>
          <form clrForm clrLayout="vertical">
            <clr-textarea-container>
              <label>Provider export JSON</label>
              <textarea clrTextarea name="providerExport" [(ngModel)]="providerExport" required autocomplete="off" spellcheck="false" placeholder='[{"name":"rook-ceph-mon-endpoints","kind":"ConfigMap","data":{...}}]'></textarea>
              <clr-control-helper>검증/설치 요청 후 원문은 브라우저 상태에서 즉시 제거됩니다.</clr-control-helper>
            </clr-textarea-container>
          </form>
          <div *ngIf="planLoading()" class="progress loop"><progress></progress></div>
        </section>

        <section *ngIf="step() === 3 && plan() as p" class="wizard-step">
          <h4>3. 설치 계획 및 승인</h4>
          <dl class="connection-meta">
            <dt>Mode</dt><dd>{{ p.mode }}</dd>
            <dt>Namespace</dt><dd>{{ p.namespace }}</dd>
            <dt>FSID fingerprint</dt><dd><code>{{ p.fsidFingerprint }}</code></dd>
            <dt>MON endpoints</dt><dd>{{ p.monitorCount }}개</dd>
            <dt>MON protocol</dt><dd>{{ (p.monitorProtocols || ['unknown']).join(' · ') }}</dd>
            <dt>Charts</dt><dd><span *ngFor="let chart of p.charts">{{ chart.chart }} {{ chart.version }} · </span></dd>
            <dt>Storage</dt><dd><span *ngFor="let storage of p.storage">{{ storage.name }} → {{ storage.pool }}{{ storage.filesystem ? ' / ' + storage.filesystem : '' }} · </span></dd>
            <dt>Snapshots</dt><dd>{{ p.snapshotSupported ? 'VolumeSnapshotClass 생성' : 'Snapshot API 미설치 — 생성 보류' }}</dd>
          </dl>
          <div class="resource-list">
            <div *ngFor="let resource of p.resources">
              <code>{{ resource.kind }}/{{ resource.name }}</code>
              <span>{{ resource.secretRefOnly ? 'Secret 값 비노출' : (resource.reclaimPolicy || resource.deletionPolicy || resource.namespace || 'cluster-scoped') }}</span>
            </div>
          </div>
          <div class="alert alert-warning">
            <div class="alert-items"><div class="alert-item static"><span class="alert-text">StorageClass와 snapshot은 <strong>Retain</strong> 정책입니다. 연결 해제는 사용 중인 PV/PVC가 있으면 차단되며, 원격 Ceph data는 삭제하지 않습니다.</span></div></div>
          </div>
          <form clrForm clrLayout="vertical">
            <clr-textarea-container>
              <label>변경 사유</label>
              <textarea clrTextarea name="connectReason" [(ngModel)]="connectReason" required minlength="8" maxlength="500" placeholder="승인 근거와 연결 목적(8자 이상)"></textarea>
            </clr-textarea-container>
          </form>
          <div class="alert alert-info" *ngIf="stagedImportRef() as importRef">
            <div class="alert-items"><div class="alert-item static"><span class="alert-text">
              OAA 인계용 SecretRef가 생성되었습니다: <code>{{ importRef }}</code><br>
              이 참조만 OAA 대화에 전달하십시오. provider export 원문은 전달하지 마십시오. 사용하지 않은 import는 1시간 후 만료·정리됩니다.
            </span></div></div>
          </div>
        </section>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" type="button" [disabled]="busy()" (click)="connectOpen = false">취소</button>
        <button *ngIf="step() > 1" class="btn btn-outline" type="button" [disabled]="busy() || planLoading()" (click)="back()">이전</button>
        <button *ngIf="step() === 1" class="btn btn-primary" type="button" [disabled]="status()?.kubernetes?.ready !== true || status()?.ownerPrerequisites?.ready !== true || !providerPreparationConfirmed()" (click)="step.set(2)">다음</button>
        <button *ngIf="step() === 2" class="btn btn-primary" type="button" [disabled]="providerExport.trim().length < 20 || planLoading()" (click)="validatePlan()">검증 및 계획</button>
        <button *ngIf="step() === 3" class="btn btn-outline" type="button" [disabled]="busy() || connectReason.trim().length < 8 || !!stagedImportRef()" (click)="stageForOaa()">OAA 인계용 import 생성</button>
        <button *ngIf="step() === 3" class="btn btn-primary" type="button" [disabled]="busy() || connectReason.trim().length < 8" (click)="connect()">연결 실행</button>
      </div>
    </clr-modal>

    <clr-modal [(clrModalOpen)]="disconnectOpen" [clrModalClosable]="!busy()">
      <h3 class="modal-title">외부 Ceph 연결 해제</h3>
      <div class="modal-body">
        <div class="alert alert-warning">
          <div class="alert-items"><div class="alert-item static"><span class="alert-text">사용 중인 PV/PVC가 있으면 작업은 차단됩니다. Consumer 측 Rook·CSI 연결 리소스만 제거하며 원격 Ceph pool/filesystem/data는 보존합니다.</span></div></div>
        </div>
        <form clrForm clrLayout="vertical">
          <clr-textarea-container>
            <label>변경 사유</label>
            <textarea clrTextarea name="disconnectReason" [(ngModel)]="disconnectReason" required minlength="8" maxlength="500"></textarea>
          </clr-textarea-container>
          <clr-input-container>
            <label>확인 값</label>
            <input clrInput name="disconnectConfirm" [(ngModel)]="disconnectConfirm" autocomplete="off" placeholder="disconnect Ceph external storage">
            <clr-control-helper>disconnect Ceph external storage를 정확히 입력하십시오.</clr-control-helper>
          </clr-input-container>
        </form>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" type="button" [disabled]="busy()" (click)="disconnectOpen = false">취소</button>
        <button class="btn btn-danger" type="button" [disabled]="busy() || disconnectReason.trim().length < 8 || disconnectConfirm !== 'disconnect Ceph external storage'" (click)="disconnect()">안전하게 연결 해제</button>
      </div>
    </clr-modal>
  `,
  styles: [`
    :host { display: block; }
    .cm-ceph-page-head {
      box-sizing: border-box;
      display: flex;
      justify-content: space-between;
      gap: 1.5rem;
      align-items: flex-start;
      width: 100%;
      height: auto;
      min-height: 0;
      margin: 0 0 0.9rem;
      padding: 0;
      border: 0;
      background: transparent;
      color: inherit;
      overflow: visible;
    }
    .cm-ceph-page-head__copy { min-width: 0; }
    .cm-ceph-page-head h1 { margin: 0.15rem 0 0.35rem; color: #2d4048; font-size: 1.45rem; font-weight: 400; line-height: 1.25; }
    .cm-ceph-summary { margin: 0; max-width: 63rem; color: #565656; line-height: 1.5; }
    .cm-ceph-eyebrow { margin: 0; color: #4c6fff; font-size: 0.65rem; font-weight: 600; line-height: 1.5; letter-spacing: 0.06em; text-transform: uppercase; }
    .cm-ceph-page-head__actions { display: flex; gap: 0.35rem; flex: 0 0 auto; }
    .dependency, .connection-card, .empty-state, .readiness-board { border: 1px solid #d8d8d8; background: #fff; padding: 0.85rem 1rem; margin-bottom: 0.8rem; }
    .dependency-title { display: grid; grid-template-columns: 1.6rem minmax(0, 1fr) auto; gap: 0.6rem; align-items: center; }
    .dependency-title > div { display: flex; flex-direction: column; gap: 0.12rem; }
    .dependency-title span:not(.label):not(.sequence) { color: #6f6f6f; font-size: 0.66rem; }
    .sequence { display: inline-grid; place-items: center; width: 1.35rem; height: 1.35rem; border-radius: 50%; background: #4c6fff; color: #fff; font-weight: 600; }
    .dependency dl, .connection-meta { display: grid; grid-template-columns: 10rem minmax(0, 1fr); gap: 0.35rem 0.8rem; margin: 0.7rem 0; }
    dt { font-weight: 600; color: #3a4d55; }
    dd { margin: 0; min-width: 0; word-break: break-word; }
    .connector { width: 2px; height: 1.1rem; margin: 0.15rem 0 0.15rem 0.68rem; background: #9a9a9a; }
    .status-message { margin: 0.55rem 0 0 2.2rem; color: #565656; }
    .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
    .card-head h2, .empty-state h2 { margin: 0; font-size: 1rem; }
    .card-head p { margin: 0.15rem 0 0; color: #6f6f6f; }
    .empty-state { text-align: center; padding: 2rem; }
    .empty-state p { color: #6f6f6f; }
    .readiness-board h2 { margin: 0; font-size: 1rem; }
    .readiness-board h3 { margin: 0 0 0.65rem; font-size: 0.8rem; color: #2d4048; }
    .readiness-grid { display: grid; grid-template-columns: minmax(18rem, 0.9fr) minmax(24rem, 1.1fr); gap: 0.8rem; margin-top: 0.85rem; }
    .readiness-panel, .provider-preparation { border: 1px solid #e3e6e8; padding: 0.8rem; background: #fafbfc; }
    .status-checks { display: grid; gap: 0.45rem; margin: 0; padding: 0; list-style: none; }
    .status-checks li { display: grid; grid-template-columns: 0.7rem minmax(0, 1fr) auto; gap: 0.5rem; align-items: start; }
    .status-checks li > span:nth-child(2) { display: flex; flex-direction: column; gap: 0.08rem; }
    .status-checks small { color: #6f6f6f; }
    .status-dot { width: 0.55rem; height: 0.55rem; margin-top: 0.25rem; border-radius: 50%; background: #c92100; box-shadow: 0 0 0 2px #fff, 0 0 0 3px #c92100; }
    .status-dot.ready { background: #318700; box-shadow: 0 0 0 2px #fff, 0 0 0 3px #318700; }
    .status-dot.optional:not(.ready) { background: #f0a228; box-shadow: 0 0 0 2px #fff, 0 0 0 3px #f0a228; }
    .prereq-action { color: #0065ab; font-size: 0.62rem; font-weight: 600; text-decoration: none; white-space: nowrap; }
    .prereq-action:hover { text-decoration: underline; }
    .prereq-action.optional { color: #805a00; }
    .prereq-next { margin-top: 0.75rem; padding: 0.65rem; border: 1px solid #b8d8f0; background: #eef7fc; }
    .prereq-next p { margin: 0 0 0.55rem; color: #3a4d55; line-height: 1.45; }
    .prereq-next > div { display: flex; flex-wrap: wrap; gap: 0.35rem; }
    .prereq-next .btn { margin: 0; }
    .provider-info { display: grid; grid-template-columns: 10rem minmax(0, 1fr); gap: 0.4rem 0.7rem; margin: 0; }
    .provider-info dt { font-size: 0.68rem; }
    .provider-info dd { color: #565656; }
    .provider-info .label { margin-left: 0.25rem; vertical-align: middle; }
    .scope-note { margin: 0.75rem 0 0; padding-top: 0.6rem; border-top: 1px solid #e3e6e8; color: #565656; }
    .blocker-list { margin-top: 0.75rem; padding: 0.55rem; background: #fff3f0; color: #8a1f11; }
    .blocker-list ul { margin: 0.3rem 0 0 1rem; padding: 0; }
    .provider-preparation { margin-top: 0.8rem; }
    .preparation-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.55rem; }
    .preparation-grid > div { display: flex; flex-direction: column; gap: 0.12rem; padding-left: 0.65rem; border-left: 3px solid #4c6fff; }
    .preparation-grid span { color: #565656; }
    .network-contract { display: flex; flex-wrap: wrap; gap: 0.35rem 0.7rem; margin-top: 0.75rem; padding: 0.55rem 0.65rem; background: #eaf4ff; }
    .command-block { display: grid; gap: 0.35rem; margin-top: 0.75rem; }
    .command-block span { color: #565656; }
    .command-block code { display: block; padding: 0.65rem; overflow-x: auto; background: #1b2a32; color: #eef5f7; white-space: nowrap; }
    .prep-confirmations { display: grid; gap: 0.55rem; margin-top: 0.8rem; padding: 0.75rem; border: 1px solid #d8d8d8; }
    .prep-confirmations legend { padding: 0 0.3rem; font-weight: 600; color: #3a4d55; }
    .prep-confirmations label { display: grid; grid-template-columns: 1rem minmax(0, 1fr); gap: 0.45rem; align-items: start; }
    .wizard-progress { display: grid; grid-template-columns: repeat(3, 1fr); padding: 0; margin: 0 0 1rem; list-style: none; counter-reset: step; }
    .wizard-progress li { padding: 0.45rem 0.5rem; border-bottom: 3px solid #d8d8d8; color: #6f6f6f; font-size: 0.68rem; }
    .wizard-progress li.active { border-color: #4c6fff; color: #1b2a32; font-weight: 600; }
    .wizard-step h4 { margin-top: 0; }
    textarea[name='providerExport'] { min-height: 14rem; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.62rem; }
    textarea { min-height: 4.5rem; }
    .resource-list { max-height: 14rem; overflow: auto; border: 1px solid #d8d8d8; margin: 0.65rem 0; }
    .resource-list > div { display: grid; grid-template-columns: minmax(14rem, 1fr) minmax(8rem, 0.7fr); gap: 0.6rem; padding: 0.3rem 0.5rem; border-bottom: 1px solid #eee; }
    code { font-size: 0.63rem; }
    @media (max-width: 62rem) {
      .cm-ceph-page-head, .card-head { flex-direction: column; }
      .readiness-grid, .preparation-grid { grid-template-columns: 1fr; }
      .dependency dl, .connection-meta { grid-template-columns: 1fr; }
      .resource-list > div { grid-template-columns: 1fr; }
      .status-checks li { grid-template-columns: 0.7rem minmax(0, 1fr); }
      .prereq-action { grid-column: 2; justify-self: start; }
    }
  `],
})
export class CephClustersComponent implements OnInit {
  private ceph = inject(CephService);
  readonly status = signal<CephStatus | null>(null);
  readonly plan = signal<CephPlan | null>(null);
  readonly loading = signal(false);
  readonly planLoading = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly step = signal(1);
  readonly stagedImportRef = signal('');
  connectOpen = false;
  disconnectOpen = false;
  providerExport = '';
  connectReason = '';
  disconnectReason = '';
  disconnectConfirm = '';
  providerStorageConfirmed = false;
  providerNetworkConfirmed = false;
  providerExportConfirmed = false;

  ngOnInit(): void { this.load(); }

  load(): void {
    this.loading.set(true);
    this.error.set('');
    this.ceph.status().subscribe({
      next: (status) => { this.status.set(status); this.loading.set(false); },
      error: (failure) => { this.error.set(this.message(failure)); this.loading.set(false); },
    });
  }

  openConnect(): void {
    this.step.set(1);
    this.plan.set(null);
    this.providerExport = '';
    this.connectReason = '';
    this.stagedImportRef.set('');
    this.providerStorageConfirmed = false;
    this.providerNetworkConfirmed = false;
    this.providerExportConfirmed = false;
    this.error.set('');
    this.connectOpen = true;
  }

  providerGuide(status: CephStatus | null): CephProviderGuide {
    return status?.providerGuide || CEPH_PROVIDER_GUIDE;
  }

  consumerNamespacesReady(status: CephStatus): boolean {
    return Boolean(status.ownerPrerequisites?.namespaces?.runtime && status.ownerPrerequisites.namespaces.imports);
  }

  providerPreparationConfirmed(): boolean {
    return this.providerStorageConfirmed && this.providerNetworkConfirmed && this.providerExportConfirmed;
  }

  back(): void {
    if (this.step() === 3) this.plan.set(null);
    this.step.update((value) => Math.max(1, value - 1));
  }

  validatePlan(): void {
    this.planLoading.set(true);
    this.error.set('');
    this.ceph.plan(this.providerExport).subscribe({
      next: (plan) => { this.plan.set(plan); this.planLoading.set(false); this.step.set(3); },
      error: (failure) => { this.planLoading.set(false); this.error.set(this.message(failure)); },
    });
  }

  connect(): void {
    if (!this.plan() || this.connectReason.trim().length < 8) return;
    this.busy.set(true);
    this.error.set('');
    const request = this.stagedImportRef()
      ? this.ceph.connectImport(this.stagedImportRef(), this.connectReason.trim())
      : this.ceph.connect(this.providerExport, this.connectReason.trim());
    request.subscribe({
      next: (result) => {
        this.providerExport = '';
        this.stagedImportRef.set('');
        this.busy.set(false);
        this.connectOpen = false;
        this.notice.set('외부 Ceph 연결 리소스 설치와 실제 연결 검증이 완료되었습니다.');
        this.status.set(result.status);
      },
      error: (failure) => {
        this.providerExport = '';
        this.busy.set(false);
        this.error.set(this.message(failure));
        this.load();
      },
    });
  }

  stageForOaa(): void {
    if (!this.plan() || this.connectReason.trim().length < 8 || this.stagedImportRef()) return;
    this.busy.set(true);
    this.error.set('');
    this.ceph.stage(this.providerExport, this.connectReason.trim()).subscribe({
      next: (staged) => {
        this.providerExport = '';
        this.busy.set(false);
        this.stagedImportRef.set(staged.importRef);
        this.notice.set('Ceph provider export를 전용 Kubernetes Secret에 staging했습니다. 화면의 SecretRef만 OAA에 전달하십시오.');
      },
      error: (failure) => { this.busy.set(false); this.error.set(this.message(failure)); },
    });
  }

  openDisconnect(): void {
    this.disconnectReason = '';
    this.disconnectConfirm = '';
    this.error.set('');
    this.disconnectOpen = true;
  }

  disconnect(): void {
    if (this.disconnectReason.trim().length < 8 || this.disconnectConfirm !== 'disconnect Ceph external storage') return;
    this.busy.set(true);
    this.error.set('');
    this.ceph.disconnect(this.disconnectReason.trim()).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.disconnectOpen = false;
        this.notice.set(`Ceph consumer 연결을 해제했습니다. 보존: ${result.retained.join(', ')}`);
        this.load();
      },
      error: (failure) => { this.busy.set(false); this.error.set(this.message(failure)); },
    });
  }

  private message(failure: any): string {
    return String(failure?.error?.error || failure?.message || 'Ceph 연결 요청에 실패했습니다.');
  }
}
