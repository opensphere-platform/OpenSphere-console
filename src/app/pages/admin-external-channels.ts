import { ChangeDetectionStrategy, Component, inject, signal, viewChild } from '@angular/core';
import { FormsModule, NgForm } from '@angular/forms';
import { ClarityModule } from '@clr/angular';
import { HttpService } from '../core/http.service';
import { OsPageHeader } from '../os/os-page-header';
import { OsPanel } from '../os/os-panel';

type Provider = 'slack' | 'discord' | 'smtp' | 'twilio';
interface Channel { id: string; name: string; provider: Provider; channelType: string; enabled: boolean; healthState: string; target: string; credential: { configured: boolean; version: number }; lastTest: { status: string; at: string; errorCode?: string | null } | null; lastSuccessAt: string | null; }
interface Rule { id: string; name: string; enabled: boolean; priority: number; minSeverity: string; sources: string[]; categories: string[]; channels: { id: string; name: string; provider: string }[]; dedupWindowSeconds: number; updatedAt: string; }
interface Delivery { id: string; status: string; attempts: number; providerMessageId: string; lastErrorCode: string; updatedAt: string; nextAttemptAt: string; event: { title: string; source: string; severity: string; occurred_at: string } | null; channel: { name: string; provider: string } | null; }
interface Summary { active: number; healthy: number; degraded: number; failed24h: number; deadLetter: number; paused: boolean; }
interface PendingAction { title: string; description: string; path: string; reason: string; confirmLabel: string; method: 'POST' | 'DELETE'; testRecipient?: string; confirmation: string; requiredConfirmation?: string; danger?: boolean; }
type S3ProfileKey = 's3-compatible' | 'aws-s3' | 'backblaze-b2' | 'cloudflare-r2' | 'minio' | 'ceph-rgw';
interface S3Profile { value: S3ProfileKey; label: string; region: string; endpoint: string; endpointPlaceholder: string; logo: string; }
interface BackupTarget { id: string; name: string; provider: 's3'; vendor: S3ProfileKey | string; endpoint: string; region: string; bucketName: string; bucketId: string; pathPrefix: string; bucketPrivate: boolean; lifecycleMode: string; serverSideEncryption: string; clientSideEncryption: string; enabled: boolean; healthState: string; credential: { configured: boolean; version: number }; tlsTrust?: { mode: 'system' | 'custom-ca'; customCaConfigured: boolean; subject: string; issuer: string; validTo: string | null; fingerprint: string }; lastTest: { status: string; at: string; errorCode?: string | null } | null; lastBackupAt: string | null; lastRestoreAt: string | null; updatedAt: string; }
interface Backup { id: string; targetId: string; targetName: string; objectKey: string; status: string; encryption: string; plaintextDigest: string; sizeBytes: number; entryCounts: Record<string, number>; createdAt: string; completedAt: string | null; errorCode: string | null; }
interface ExternalSummary { targets: number; readyTargets: number; configuredTargets: number; lastBackup: { status: string; at: string | null } | null; lastRestore: { status: string; at: string | null } | null; }
interface RestorePreview { restoreId: string; backupId: string; digest: string; backupCreatedAt: string; restoreMode: string; exclusions: string[]; changes: { totals: { incoming: number; additions: number; changes: number; unchanged: number } }; }
interface PanelIssue { message: string; field: string; }

const emptyChannel = () => ({ name: '', provider: 'slack' as Provider, target: '', webhookUrl: '', titlePrefix: '', smtpHost: '', smtpPort: 587, smtpSecure: false, smtpFrom: '', smtpRecipients: '', smtpUsername: '', smtpPassword: '', twilioAccountSid: '', twilioServiceSid: '', twilioFrom: '', twilioRecipients: '', twilioToken: '', reason: '' });
const emptyRule = () => ({ name: '', priority: 100, minSeverity: 'error', sources: '', categories: '', channelIds: [] as string[], dedupWindowSeconds: 600, reason: '' });
const S3_PROFILES: readonly S3Profile[] = [
  { value: 's3-compatible', label: '사용자 지정 S3 호환', region: 'us-east-1', endpoint: '', endpointPlaceholder: 'https://s3.example.com', logo: '/brand/storage/s3-compatible.svg' },
  { value: 'aws-s3', label: 'Amazon S3', region: 'ap-northeast-2', endpoint: 'https://s3.ap-northeast-2.amazonaws.com', endpointPlaceholder: 'https://s3.ap-northeast-2.amazonaws.com', logo: '/brand/storage/amazon-s3.svg' },
  { value: 'backblaze-b2', label: 'Backblaze B2', region: 'us-east-005', endpoint: 'https://s3.us-east-005.backblazeb2.com', endpointPlaceholder: 'https://s3.us-east-005.backblazeb2.com', logo: '/brand/storage/backblaze-b2.svg' },
  { value: 'cloudflare-r2', label: 'Cloudflare R2', region: 'auto', endpoint: '', endpointPlaceholder: 'https://<account-id>.r2.cloudflarestorage.com', logo: '/brand/storage/cloudflare-r2.svg' },
  { value: 'minio', label: 'MinIO', region: 'us-east-1', endpoint: '', endpointPlaceholder: 'https://minio.example.com:9000', logo: '/brand/storage/minio.svg' },
  { value: 'ceph-rgw', label: 'Ceph Object Gateway (RGW)', region: 'us-east-1', endpoint: '', endpointPlaceholder: 'https://rgw.example.com', logo: '/brand/storage/ceph-rgw.svg' },
];
const emptyBackupTarget = () => ({ name: '', vendor: 's3-compatible' as S3ProfileKey, endpoint: '', region: 'us-east-1', bucketName: '', bucketId: '', pathPrefix: 'opensphere-console', accessKeyId: '', applicationKey: '', tlsTrustMode: 'system' as 'system' | 'custom-ca', customCaCertificatePem: '', bucketPrivate: true, lifecycleMode: 'keep-all-versions', serverSideEncryption: 'unknown', reason: '' });

@Component({
  selector: 'os-admin-external-channels',
  imports: [ClarityModule, FormsModule, OsPageHeader, OsPanel],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page">
      <os-page-header title="외부 채널" tag="Core·Admin · Delivery & encrypted backup" />
      <div class="manage-page-lead"><p>외부 알림 전달과 Console 구성의 암호화 백업·즉시 복원을 한 관리 표면에서 감독합니다. 알림과 백업은 별도 실행기·DB 역할·암호화 키를 사용합니다.</p><span>Supabase metadata · S3-compatible storage · client-side AES-256-GCM · append-only audit</span></div>

      <section class="manage-status-rail" aria-label="외부 채널 전달 상태">
        <div><span>Active</span><strong>{{ summary().active }}</strong><small>발송 가능 채널</small></div>
        <div><span>Healthy</span><strong class="ok">{{ summary().healthy }}</strong><small>최근 수락·테스트 정상</small></div>
        <div><span>Degraded</span><strong [class.warn]="summary().degraded > 0">{{ summary().degraded }}</strong><small>재시도 또는 설정 점검</small></div>
        <div><span>Failed 24h</span><strong [class.danger]="summary().failed24h > 0">{{ summary().failed24h }}</strong><small>최종 실패</small></div>
        <div><span>Dead letter</span><strong [class.danger]="summary().deadLetter > 0">{{ summary().deadLetter }}</strong><small>수동 조치 필요</small></div>
        <div><span>Backup targets</span><strong [class.ok]="externalSummary().readyTargets > 0">{{ externalSummary().readyTargets }}/{{ externalSummary().targets }}</strong><small>검증된 외부 저장소</small></div>
        <div><span>Latest backup</span><strong [class.ok]="externalSummary().lastBackup?.status === 'ready'">{{ externalSummary().lastBackup?.status || 'None' }}</strong><small>{{ fmt(externalSummary().lastBackup?.at || '') }}</small></div>
      </section>

      @if (error(); as message) { <clr-alert [clrAlertType]="'danger'" [clrAlertClosable]="true" (clrAlertClosedChange)="error.set('')"><clr-alert-item><span class="alert-text">{{ message }}</span></clr-alert-item></clr-alert> }
      @if (summary().paused) { <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">전체 외부 발송이 일시중지되어 있습니다. 전달 이력은 보존되지만 새 event는 발송되지 않습니다.</span></clr-alert-item></clr-alert> }

      <clr-tabs>
        <clr-tab>
          <button clrTabLink>채널</button>
          <clr-tab-content>
            <div class="os-actions"><button class="btn btn-sm btn-primary" (click)="openChannelPanel()">채널 연결</button><button class="btn btn-sm btn-outline" [disabled]="busy()" (click)="load()">새로고침</button></div>
            <clr-datagrid [clrDgLoading]="loading()">
              <clr-dg-column>유형</clr-dg-column><clr-dg-column>이름·대상</clr-dg-column><clr-dg-column>상태</clr-dg-column><clr-dg-column>자격 증명</clr-dg-column><clr-dg-column>최근 테스트</clr-dg-column><clr-dg-column>작업</clr-dg-column>
              @for (channel of channels(); track channel.id) {
                <clr-dg-row>
                  <clr-dg-cell><span class="label">{{ providerLabel(channel.provider) }}</span></clr-dg-cell>
                  <clr-dg-cell><strong>{{ channel.name }}</strong><div class="os-mono">{{ channel.target }}</div></clr-dg-cell>
                  <clr-dg-cell><span class="label" [class.label-success]="channel.healthState === 'Healthy'" [class.label-warning]="channel.healthState === 'Degraded'" [class.label-danger]="channel.healthState === 'Misconfigured'">{{ channel.healthState }}</span></clr-dg-cell>
                  <clr-dg-cell><span class="label" [class.label-success]="channel.credential.configured">{{ channel.credential.configured ? 'Configured' : 'Missing' }}</span></clr-dg-cell>
                  <clr-dg-cell class="os-mono">{{ channel.lastTest ? fmt(channel.lastTest.at) + ' · ' + channel.lastTest.status : '—' }}</clr-dg-cell>
                  <clr-dg-cell>@if (channel.provider === 'smtp') { <button class="btn btn-sm btn-link" [disabled]="busy()" (click)="editSmtp(channel)">편집</button> }<button class="btn btn-sm btn-link" [disabled]="busy()" (click)="test(channel)">테스트</button><button class="btn btn-sm btn-link" [disabled]="busy()" (click)="toggle(channel)">{{ channel.enabled ? '중지' : '활성화' }}</button></clr-dg-cell>
                </clr-dg-row>
              }
              <clr-dg-placeholder>연결된 외부 채널이 없습니다. 채널을 연결한 뒤 라우팅 규칙을 만드세요.</clr-dg-placeholder>
              <clr-dg-footer>{{ channels().length }}개 채널 · webhook URL, SMTP password, SMS token은 표시하지 않습니다.</clr-dg-footer>
            </clr-datagrid>
          </clr-tab-content>
        </clr-tab>
        <clr-tab>
          <button clrTabLink>라우팅 규칙</button>
          <clr-tab-content>
            <div class="os-actions"><button class="btn btn-sm btn-primary" [disabled]="!channels().length" (click)="openRulePanel()">규칙 추가</button><span class="os-sub">모든 일치 규칙의 채널을 합집합으로 평가하며, 동일 event/channel은 한 번만 전달합니다.</span></div>
            <clr-datagrid [clrDgLoading]="loading()">
              <clr-dg-column>우선순위</clr-dg-column><clr-dg-column>규칙</clr-dg-column><clr-dg-column>조건</clr-dg-column><clr-dg-column>대상 채널</clr-dg-column><clr-dg-column>중복 억제</clr-dg-column><clr-dg-column>상태</clr-dg-column>
              @for (rule of rules(); track rule.id) { <clr-dg-row><clr-dg-cell>{{ rule.priority }}</clr-dg-cell><clr-dg-cell><strong>{{ rule.name }}</strong><div class="os-mono">v{{ rule.id.slice(0, 8) }}</div></clr-dg-cell><clr-dg-cell>{{ rule.minSeverity }}{{ rule.sources.length ? ' · ' + rule.sources.join(', ') : '' }}{{ rule.categories.length ? ' · ' + rule.categories.join(', ') : '' }}</clr-dg-cell><clr-dg-cell>{{ ruleChannelNames(rule) || '—' }}</clr-dg-cell><clr-dg-cell>{{ rule.dedupWindowSeconds ? rule.dedupWindowSeconds + 's' : '없음' }}</clr-dg-cell><clr-dg-cell><span class="label" [class.label-success]="rule.enabled">{{ rule.enabled ? 'Active' : 'Disabled' }}</span></clr-dg-cell></clr-dg-row> }
              <clr-dg-placeholder>규칙이 없습니다. 연결만으로는 어떤 이벤트도 외부 전송되지 않습니다.</clr-dg-placeholder>
            </clr-datagrid>
          </clr-tab-content>
        </clr-tab>
        <clr-tab>
          <button clrTabLink>전달 이력</button>
          <clr-tab-content>
            <div class="os-actions"><button class="btn btn-sm btn-outline" [disabled]="busy()" (click)="load()">새로고침</button><span class="os-sub">Accepted는 provider 수락, Delivered는 provider callback으로 확인된 경우에만 표시합니다.</span></div>
            <clr-datagrid [clrDgLoading]="loading()">
              <clr-dg-column>이벤트</clr-dg-column><clr-dg-column>채널</clr-dg-column><clr-dg-column>상태</clr-dg-column><clr-dg-column>시도</clr-dg-column><clr-dg-column>최근 시각</clr-dg-column><clr-dg-column>작업</clr-dg-column>
              @for (delivery of deliveries(); track delivery.id) { <clr-dg-row><clr-dg-cell><strong>{{ delivery.event?.title || '이벤트 조회 불가' }}</strong><div class="os-mono">{{ delivery.event?.source }} · {{ delivery.event?.severity }}</div></clr-dg-cell><clr-dg-cell>{{ delivery.channel?.name || '—' }}<div class="os-mono">{{ delivery.channel?.provider }}</div></clr-dg-cell><clr-dg-cell><span class="label" [class.label-danger]="isFailed(delivery.status)" [class.label-warning]="delivery.status === 'retrying'">{{ delivery.status }}</span>@if (delivery.lastErrorCode) { <div class="os-mono">{{ delivery.lastErrorCode }}</div> }</clr-dg-cell><clr-dg-cell>{{ delivery.attempts }}</clr-dg-cell><clr-dg-cell class="os-mono">{{ fmt(delivery.updatedAt) }}</clr-dg-cell><clr-dg-cell>@if (isFailed(delivery.status)) { <button class="btn btn-sm btn-link" [disabled]="busy()" (click)="retry(delivery)">재시도</button> }</clr-dg-cell></clr-dg-row> }
              <clr-dg-placeholder>전달 이력이 없습니다.</clr-dg-placeholder>
              <clr-dg-footer>최근 {{ deliveries().length }}건</clr-dg-footer>
            </clr-datagrid>
          </clr-tab-content>
        </clr-tab>
        <clr-tab>
          <button clrTabLink>백업 대상</button>
          <clr-tab-content>
            <div class="os-actions"><button class="btn btn-sm btn-primary" (click)="openBackupTargetPanel()">S3 대상 추가</button><button class="btn btn-sm btn-outline" [disabled]="busy()" (click)="load()">새로고침</button><span class="os-sub">각 대상은 독립된 Region·Bucket·Object prefix·S3 전용 자격 증명을 사용합니다. 자격 증명은 저장 후 다시 표시하지 않습니다.</span></div>
            @if (!backupTargets().length) {
              <section class="empty-backup">
                <strong>외부 백업 대상이 아직 연결되지 않았습니다.</strong>
                <p>AWS Signature Version 4를 지원하는 S3 호환 저장소의 endpoint, Region, Bucket과 전용 자격 증명을 입력하십시오. 필요한 수만큼 대상을 추가할 수 있습니다.</p>
                <button class="btn btn-sm btn-primary" (click)="openBackupTargetPanel()">첫 번째 대상 추가</button>
              </section>
            } @else {
              <div class="target-grid">
                @for (target of backupTargets(); track target.id) {
                  <article class="target-card">
                    <div class="target-card__head"><div class="target-brand"><img class="target-brand__logo" [src]="s3ProfileLogo(target.vendor)" [alt]="s3ProfileLabel(target.vendor) + ' 로고'" /><div><span class="eyebrow">S3 · {{ s3ProfileLabel(target.vendor) }}</span><h3>{{ target.name }}</h3></div></div><div class="target-state"><span class="label" [class.label-success]="target.enabled" [class.label-warning]="!target.enabled">{{ target.enabled ? '활성' : '중지' }}</span><span class="label" [class.label-success]="target.healthState === 'Ready'" [class.label-warning]="target.healthState === 'Degraded'" [class.label-danger]="target.healthState === 'Misconfigured'">{{ target.healthState }}</span></div></div>
                    <dl><div><dt>Endpoint</dt><dd class="os-mono">{{ target.endpoint }}</dd></div><div><dt>Bucket</dt><dd>{{ target.bucketName }} <span class="os-mono">{{ target.bucketId }}</span></dd></div><div><dt>TLS 신뢰</dt><dd>{{ target.tlsTrust?.mode === 'custom-ca' ? '사용자 지정 CA' : '시스템 기본 CA' }}@if (target.tlsTrust?.customCaConfigured) { <small class="trust-summary" [title]="target.tlsTrust?.fingerprint">{{ target.tlsTrust?.subject }} · {{ fmt(target.tlsTrust?.validTo || '') }} 만료</small> }</dd></div><div><dt>보존</dt><dd>{{ target.bucketPrivate ? 'Private' : 'Public' }} · {{ target.lifecycleMode }}</dd></div><div><dt>암호화</dt><dd><span class="ok">Client {{ target.clientSideEncryption }}</span> · Server {{ target.serverSideEncryption }}</dd></div><div><dt>자격 증명</dt><dd>{{ target.credential.configured ? 'Configured · v' + target.credential.version : 'Missing' }}</dd></div><div><dt>최근 백업</dt><dd>{{ fmt(target.lastBackupAt || '') }}</dd></div></dl>
                    <div class="card-actions"><button class="btn btn-sm btn-link" [disabled]="busy()" (click)="editBackupTarget(target)">편집·키 교체</button><button class="btn btn-sm btn-outline" [disabled]="busy() || !target.credential.configured" (click)="testBackupTarget(target)">연결 테스트</button><button class="btn btn-sm btn-link" [disabled]="busy()" (click)="toggleBackupTarget(target)">{{ target.enabled ? '중지' : '활성화' }}</button><button class="btn btn-sm btn-link danger-action" [disabled]="busy() || target.enabled" (click)="removeBackupTarget(target)">연결 해제</button></div>
                  </article>
                }
              </div>
              <p class="target-footer">{{ backupTargets().length }}개 외부 저장소 · 대상별 상태, 자격 증명 버전과 백업 이력을 독립적으로 관리합니다.</p>
            }
          </clr-tab-content>
        </clr-tab>
        <clr-tab>
          <button clrTabLink>백업 및 복원</button>
          <clr-tab-content>
            <div class="scope-note"><strong>Configuration snapshot 범위</strong><span>RBAC 계약 · plugin metadata · consumer/observability 계약 · 알림 채널/규칙</span><span class="warn">제외: 사용자/세션/비밀번호 · 모든 Secret · 감사/전달 이력 · Gitea 저장소 · Supabase DB/Storage 원본</span></div>
            <clr-datagrid [clrDgLoading]="loading()">
              <clr-dg-column>생성 시각</clr-dg-column><clr-dg-column>대상·객체</clr-dg-column><clr-dg-column>상태</clr-dg-column><clr-dg-column>암호화·크기</clr-dg-column><clr-dg-column>구성 항목</clr-dg-column><clr-dg-column>작업</clr-dg-column>
              @for (backup of backups(); track backup.id) {
                <clr-dg-row>
                  <clr-dg-cell class="os-mono">{{ fmt(backup.createdAt) }}</clr-dg-cell>
                  <clr-dg-cell><strong>{{ backup.targetName || backup.targetId }}</strong><div class="os-mono">{{ backup.objectKey }}</div></clr-dg-cell>
                  <clr-dg-cell><span class="label" [class.label-success]="backup.status === 'ready'" [class.label-danger]="backup.status === 'failed'">{{ backup.status }}</span>@if (backup.errorCode) { <div class="os-mono">{{ backup.errorCode }}</div> }</clr-dg-cell>
                  <clr-dg-cell>{{ backup.encryption }}<div class="os-mono">{{ fileSize(backup.sizeBytes) }}</div></clr-dg-cell>
                  <clr-dg-cell>{{ totalEntries(backup) }} records<div class="os-mono">{{ shortDigest(backup.plaintextDigest) }}</div></clr-dg-cell>
                  <clr-dg-cell>@if (backup.status === 'ready') { <button class="btn btn-sm btn-link" [disabled]="busy()" (click)="previewRestore(backup)">복원 미리보기</button> }</clr-dg-cell>
                </clr-dg-row>
              }
              <clr-dg-placeholder>생성된 구성 백업이 없습니다.</clr-dg-placeholder>
              <clr-dg-footer>최근 {{ backups().length }}개 · 버킷 객체는 Console에서 암호화한 뒤 업로드됩니다.</clr-dg-footer>
            </clr-datagrid>
          </clr-tab-content>
        </clr-tab>
      </clr-tabs>
    </div>

    <os-panel [open]="channelPanelOpen()" [title]="editingChannelId() ? '이메일 채널 편집' : '외부 채널 연결'" subtitle="Secret은 Dispatcher가 암호화해 보관" (closed)="closePanels()">
      @if (panelError(); as issue) { <div class="panel-error" role="alert"><strong>{{ fieldLabel(issue.field) }}</strong><span>{{ issue.message }}</span></div> }
      <form clrForm clrLayout="vertical" class="channel-form" autocomplete="off">
        <clr-input-container><label>이름</label><input clrInput [(ngModel)]="channelForm.name" name="channel-name" maxlength="80" placeholder="운영 Slack" /></clr-input-container>
        <clr-select-container><label>유형</label><select clrSelect [(ngModel)]="channelForm.provider" name="channel-provider"><option value="slack">Slack</option><option value="discord">Discord</option><option value="smtp">이메일 (SMTP)</option><option value="twilio">SMS (Twilio)</option></select></clr-select-container>
        @if (channelForm.provider === 'slack' || channelForm.provider === 'discord') {
          <clr-input-container><label>표시 대상</label><input clrInput [(ngModel)]="channelForm.target" name="channel-target" placeholder="#platform-alerts" /></clr-input-container>
          <clr-input-container class="wide"><label>Webhook URL</label><input clrInput type="password" [(ngModel)]="channelForm.webhookUrl" name="channel-webhook" autocomplete="new-password" placeholder="https://…" /><clr-control-helper>전체 URL은 secret입니다.</clr-control-helper></clr-input-container>
        } @else if (channelForm.provider === 'smtp') {
          <clr-input-container><label>SMTP host</label><input clrInput [(ngModel)]="channelForm.smtpHost" name="smtp-host" placeholder="smtp.example.com" /></clr-input-container><clr-input-container><label>Port</label><input clrInput type="number" [(ngModel)]="channelForm.smtpPort" name="smtp-port" /></clr-input-container><clr-input-container><label>From</label><input clrInput [(ngModel)]="channelForm.smtpFrom" name="smtp-from" placeholder="ops@example.com" /></clr-input-container><clr-input-container><label>Recipients</label><input clrInput [(ngModel)]="channelForm.smtpRecipients" name="smtp-recipients" placeholder="oncall@example.com" /></clr-input-container><clr-input-container><label>Username</label><input clrInput [(ngModel)]="channelForm.smtpUsername" name="smtp-username" autocomplete="off" /><clr-control-helper>계정 변경 시 Password와 함께 입력합니다.</clr-control-helper></clr-input-container><clr-input-container><label>Password</label><input clrInput type="password" [(ngModel)]="channelForm.smtpPassword" name="smtp-password" autocomplete="new-password" /><clr-control-helper>두 항목을 모두 비워 두면 기존 자격 증명을 유지합니다.</clr-control-helper></clr-input-container>
        } @else {
          <clr-input-container><label>Account SID</label><input clrInput [(ngModel)]="channelForm.twilioAccountSid" name="twilio-account" /></clr-input-container><clr-input-container><label>Messaging Service SID</label><input clrInput [(ngModel)]="channelForm.twilioServiceSid" name="twilio-service" /></clr-input-container><clr-input-container><label>From (선택)</label><input clrInput [(ngModel)]="channelForm.twilioFrom" name="twilio-from" placeholder="+821012345678" /></clr-input-container><clr-input-container><label>Recipients</label><input clrInput [(ngModel)]="channelForm.twilioRecipients" name="twilio-recipients" placeholder="+821012345678" /></clr-input-container><clr-input-container class="wide"><label>Auth token</label><input clrInput type="password" [(ngModel)]="channelForm.twilioToken" name="twilio-token" autocomplete="new-password" /></clr-input-container>
        }
        <clr-input-container class="wide"><label>변경 사유 (선택)</label><input clrInput [(ngModel)]="channelForm.reason" name="channel-reason" maxlength="240" placeholder="운영 알림 채널 최초 연결" /><clr-control-helper>입력한 사유는 append-only 감사에 남습니다.</clr-control-helper></clr-input-container>
      </form>
      <div osPanelFooter><button class="btn btn-primary" [disabled]="busy()" (click)="createChannel()">{{ editingChannelId() ? '구성 저장' : '연결 저장' }}</button><button class="btn btn-outline" [disabled]="busy()" (click)="closePanels()">취소</button></div>
    </os-panel>

    <os-panel [open]="rulePanelOpen()" title="라우팅 규칙 추가" subtitle="명시적으로 일치한 이벤트만 전송" (closed)="closePanels()">
      @if (panelError(); as issue) { <div class="panel-error" role="alert"><strong>{{ fieldLabel(issue.field) }}</strong><span>{{ issue.message }}</span></div> }
      <form clrForm clrLayout="vertical" class="channel-form" autocomplete="off">
        <clr-input-container><label>규칙 이름</label><input clrInput [(ngModel)]="ruleForm.name" name="rule-name" placeholder="Platform error" /></clr-input-container><clr-input-container><label>우선순위</label><input clrInput type="number" [(ngModel)]="ruleForm.priority" name="rule-priority" /></clr-input-container><clr-select-container><label>최소 심각도</label><select clrSelect [(ngModel)]="ruleForm.minSeverity" name="rule-severity"><option value="info">info</option><option value="warning">warning</option><option value="error">error</option><option value="critical">critical</option></select></clr-select-container><clr-input-container><label>Source (쉼표 구분)</label><input clrInput [(ngModel)]="ruleForm.sources" name="rule-sources" placeholder="audit,platform-control" /></clr-input-container><clr-input-container><label>Category (쉼표 구분)</label><input clrInput [(ngModel)]="ruleForm.categories" name="rule-categories" placeholder="declarative-change" /></clr-input-container><clr-input-container><label>Dedup seconds</label><input clrInput type="number" [(ngModel)]="ruleForm.dedupWindowSeconds" name="rule-dedup" /></clr-input-container>
        <clr-checkbox-container class="wide"><label>대상 채널</label>@for (channel of channels(); track channel.id) { <clr-checkbox-wrapper><input type="checkbox" clrCheckbox [checked]="ruleForm.channelIds.includes(channel.id)" (change)="setRuleChannel(channel.id, checkboxChecked($event))" /><label>{{ channel.name }} · {{ providerLabel(channel.provider) }}</label></clr-checkbox-wrapper> }</clr-checkbox-container>
        <clr-input-container class="wide"><label>변경 사유 (선택)</label><input clrInput [(ngModel)]="ruleForm.reason" name="rule-reason" maxlength="240" placeholder="플랫폼 오류 외부 전파 규칙 추가" /></clr-input-container>
      </form>
      <div osPanelFooter><button class="btn btn-primary" [disabled]="busy()" (click)="createRule()">규칙 저장</button><button class="btn btn-outline" [disabled]="busy()" (click)="closePanels()">취소</button></div>
    </os-panel>

    <os-panel [open]="!!pendingAction()" [title]="pendingAction()?.title || ''" subtitle="감사 로그에 변경 사유를 남깁니다." (closed)="cancelPendingAction()">
      @if (panelError(); as issue) { <div class="panel-error" role="alert"><strong>{{ fieldLabel(issue.field) }}</strong><span>{{ issue.message }}</span></div> }
      @if (pendingAction(); as action) {
        <p class="action-description">{{ action.description }}</p>
        <form clrForm clrLayout="vertical">
          @if (action.testRecipient !== undefined) { <clr-input-container><label>테스트 수신 메일 주소</label><input clrInput type="email" [(ngModel)]="action.testRecipient" name="test-recipient" autocomplete="email" placeholder="test@example.com" required /><clr-control-helper>테스트에만 사용되며, 채널의 기본 수신자는 변경하지 않습니다.</clr-control-helper></clr-input-container> }
          @if (action.requiredConfirmation) { <clr-input-container><label>정확한 확인 문구</label><input clrInput [(ngModel)]="action.confirmation" name="action-confirmation" [placeholder]="action.requiredConfirmation" autocomplete="off" /><clr-control-helper>{{ action.requiredConfirmation }}</clr-control-helper></clr-input-container> }
          <clr-input-container><label>실행 사유 (선택)</label><input clrInput [(ngModel)]="action.reason" name="action-reason" maxlength="240" /><clr-control-helper>입력한 사유는 append-only 감사 로그에 기록</clr-control-helper></clr-input-container>
        </form>
      }
      <div osPanelFooter>@if (pendingAction(); as action) { <button class="btn" [class.btn-primary]="!action.danger" [class.btn-danger]="action.danger" [disabled]="busy() || (action.testRecipient !== undefined && !validEmail(action.testRecipient)) || (!!action.requiredConfirmation && action.confirmation?.trim() !== action.requiredConfirmation)" (click)="executePendingAction()">{{ action.confirmLabel }}</button><button class="btn btn-outline" [disabled]="busy()" (click)="cancelPendingAction()">취소</button> }</div>
    </os-panel>

    <os-panel class="backup-target-editor" [open]="backupTargetPanelOpen()" [title]="editingBackupTargetId() ? 'S3 백업 대상 편집' : 'S3 백업 대상 추가'" [subtitle]="s3ProfileLabel(backupTargetForm.vendor) + ' · 자격 증명은 저장 후 다시 표시하지 않음'" (closed)="closePanels()">
      @if (panelError(); as issue) { <div class="panel-error" role="alert"><strong>{{ fieldLabel(issue.field) }}</strong><span>{{ issue.message }}</span></div> }
      <div class="backup-panel-intro" id="backup-target-guidance">
        <strong>{{ editingBackupTargetId() ? '저장 위치를 수정하거나 전용 자격 증명을 교체합니다.' : '외부 저장소의 위치와 전용 자격 증명을 등록합니다.' }}</strong>
        <span>프로파일은 대표적인 S3 설정을 채우는 도구이며 endpoint는 저장소 환경에 맞게 수정할 수 있습니다. HTTPS와 AWS Signature Version 4를 지원하는 S3 호환 저장소를 연결합니다.</span>
        <span class="backup-panel-security"><strong>보안:</strong> 모든 snapshot은 업로드 전에 AES-256-GCM으로 암호화됩니다.</span>
      </div>
      <form #backupTargetFormRef="ngForm" clrForm clrLayout="vertical" class="backup-target-form" autocomplete="off" aria-describedby="backup-target-guidance" novalidate>
        <fieldset class="backup-form-section">
          <legend><span>저장 위치</span><small>저장소 프로파일을 선택한 뒤 해당 서비스에서 확인한 Region, endpoint와 Bucket 값을 입력합니다.</small></legend>
          <div class="backup-form-grid">
            <clr-select-container><label>저장소 프로파일</label><select clrSelect [ngModel]="backupTargetForm.vendor" (ngModelChange)="applyS3Profile($event)" name="backup-vendor">@for (profile of s3Profiles; track profile.value) { <option [value]="profile.value">{{ profile.label }}</option> }</select><clr-control-helper>프로파일을 선택해도 endpoint와 Region을 직접 수정할 수 있습니다.</clr-control-helper></clr-select-container>
            <clr-input-container><label>고유 연결 이름</label><input clrInput [(ngModel)]="backupTargetForm.name" name="backup-name" minlength="2" maxlength="80" required [attr.aria-invalid]="backupTargetFieldError('name') ? 'true' : null" placeholder="운영 구성 백업 · 서울" />@if (backupTargetFieldError('name'); as issue) { <clr-control-error>{{ issue }}</clr-control-error> }</clr-input-container>
            <clr-input-container><label>Region</label><input clrInput [(ngModel)]="backupTargetForm.region" name="backup-region" required [attr.aria-invalid]="backupTargetFieldError('region') ? 'true' : null" [placeholder]="selectedS3Profile().region" />@if (backupTargetFieldError('region'); as issue) { <clr-control-error>{{ issue }}</clr-control-error> }</clr-input-container>
            <clr-input-container><label>Bucket name</label><input clrInput [(ngModel)]="backupTargetForm.bucketName" name="backup-bucket-name" minlength="3" maxlength="63" required [attr.aria-invalid]="backupTargetFieldError('bucketName') ? 'true' : null" placeholder="opensphere-console-backup" /><clr-control-helper>S3 요청에 사용하는 실제 버킷 이름입니다.</clr-control-helper>@if (backupTargetFieldError('bucketName'); as issue) { <clr-control-error>{{ issue }}</clr-control-error> }</clr-input-container>
            <clr-input-container class="wide"><label>S3 endpoint</label><input clrInput [(ngModel)]="backupTargetForm.endpoint" name="backup-endpoint" required [attr.aria-invalid]="backupTargetFieldError('endpoint') ? 'true' : null" [placeholder]="selectedS3Profile().endpointPlaceholder" /><clr-control-helper>HTTPS origin만 입력합니다. 경로·query·인증 정보는 포함하지 않습니다.</clr-control-helper>@if (backupTargetFieldError('endpoint'); as issue) { <clr-control-error>{{ issue }}</clr-control-error> }</clr-input-container>
            <clr-input-container><label>Bucket ID (선택)</label><input clrInput [(ngModel)]="backupTargetForm.bucketId" name="backup-bucket-id" maxlength="128" [attr.aria-invalid]="backupTargetFieldError('bucketId') ? 'true' : null" placeholder="저장소가 제공하는 버킷 식별자" /><clr-control-helper>운영자가 버킷을 식별하기 위한 선택 참조값입니다.</clr-control-helper>@if (backupTargetFieldError('bucketId'); as issue) { <clr-control-error>{{ issue }}</clr-control-error> }</clr-input-container>
            <clr-input-container class="wide"><label>Object prefix</label><input clrInput [(ngModel)]="backupTargetForm.pathPrefix" name="backup-prefix" maxlength="200" required [attr.aria-invalid]="backupTargetFieldError('pathPrefix') ? 'true' : null" /><clr-control-helper>이 대상에서 Console 백업 객체를 구분할 경로 접두사입니다.</clr-control-helper>@if (backupTargetFieldError('pathPrefix'); as issue) { <clr-control-error>{{ issue }}</clr-control-error> }</clr-input-container>
          </div>
        </fieldset>
        <fieldset class="backup-form-section">
          <legend><span>TLS 신뢰</span><small>Endpoint 인증서를 검증할 신뢰 저장소를 선택합니다. 인증서 검증을 해제하지 않습니다.</small></legend>
          <div class="backup-form-grid">
            <clr-select-container><label>TLS 신뢰 방식</label><select clrSelect [(ngModel)]="backupTargetForm.tlsTrustMode" name="backup-tls-trust-mode"><option value="system">시스템 기본 CA</option><option value="custom-ca">사용자 지정 CA</option></select><clr-control-helper>공인 인증서는 시스템 기본 CA를, 사설 인증서는 사용자 지정 CA를 사용합니다.</clr-control-helper></clr-select-container>
            @if (backupTargetForm.tlsTrustMode === 'custom-ca') {
              <clr-textarea-container class="wide"><label>사용자 지정 CA 인증서 (PEM)</label><textarea clrTextarea [(ngModel)]="backupTargetForm.customCaCertificatePem" name="backup-custom-ca" rows="7" maxlength="65536" [required]="!editingBackupTargetCustomCaConfigured()" [placeholder]="editingBackupTargetCustomCaConfigured() ? '********' : '-----BEGIN CERTIFICATE-----'" [attr.aria-invalid]="backupTargetFieldError('customCaCertificatePem') ? 'true' : null"></textarea><clr-control-helper>{{ editingBackupTargetCustomCaConfigured() ? '기존 값 저장됨 · ******** · 비우면 유지하고 새 PEM을 입력하면 교체합니다.' : '루트 또는 중간 CA 인증서 1~8개를 PEM 형식으로 등록합니다.' }}</clr-control-helper>@if (backupTargetFieldError('customCaCertificatePem'); as issue) { <clr-control-error>{{ issue }}</clr-control-error> }</clr-textarea-container>
            }
          </div>
        </fieldset>
        <fieldset class="backup-form-section">
          <legend><span>버킷 정책 확인</span><small>외부 저장소에 설정된 현재 정책을 기록합니다. Console이 이 값을 변경하지는 않습니다.</small></legend>
          <div class="backup-form-grid">
            <clr-select-container><label>버킷 보존 방식</label><select clrSelect [(ngModel)]="backupTargetForm.lifecycleMode" name="backup-lifecycle"><option value="keep-all-versions">모든 버전 보존</option><option value="keep-only-last-version">최신 버전만 보존</option><option value="custom">사용자 지정</option></select></clr-select-container>
            <clr-select-container><label>버킷 서버 암호화</label><select clrSelect [(ngModel)]="backupTargetForm.serverSideEncryption" name="backup-server-encryption"><option value="unknown">확인되지 않음</option><option value="enabled">활성</option><option value="disabled">비활성</option></select></clr-select-container>
          </div>
        </fieldset>
        <fieldset class="backup-form-section">
          <legend><span>전용 자격 증명</span><small>이 Bucket과 Object prefix에 필요한 최소 권한만 가진 S3 전용 자격 증명을 사용합니다.</small></legend>
          <div class="backup-form-grid">
            <clr-input-container><label>Access key ID</label><input clrInput type="password" [(ngModel)]="backupTargetForm.accessKeyId" name="backup-access-key" autocomplete="new-password" minlength="3" maxlength="128" [required]="!editingBackupTargetId()" [placeholder]="editingBackupTargetCredentialConfigured() ? '********' : ''" [attr.aria-invalid]="backupTargetFieldError('accessKeyId') ? 'true' : null" /><clr-control-helper>{{ editingBackupTargetCredentialConfigured() ? '기존 값 저장됨 · ******** · 두 자격 증명을 모두 비우면 유지합니다.' : credentialIdHint() }}</clr-control-helper>@if (backupTargetFieldError('accessKeyId'); as issue) { <clr-control-error>{{ issue }}</clr-control-error> }</clr-input-container>
            <clr-input-container><label>Secret access key</label><input clrInput type="password" [(ngModel)]="backupTargetForm.applicationKey" name="backup-secret-key" autocomplete="new-password" minlength="8" maxlength="256" [required]="!editingBackupTargetId()" [placeholder]="editingBackupTargetCredentialConfigured() ? '********' : ''" [attr.aria-invalid]="backupTargetFieldError('applicationKey') ? 'true' : null" /><clr-control-helper>{{ editingBackupTargetCredentialConfigured() ? '기존 값 저장됨 · ******** · 두 값을 함께 입력한 경우에만 교체합니다.' : credentialSecretHint() }}</clr-control-helper>@if (backupTargetFieldError('applicationKey'); as issue) { <clr-control-error>{{ issue }}</clr-control-error> }</clr-input-container>
          </div>
        </fieldset>
        <fieldset class="backup-form-section backup-form-section--last">
          <legend><span>감사 메모</span><small>운영 변경의 목적만 기록하며 자격 증명 원문은 감사 로그에 남기지 않습니다.</small></legend>
          <div class="backup-form-grid">
            <clr-input-container class="wide"><label>변경 사유 (선택)</label><input clrInput [(ngModel)]="backupTargetForm.reason" name="backup-reason" maxlength="240" placeholder="Console 구성 외부 백업 대상 최초 연결" /></clr-input-container>
          </div>
        </fieldset>
      </form>
      <div osPanelFooter class="backup-panel-footer"><div class="backup-panel-footer__actions"><button class="btn btn-outline" [disabled]="busy()" (click)="closePanels()">취소</button><button class="btn btn-primary" [disabled]="busy()" (click)="saveBackupTarget()">{{ editingBackupTargetId() ? '변경 저장' : '대상 추가' }}</button></div></div>
    </os-panel>

    <os-panel [open]="!!restorePreview()" title="구성 복원 확인" subtitle="AAL2 · digest-bound transactional merge" (closed)="cancelRestore()">
      @if (panelError(); as issue) { <div class="panel-error" role="alert"><strong>{{ fieldLabel(issue.field) }}</strong><span>{{ issue.message }}</span></div> }
      @if (restorePreview(); as preview) {
        <div class="restore-summary"><span>Backup <strong class="os-mono">{{ preview.backupId }}</strong></span><span>생성 {{ fmt(preview.backupCreatedAt) }}</span><span>입력 {{ preview.changes.totals.incoming }} · 추가 {{ preview.changes.totals.additions }} · 변경 {{ preview.changes.totals.changes }} · 동일 {{ preview.changes.totals.unchanged }}</span></div>
        <clr-alert [clrAlertType]="'warning'" [clrAlertClosable]="false"><clr-alert-item><span class="alert-text">이 복원은 허용된 구성만 트랜잭션으로 병합합니다. Secret과 운영자 역할 할당은 복원하지 않으며, 새 알림 채널은 자격 증명을 다시 입력할 때까지 비활성 상태입니다.</span></clr-alert-item></clr-alert>
        <form clrForm clrLayout="vertical" class="channel-form">
          <clr-input-container class="wide"><label>정확한 확인 문구</label><input clrInput [(ngModel)]="restoreConfirmation" name="restore-confirmation" [placeholder]="'RESTORE ' + preview.backupId" /><clr-control-helper>RESTORE {{ preview.backupId }}</clr-control-helper></clr-input-container>
          <clr-input-container class="wide"><label>복원 사유 (선택)</label><input clrInput [(ngModel)]="restoreReason" name="restore-reason" maxlength="240" /><clr-control-helper>입력한 사유는 append-only 감사 로그에 기록됩니다.</clr-control-helper></clr-input-container>
        </form>
      }
      <div osPanelFooter>@if (restorePreview(); as preview) { <button class="btn btn-danger" [disabled]="busy() || restoreConfirmation.trim() !== 'RESTORE ' + preview.backupId" (click)="applyRestore()">지금 복원</button><button class="btn btn-outline" [disabled]="busy()" (click)="cancelRestore()">취소</button> }</div>
    </os-panel>
  `,
  styles: [`
    .os-actions { display:flex; align-items:center; gap:.5rem; margin:.7rem 0; flex-wrap:wrap; }.os-sub,.os-mono { color:var(--os-ink-muted); font-size:.68rem; }.os-mono { font-family:var(--os-font-mono,monospace); }.channel-form { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0 .9rem; }.wide { grid-column:1 / -1; } :host ::ng-deep .channel-form .clr-control-container,:host ::ng-deep .channel-form .clr-input-wrapper,:host ::ng-deep .channel-form .clr-select-wrapper { width:100%; } :host ::ng-deep .channel-form input.clr-input,:host ::ng-deep .channel-form select.clr-select { width:100%;max-width:none; }.panel-error{border:1px solid var(--cds-alias-status-danger,#c21d00);background:var(--cds-alias-status-danger-tint,#fff2f0);padding:.7rem .8rem;margin:.2rem 0 .8rem;display:flex;flex-direction:column;gap:.2rem}.empty-backup,.panel-callout,.scope-note,.restore-summary { border:1px solid var(--os-hairline,#d7dce1);background:var(--os-surface,#fff);padding:1rem;margin:.8rem 0;display:flex;flex-direction:column;gap:.35rem;}.target-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(24rem,1fr));gap:.8rem;margin:.8rem 0}.target-card{border:1px solid var(--os-hairline,#d7dce1);background:var(--os-surface,#fff);padding:1rem;min-width:0}.target-card__head{display:flex;justify-content:space-between;gap:1rem}.target-brand{display:flex;align-items:flex-start;gap:.65rem;min-width:0}.target-brand__logo{display:block;flex:0 0 1.6rem;width:1.6rem;height:1.6rem;margin-top:.1rem;object-fit:contain}.target-state{display:flex;align-items:flex-start;gap:.3rem;flex-wrap:wrap;justify-content:flex-end}.target-card h3{margin:.15rem 0 .8rem}.eyebrow{font-size:.6rem;text-transform:uppercase;color:var(--os-ink-muted)}.target-card dl{margin:0}.target-card dl div{display:grid;grid-template-columns:6rem minmax(0,1fr);padding:.35rem 0;border-top:1px solid var(--os-hairline,#e4e7ea)}.target-card dt{color:var(--os-ink-muted)}.target-card dd{margin:0;overflow-wrap:anywhere}.card-actions{display:flex;gap:.35rem;margin-top:.8rem;flex-wrap:wrap}.danger-action{color:var(--cds-alias-status-danger,#c21d00)}.target-footer{color:var(--os-ink-muted);font-size:.68rem;margin:.2rem 0 .8rem}.warn{color:var(--cds-alias-status-warning,#8a3800)}.ok{color:var(--cds-alias-status-success,#1b7f3b)}.restore-summary{font-size:.75rem}.scope-note{flex-direction:row;align-items:center;flex-wrap:wrap;gap:.8rem}

    :host ::ng-deep os-panel.backup-target-editor .os-panel-content { max-width:80rem; }
    :host ::ng-deep os-panel.backup-target-editor .side-panel-body form.clr-form { max-width:none; }
    .backup-panel-intro { display:flex; flex-direction:column; gap:.35rem; max-width:80rem; margin:0 0 1.25rem; padding:.9rem 1rem; border-left:.25rem solid var(--cds-alias-object-interaction-color,#0f62fe); background:var(--os-surface-2,#f4f4f4); color:var(--os-ink,#17233c); font-size:.82rem; line-height:1.5; }
    .backup-panel-intro > strong { font-size:.9rem; font-weight:600; }
    .backup-panel-security { color:#713400; }
    .backup-target-form { width:100%; max-width:80rem; margin:0; }
    .backup-form-section { min-width:0; margin:0; padding:0 0 1.35rem; border:0; }
    .backup-form-section + .backup-form-section { padding-top:1.25rem; }
    .backup-form-section--last { padding-bottom:.25rem; border-bottom:0; }
    .backup-form-section legend { display:flex; width:100%; margin:0 0 .65rem; padding:0; flex-direction:column; gap:.08rem; color:var(--os-ink,#17233c); line-height:1.35; }
    .backup-form-section legend > span { font-size:1rem; font-weight:600; }
    .backup-form-section legend > small { color:var(--os-ink-muted,#525d73); font-size:.78rem; font-weight:400; line-height:1.45; }
    .backup-form-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); column-gap:1.25rem; row-gap:.15rem; }
    :host ::ng-deep .backup-form-grid .clr-control-container,:host ::ng-deep .backup-form-grid .clr-input-wrapper,:host ::ng-deep .backup-form-grid .clr-select-wrapper,:host ::ng-deep .backup-form-grid .clr-textarea-wrapper { width:100%; }
    :host ::ng-deep .backup-form-grid input.clr-input,:host ::ng-deep .backup-form-grid select.clr-select,:host ::ng-deep .backup-form-grid textarea.clr-textarea { width:100%; max-width:none; font-size:.86rem; }
    :host ::ng-deep .backup-form-grid .clr-form-control { margin-top:.55rem; }
    :host ::ng-deep .backup-form-grid label { color:var(--os-ink,#17233c); font-size:.78rem; font-weight:600; line-height:1.35; }
    :host ::ng-deep .backup-form-grid .clr-subtext { margin-top:.3rem; color:var(--os-ink-muted,#525d73); font-size:.72rem; line-height:1.45; }
    .trust-summary { display:block; margin-top:.1rem; color:var(--os-ink-muted,#525d73); font-size:.66rem; line-height:1.35; overflow-wrap:anywhere; }
    .backup-panel-footer { justify-content:flex-end !important; gap:1rem !important; }
    .backup-panel-footer__actions { display:flex; align-items:center; justify-content:flex-end; gap:.5rem; flex:0 0 auto; }
    @media (max-width:760px) { .channel-form,.backup-form-grid { grid-template-columns:1fr; }.wide { grid-column:1; }.scope-note{align-items:flex-start;flex-direction:column}.target-grid{grid-template-columns:1fr}.backup-panel-footer__actions { width:100%; }.backup-panel-footer__actions .btn { flex:1 1 0; } }
  `],
})
export class AdminExternalChannels {
  private readonly http = inject(HttpService);
  readonly s3Profiles = S3_PROFILES;
  readonly summary = signal<Summary>({ active: 0, healthy: 0, degraded: 0, failed24h: 0, deadLetter: 0, paused: false });
  readonly channels = signal<Channel[]>([]); readonly rules = signal<Rule[]>([]); readonly deliveries = signal<Delivery[]>([]);
  readonly externalSummary = signal<ExternalSummary>({ targets: 0, readyTargets: 0, configuredTargets: 0, lastBackup: null, lastRestore: null });
  readonly backupTargets = signal<BackupTarget[]>([]); readonly backups = signal<Backup[]>([]); readonly restorePreview = signal<RestorePreview | null>(null);
  readonly loading = signal(true); readonly busy = signal(false); readonly error = signal(''); readonly panelError = signal<PanelIssue | null>(null); readonly backupTargetSubmitAttempted = signal(false);
  readonly backupTargetFormRef = viewChild<NgForm>('backupTargetFormRef');
  readonly channelPanelOpen = signal(false); readonly rulePanelOpen = signal(false); readonly backupTargetPanelOpen = signal(false); readonly pendingAction = signal<PendingAction | null>(null); readonly editingChannelId = signal<string | null>(null); readonly editingBackupTargetId = signal<string | null>(null); readonly editingBackupTargetCredentialConfigured = signal(false); readonly editingBackupTargetCustomCaConfigured = signal(false);
  channelForm = emptyChannel(); ruleForm = emptyRule(); backupTargetForm = emptyBackupTarget(); restoreConfirmation = ''; restoreReason = '운영 구성 복원 실행';
  constructor() { void this.load(); }
  async load(): Promise<void> { this.loading.set(true); try { const [summary, channels, rules, deliveries, externalSummary, targets, backups] = await Promise.all([this.http.json<Summary>('/api/notifications/summary'), this.http.json<{ items: Channel[] }>('/api/notifications/channels'), this.http.json<{ items: Rule[] }>('/api/notifications/rules'), this.http.json<{ items: Delivery[] }>('/api/notifications/deliveries?limit=100'), this.http.json<ExternalSummary>('/api/external-channels/summary'), this.http.json<{ items: BackupTarget[] }>('/api/external-channels/backup-targets'), this.http.json<{ items: Backup[] }>('/api/external-channels/backups')]); this.summary.set(summary); this.channels.set(channels.items || []); this.rules.set(rules.items || []); this.deliveries.set(deliveries.items || []); this.externalSummary.set(externalSummary); this.backupTargets.set(targets.items || []); this.backups.set(backups.items || []); } catch (error) { this.error.set(`외부 채널 정보를 불러오지 못했습니다: ${String(error)}`); } finally { this.loading.set(false); } }
  openChannelPanel(): void { this.panelError.set(null); this.editingChannelId.set(null); this.channelForm = emptyChannel(); this.channelPanelOpen.set(true); }
  openRulePanel(): void { this.panelError.set(null); this.ruleForm = emptyRule(); this.rulePanelOpen.set(true); }
  openBackupTargetPanel(): void { this.panelError.set(null); this.backupTargetSubmitAttempted.set(false); this.editingBackupTargetId.set(null); this.editingBackupTargetCredentialConfigured.set(false); this.editingBackupTargetCustomCaConfigured.set(false); this.backupTargetForm = emptyBackupTarget(); this.backupTargetPanelOpen.set(true); }
  editBackupTarget(target: BackupTarget): void {
    this.panelError.set(null);
    this.editingBackupTargetId.set(target.id);
    this.editingBackupTargetCredentialConfigured.set(target.credential.configured);
    this.editingBackupTargetCustomCaConfigured.set(Boolean(target.tlsTrust?.customCaConfigured));
    this.backupTargetForm = {
      ...emptyBackupTarget(),
      vendor: S3_PROFILES.some((profile) => profile.value === target.vendor) ? target.vendor as S3ProfileKey : 's3-compatible',
      name: target.name,
      endpoint: target.endpoint,
      region: target.region,
      bucketName: target.bucketName,
      bucketId: target.bucketId || '',
      pathPrefix: target.pathPrefix,
      tlsTrustMode: target.tlsTrust?.mode || 'system',
      customCaCertificatePem: '',
      bucketPrivate: target.bucketPrivate,
      lifecycleMode: target.lifecycleMode,
      serverSideEncryption: target.serverSideEncryption,
      reason: '',
    };
    this.backupTargetSubmitAttempted.set(false);
    this.backupTargetPanelOpen.set(true);
  }
  closePanels(): void { this.panelError.set(null); this.backupTargetSubmitAttempted.set(false); this.channelPanelOpen.set(false); this.rulePanelOpen.set(false); this.backupTargetPanelOpen.set(false); this.editingChannelId.set(null); this.editingBackupTargetId.set(null); this.editingBackupTargetCredentialConfigured.set(false); this.editingBackupTargetCustomCaConfigured.set(false); }
  async saveBackupTarget(): Promise<void> {
    this.backupTargetSubmitAttempted.set(true);
    this.backupTargetFormRef()?.form.markAllAsTouched();
    const invalidField = this.backupTargetFields().find((field) => this.backupTargetValidationError(field));
    if (invalidField) {
      this.panelError.set(null);
      this.focusBackupTargetField(invalidField);
      return;
    }
    await this.mutatePanel(async () => {
      const editingId = this.editingBackupTargetId();
      await this.request(editingId ? `/api/external-channels/backup-targets/${editingId}` : '/api/external-channels/backup-targets', this.backupTargetForm, editingId ? 'PUT' : 'POST');
      this.backupTargetForm.accessKeyId = '';
      this.backupTargetForm.applicationKey = '';
      this.closePanels();
    });
  }
  testBackupTarget(target: BackupTarget): void { this.openPendingAction('S3 연결 테스트', `${target.name} 버킷에 AWS Signature v4로 접근 가능한지 검증합니다.`, `/api/external-channels/backup-targets/${target.id}/test`, '연결 테스트'); }
  toggleBackupTarget(target: BackupTarget): void { this.openPendingAction(target.enabled ? '백업 대상 중지' : '백업 대상 활성화', `${target.name} 대상의 자동·수동 백업 사용 상태를 ${target.enabled ? '중지' : '활성화'}합니다. 활성화 후에는 연결 테스트를 다시 실행해야 Ready 상태가 됩니다.`, `/api/external-channels/backup-targets/${target.id}/${target.enabled ? 'disable' : 'enable'}`, target.enabled ? '대상 중지' : '대상 활성화'); }
  removeBackupTarget(target: BackupTarget): void {
    const confirmation = `REMOVE ${target.id}`;
    this.openPendingAction('외부 저장소 연결 해제', `${target.name}의 저장된 자격 증명과 대상 메타데이터를 제거합니다. 기존 백업 이력이 있으면 복원 가능성을 보존하기 위해 서버가 거부합니다.`, `/api/external-channels/backup-targets/${target.id}`, '연결 해제', undefined, { method: 'DELETE', requiredConfirmation: confirmation, danger: true });
  }
  async previewRestore(backup: Backup): Promise<void> { this.busy.set(true); this.error.set(''); try { const response = await this.http.request(`/api/external-channels/backups/${backup.id}/restore-preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: '운영 구성 복원 사전 검토' }) }); const output = await response.json().catch(() => ({})); if (!response.ok) throw new Error(output.error || `HTTP ${response.status}`); this.restorePreview.set(output as RestorePreview); this.restoreConfirmation = ''; this.restoreReason = '운영 구성 복원 실행'; } catch (error) { this.error.set(`복원 미리보기를 만들지 못했습니다: ${String(error)}`); } finally { this.busy.set(false); } }
  cancelRestore(): void { this.panelError.set(null); this.restorePreview.set(null); this.restoreConfirmation = ''; }
  async applyRestore(): Promise<void> { const preview = this.restorePreview(); if (!preview) return; await this.mutatePanel(async () => { await this.request(`/api/external-channels/restores/${preview.restoreId}/apply`, { confirmation: this.restoreConfirmation.trim(), reason: this.restoreReason.trim() }); this.cancelRestore(); }); }
  async createChannel(): Promise<void> { await this.mutatePanel(async () => { const f = this.channelForm; const config = f.provider === 'smtp' ? { host: f.smtpHost, port: Number(f.smtpPort), from: f.smtpFrom, recipients: csv(f.smtpRecipients), titlePrefix: f.titlePrefix } : f.provider === 'twilio' ? { accountSid: f.twilioAccountSid, messagingServiceSid: f.twilioServiceSid, from: f.twilioFrom, recipients: csv(f.twilioRecipients), titlePrefix: f.titlePrefix } : { target: f.target, titlePrefix: f.titlePrefix }; const secret = f.provider === 'smtp' ? { username: f.smtpUsername, password: f.smtpPassword } : f.provider === 'twilio' ? { authToken: f.twilioToken } : { webhookUrl: f.webhookUrl }; const editingId = this.editingChannelId(); await this.request(editingId ? `/api/notifications/channels/${editingId}` : '/api/notifications/channels', { name: f.name, provider: f.provider, config, secret, reason: f.reason }, editingId ? 'PUT' : 'POST'); this.closePanels(); }); }
  async editSmtp(channel: Channel): Promise<void> { this.busy.set(true); this.error.set(''); this.panelError.set(null); try { const value = await this.http.json<{ name: string; provider: Provider; config: { host: string; port: number; from: string; recipients: string[]; titlePrefix?: string } }>(`/api/notifications/channels/${channel.id}`); this.channelForm = { ...emptyChannel(), name: value.name, provider: value.provider, smtpHost: value.config.host || '', smtpPort: Number(value.config.port || 587), smtpFrom: value.config.from || '', smtpRecipients: (value.config.recipients || []).join(', '), titlePrefix: value.config.titlePrefix || '' }; this.editingChannelId.set(channel.id); this.channelPanelOpen.set(true); } catch (error) { this.error.set(`SMTP 구성을 불러오지 못했습니다: ${String(error)}`); } finally { this.busy.set(false); } }
  async createRule(): Promise<void> { await this.mutatePanel(async () => { const f = this.ruleForm; await this.request('/api/notifications/rules', { name: f.name, priority: Number(f.priority), minSeverity: f.minSeverity, sources: csv(f.sources), categories: csv(f.categories), channelIds: f.channelIds, dedupWindowSeconds: Number(f.dedupWindowSeconds), reason: f.reason }); this.closePanels(); }); }
  toggle(channel: Channel): void { this.openPendingAction(channel.enabled ? '채널 비활성화' : '채널 활성화', `${channel.name} 채널을 ${channel.enabled ? '중지' : '활성화'}합니다.`, `/api/notifications/channels/${channel.id}/${channel.enabled ? 'disable' : 'enable'}`, channel.enabled ? '채널 중지' : '채널 활성화'); }
  test(channel: Channel): void { this.openPendingAction('테스트 전송', `${channel.name}으로 운영 테스트 알림을 전송합니다.`, `/api/notifications/channels/${channel.id}/test`, '테스트 전송', channel.provider === 'smtp' ? '' : undefined); }
  retry(delivery: Delivery): void { this.openPendingAction('전달 재시도', `${delivery.channel?.name || '선택한 채널'}의 실패 전달을 즉시 재시도 대기열로 되돌립니다.`, `/api/notifications/deliveries/${delivery.id}/retry`, '재시도 요청'); }
  setRuleChannel(id: string, checked: boolean): void { this.ruleForm.channelIds = checked ? [...this.ruleForm.channelIds, id] : this.ruleForm.channelIds.filter((item) => item !== id); }
  checkboxChecked(event: Event): boolean { return (event.target as HTMLInputElement).checked; }
  providerLabel(provider: Provider | string): string { return ({ slack: 'Slack', discord: 'Discord', smtp: 'Email', twilio: 'SMS' } as Record<string, string>)[provider] || provider; }
  ruleChannelNames(rule: Rule): string { return rule.channels.map((channel) => channel.name).join(', '); }
  isFailed(status: string): boolean { return status === 'failed' || status === 'dead-letter'; }
  validEmail(value: string): boolean { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value || '').trim()); }
  fmt(value?: string): string { const date = new Date(value || ''); return Number.isNaN(date.getTime()) ? '—' : date.toISOString().replace('T', ' ').slice(0, 19); }
  fileSize(value: number): string { if (!value) return '—'; if (value < 1024) return `${value} B`; if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`; return `${(value / 1024 / 1024).toFixed(1)} MiB`; }
  totalEntries(backup: Backup): number { return Object.values(backup.entryCounts || {}).reduce((sum, value) => sum + Number(value || 0), 0); }
  shortDigest(value: string): string { return value ? `${value.slice(0, 18)}…${value.slice(-8)}` : 'digest pending'; }
  applyS3Profile(value: string): void {
    const previous = this.selectedS3Profile();
    const profile = S3_PROFILES.find((item) => item.value === value) || S3_PROFILES[0];
    const endpointWasSuggested = !this.backupTargetForm.endpoint.trim() || this.backupTargetForm.endpoint === previous.endpoint;
    const regionWasSuggested = !this.backupTargetForm.region.trim() || this.backupTargetForm.region === previous.region;
    this.backupTargetForm.vendor = profile.value;
    if (endpointWasSuggested) this.backupTargetForm.endpoint = profile.endpoint;
    if (regionWasSuggested) this.backupTargetForm.region = profile.region;
  }
  selectedS3Profile(): S3Profile { return S3_PROFILES.find((profile) => profile.value === this.backupTargetForm.vendor) || S3_PROFILES[0]; }
  s3ProfileLabel(value: string): string { return S3_PROFILES.find((profile) => profile.value === value)?.label || 'S3 호환 저장소'; }
  s3ProfileLogo(value: string): string { return S3_PROFILES.find((profile) => profile.value === value)?.logo || S3_PROFILES[0].logo; }
  credentialIdHint(): string {
    if (this.backupTargetForm.vendor === 'backblaze-b2') return 'Backblaze App Keys 화면의 25자 keyID입니다.';
    return '저장소가 발급한 S3 Access key ID입니다.';
  }
  credentialSecretHint(): string {
    if (this.backupTargetForm.vendor === 'backblaze-b2') return '키 생성 직후 한 번만 표시되는 31자 applicationKey입니다.';
    return 'Access key ID와 함께 발급된 Secret access key입니다.';
  }
  backupTargetFieldError(field: string): string {
    const issue = this.backupTargetValidationError(field);
    if (!issue) return '';
    const value = this.backupTargetForm;
    const entered = ({ name: value.name, region: value.region, endpoint: value.endpoint, bucketName: value.bucketName, bucketId: value.bucketId, pathPrefix: value.pathPrefix, accessKeyId: value.accessKeyId, applicationKey: value.applicationKey, customCaCertificatePem: value.customCaCertificatePem } as Record<string, string>)[field]?.trim();
    const pairedCredentialEntered = (field === 'accessKeyId' && value.applicationKey.trim()) || (field === 'applicationKey' && value.accessKeyId.trim());
    return this.backupTargetSubmitAttempted() || !!entered || !!pairedCredentialEntered ? issue : '';
  }
  backupTargetFormValid(): boolean { return this.backupTargetFields().every((field) => !this.backupTargetValidationError(field)); }
  fieldLabel(field: string): string { return ({ accessKeyId: 'Access key ID', applicationKey: 'Secret access key', customCaCertificatePem: '사용자 지정 CA 인증서', tlsTrustMode: 'TLS 신뢰 방식', bucketName: 'Bucket name', bucketId: 'Bucket ID', region: 'Region', endpoint: 'S3 endpoint', pathPrefix: 'Object prefix', name: '연결 이름', confirmation: '확인 문구' } as Record<string, string>)[field] || '요청 오류'; }
  private backupTargetFields(): string[] { return ['name', 'region', 'endpoint', 'bucketName', 'bucketId', 'pathPrefix', 'customCaCertificatePem', 'accessKeyId', 'applicationKey']; }
  private backupTargetValidationError(field: string): string {
    const value = this.backupTargetForm;
    if (field === 'name' && !value.name.trim()) return '이 대상을 구분할 연결 이름을 입력하세요.';
    if (field === 'name' && (value.name.trim().length < 2 || value.name.trim().length > 80)) return '연결 이름은 2~80자로 입력하세요.';
    if (field === 'region' && !value.region.trim()) return 'S3 서명에 사용할 Region을 입력하세요.';
    if (field === 'region' && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.region.trim().toLowerCase())) return 'Region은 영문 소문자·숫자로 시작하는 1~64자 값이어야 합니다.';
    if (field === 'endpoint') {
      if (!value.endpoint.trim()) return 'S3 API에 연결할 HTTPS endpoint를 입력하세요.';
      try {
        const endpoint = new URL(value.endpoint.trim());
        if (endpoint.protocol !== 'https:' || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['', '/'].includes(endpoint.pathname)) {
          return 'Endpoint는 경로·query·인증 정보가 없는 HTTPS origin으로 입력하세요.';
        }
      } catch { return '올바른 HTTPS S3 endpoint를 입력하세요.'; }
    }
    if (field === 'bucketName' && !value.bucketName.trim()) return '백업 객체를 저장할 Bucket name을 입력하세요.';
    if (field === 'bucketName' && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value.bucketName.trim().toLowerCase())) return 'Bucket name은 영문 소문자·숫자로 시작하고 끝나는 3~63자 값이어야 합니다.';
    if (field === 'bucketId' && value.bucketId.trim() && !/^[A-Za-z0-9_-]{1,128}$/.test(value.bucketId.trim())) return 'Bucket ID는 128자 이내의 영문·숫자·밑줄·하이픈만 입력하세요.';
    if (field === 'pathPrefix' && !value.pathPrefix.trim()) return '백업 객체를 구분할 Object prefix를 입력하세요.';
    if (field === 'pathPrefix' && (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value.pathPrefix.trim()) || /(^|\/)\.\.?(\/|$)/.test(value.pathPrefix.trim()))) return 'Object prefix는 문자나 숫자로 시작하고 경로 이탈 구문을 포함할 수 없습니다.';
    if (field === 'customCaCertificatePem' && value.tlsTrustMode === 'custom-ca') {
      const pem = value.customCaCertificatePem.trim();
      if (!pem && !this.editingBackupTargetCustomCaConfigured()) return '사설 인증서를 검증할 CA 인증서를 PEM 형식으로 입력하세요.';
      if (pem && (pem.length > 65536 || !/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----$/.test(pem))) return 'CA 인증서는 64 KiB 이하의 PEM 인증서 묶음이어야 합니다.';
    }
    const credentialsBlank = !value.accessKeyId.trim() && !value.applicationKey.trim();
    if (field === 'accessKeyId' && !(this.editingBackupTargetId() && credentialsBlank) && !/^[\x21-\x7e]{3,128}$/.test(value.accessKeyId.trim())) return value.applicationKey.trim() && !value.accessKeyId.trim() ? 'Secret access key와 함께 Access key ID도 입력하세요.' : 'Access key ID는 공백 없이 3~128자로 입력하세요.';
    if (field === 'applicationKey' && !(this.editingBackupTargetId() && credentialsBlank) && !/^[\x21-\x7e]{8,256}$/.test(value.applicationKey.trim())) return value.accessKeyId.trim() && !value.applicationKey.trim() ? 'Access key ID와 함께 Secret access key도 입력하세요.' : 'Secret access key는 공백 없이 8~256자로 입력하세요.';
    return '';
  }
  private focusBackupTargetField(field: string): void {
    if (typeof document === 'undefined') return;
    const name = ({ name: 'backup-name', region: 'backup-region', endpoint: 'backup-endpoint', bucketName: 'backup-bucket-name', bucketId: 'backup-bucket-id', pathPrefix: 'backup-prefix', customCaCertificatePem: 'backup-custom-ca', accessKeyId: 'backup-access-key', applicationKey: 'backup-secret-key' } as Record<string, string>)[field];
    queueMicrotask(() => {
      const element = document.querySelector<HTMLElement>(`[name="${name}"]`);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element?.focus({ preventScroll: true });
    });
  }
  private async request(path: string, body: unknown, method = 'POST'): Promise<void> { const response = await this.http.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); if (!response.ok) { const out = await response.json().catch(() => ({})); throw new PanelRequestError(out.error || `HTTP ${response.status}`, out.field || ''); } }
  private openPendingAction(title: string, description: string, path: string, confirmLabel: string, testRecipient?: string, options: { method?: 'POST' | 'DELETE'; requiredConfirmation?: string; danger?: boolean } = {}): void { this.panelError.set(null); this.pendingAction.set({ title, description, path, confirmLabel, reason: '운영자 수동 실행', testRecipient, confirmation: '', method: options.method || 'POST', requiredConfirmation: options.requiredConfirmation, danger: options.danger }); }
  cancelPendingAction(): void { this.panelError.set(null); this.pendingAction.set(null); }
  async executePendingAction(): Promise<void> { const action = this.pendingAction(); if (!action) return; await this.mutatePanel(async () => { await this.request(action.path, { reason: action.reason.trim(), ...(action.testRecipient !== undefined ? { testRecipient: action.testRecipient.trim() } : {}), ...(action.requiredConfirmation ? { confirmation: action.confirmation.trim() } : {}) }, action.method); this.cancelPendingAction(); }); }
  private async mutatePanel(action: () => Promise<void>): Promise<void> { this.busy.set(true); this.panelError.set(null); try { await action(); await this.load(); } catch (error) { this.panelError.set({ message: error instanceof Error ? error.message : String(error), field: error instanceof PanelRequestError ? error.field : '' }); } finally { this.busy.set(false); } }
}
class PanelRequestError extends Error { constructor(message: string, readonly field: string) { super(message); } }
function csv(value: string): string[] { return String(value || '').split(',').map((item) => item.trim()).filter(Boolean); }
