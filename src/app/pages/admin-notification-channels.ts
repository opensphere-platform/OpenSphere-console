import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClarityModule } from '@clr/angular';
import { HttpService } from '../core/http.service';
import { OsPageHeader } from '../os/os-page-header';
import { OsPanel } from '../os/os-panel';

type Provider = 'slack' | 'discord' | 'smtp' | 'twilio';
interface Channel { id: string; name: string; provider: Provider; channelType: string; enabled: boolean; healthState: string; target: string; credential: { configured: boolean; version: number }; lastTest: { status: string; at: string; errorCode?: string | null } | null; lastSuccessAt: string | null; }
interface Rule { id: string; name: string; enabled: boolean; priority: number; minSeverity: string; sources: string[]; categories: string[]; channels: { id: string; name: string; provider: string }[]; dedupWindowSeconds: number; updatedAt: string; }
interface Delivery { id: string; status: string; attempts: number; providerMessageId: string; lastErrorCode: string; updatedAt: string; nextAttemptAt: string; event: { title: string; source: string; severity: string; occurred_at: string } | null; channel: { name: string; provider: string } | null; }
interface Summary { active: number; healthy: number; degraded: number; failed24h: number; deadLetter: number; paused: boolean; }
interface PendingAction { title: string; description: string; path: string; reason: string; confirmLabel: string; testRecipient?: string; }

const emptyChannel = () => ({ name: '', provider: 'slack' as Provider, target: '', webhookUrl: '', titlePrefix: '', smtpHost: '', smtpPort: 587, smtpSecure: false, smtpFrom: '', smtpRecipients: '', smtpUsername: '', smtpPassword: '', twilioAccountSid: '', twilioServiceSid: '', twilioFrom: '', twilioRecipients: '', twilioToken: '', reason: '' });
const emptyRule = () => ({ name: '', priority: 100, minSeverity: 'error', sources: '', categories: '', channelIds: [] as string[], dedupWindowSeconds: 600, reason: '' });

@Component({
  selector: 'os-admin-notification-channels',
  imports: [ClarityModule, FormsModule, OsPageHeader, OsPanel],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <div class="os-page">
      <os-page-header title="외부 채널" tag="Core·Admin · Outbound delivery" />
      <div class="manage-page-lead"><p>신뢰된 Console 이벤트를 이메일, SMS, Slack, Discord로 전달합니다. 자격 증명은 저장 후 다시 표시되지 않습니다.</p><span>server-side dispatcher · append-only delivery evidence</span></div>

      <section class="manage-status-rail" aria-label="외부 채널 전달 상태">
        <div><span>Active</span><strong>{{ summary().active }}</strong><small>발송 가능 채널</small></div>
        <div><span>Healthy</span><strong class="ok">{{ summary().healthy }}</strong><small>최근 수락·테스트 정상</small></div>
        <div><span>Degraded</span><strong [class.warn]="summary().degraded > 0">{{ summary().degraded }}</strong><small>재시도 또는 설정 점검</small></div>
        <div><span>Failed 24h</span><strong [class.danger]="summary().failed24h > 0">{{ summary().failed24h }}</strong><small>최종 실패</small></div>
        <div><span>Dead letter</span><strong [class.danger]="summary().deadLetter > 0">{{ summary().deadLetter }}</strong><small>수동 조치 필요</small></div>
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
      </clr-tabs>
    </div>

    <os-panel [open]="channelPanelOpen()" [title]="editingChannelId() ? '이메일 채널 편집' : '외부 채널 연결'" subtitle="Secret은 Dispatcher가 암호화해 보관" (closed)="closePanels()">
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
        <clr-input-container class="wide"><label>변경 사유</label><input clrInput [(ngModel)]="channelForm.reason" name="channel-reason" placeholder="운영 알림 채널 최초 연결" /><clr-control-helper>사유는 append-only 감사에 남습니다.</clr-control-helper></clr-input-container>
      </form>
      <div osPanelFooter><button class="btn btn-primary" [disabled]="busy()" (click)="createChannel()">{{ editingChannelId() ? '구성 저장' : '연결 저장' }}</button><button class="btn btn-outline" [disabled]="busy()" (click)="closePanels()">취소</button></div>
    </os-panel>

    <os-panel [open]="rulePanelOpen()" title="라우팅 규칙 추가" subtitle="명시적으로 일치한 이벤트만 전송" (closed)="closePanels()">
      <form clrForm clrLayout="vertical" class="channel-form" autocomplete="off">
        <clr-input-container><label>규칙 이름</label><input clrInput [(ngModel)]="ruleForm.name" name="rule-name" placeholder="Platform error" /></clr-input-container><clr-input-container><label>우선순위</label><input clrInput type="number" [(ngModel)]="ruleForm.priority" name="rule-priority" /></clr-input-container><clr-select-container><label>최소 심각도</label><select clrSelect [(ngModel)]="ruleForm.minSeverity" name="rule-severity"><option value="info">info</option><option value="warning">warning</option><option value="error">error</option><option value="critical">critical</option></select></clr-select-container><clr-input-container><label>Source (쉼표 구분)</label><input clrInput [(ngModel)]="ruleForm.sources" name="rule-sources" placeholder="audit,platform-control" /></clr-input-container><clr-input-container><label>Category (쉼표 구분)</label><input clrInput [(ngModel)]="ruleForm.categories" name="rule-categories" placeholder="declarative-change" /></clr-input-container><clr-input-container><label>Dedup seconds</label><input clrInput type="number" [(ngModel)]="ruleForm.dedupWindowSeconds" name="rule-dedup" /></clr-input-container>
        <clr-checkbox-container class="wide"><label>대상 채널</label>@for (channel of channels(); track channel.id) { <clr-checkbox-wrapper><input type="checkbox" clrCheckbox [checked]="ruleForm.channelIds.includes(channel.id)" (change)="setRuleChannel(channel.id, checkboxChecked($event))" /><label>{{ channel.name }} · {{ providerLabel(channel.provider) }}</label></clr-checkbox-wrapper> }</clr-checkbox-container>
        <clr-input-container class="wide"><label>변경 사유</label><input clrInput [(ngModel)]="ruleForm.reason" name="rule-reason" placeholder="플랫폼 오류 외부 전파 규칙 추가" /></clr-input-container>
      </form>
      <div osPanelFooter><button class="btn btn-primary" [disabled]="busy()" (click)="createRule()">규칙 저장</button><button class="btn btn-outline" [disabled]="busy()" (click)="closePanels()">취소</button></div>
    </os-panel>

    <os-panel [open]="!!pendingAction()" [title]="pendingAction()?.title || ''" subtitle="감사 로그에 변경 사유를 남깁니다." (closed)="cancelPendingAction()">
      @if (pendingAction(); as action) {
        <p class="action-description">{{ action.description }}</p>
        <form clrForm clrLayout="vertical">
          @if (action.testRecipient !== undefined) { <clr-input-container><label>테스트 수신 메일 주소</label><input clrInput type="email" [(ngModel)]="action.testRecipient" name="test-recipient" autocomplete="email" placeholder="test@example.com" required /><clr-control-helper>테스트에만 사용되며, 채널의 기본 수신자는 변경하지 않습니다.</clr-control-helper></clr-input-container> }
          <clr-input-container><label>실행 사유</label><input clrInput [(ngModel)]="action.reason" name="action-reason" minlength="8" maxlength="240" /><clr-control-helper>최소 8자 · append-only 감사 로그에 기록</clr-control-helper></clr-input-container>
        </form>
      }
      <div osPanelFooter>@if (pendingAction(); as action) { <button class="btn btn-primary" [disabled]="busy() || action.reason.trim().length < 8 || (action.testRecipient !== undefined && !validEmail(action.testRecipient))" (click)="executePendingAction()">{{ action.confirmLabel }}</button><button class="btn btn-outline" [disabled]="busy()" (click)="cancelPendingAction()">취소</button> }</div>
    </os-panel>
  `,
  styles: [`
    .os-actions { display:flex; align-items:center; gap:.5rem; margin:.7rem 0; }.os-sub,.os-mono { color:var(--os-ink-muted); font-size:.68rem; }.os-mono { font-family:var(--os-font-mono,monospace); }.channel-form { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:0 .9rem; }.wide { grid-column:1 / -1; } :host ::ng-deep .channel-form .clr-control-container,:host ::ng-deep .channel-form .clr-input-wrapper,:host ::ng-deep .channel-form .clr-select-wrapper { width:100%; } :host ::ng-deep .channel-form input.clr-input,:host ::ng-deep .channel-form select.clr-select { width:100%;max-width:none; } @media (max-width:760px) { .channel-form { grid-template-columns:1fr; }.wide { grid-column:1; } }
  `],
})
export class AdminNotificationChannels {
  private readonly http = inject(HttpService);
  readonly summary = signal<Summary>({ active: 0, healthy: 0, degraded: 0, failed24h: 0, deadLetter: 0, paused: false });
  readonly channels = signal<Channel[]>([]); readonly rules = signal<Rule[]>([]); readonly deliveries = signal<Delivery[]>([]);
  readonly loading = signal(true); readonly busy = signal(false); readonly error = signal('');
  readonly channelPanelOpen = signal(false); readonly rulePanelOpen = signal(false); readonly pendingAction = signal<PendingAction | null>(null); readonly editingChannelId = signal<string | null>(null);
  channelForm = emptyChannel(); ruleForm = emptyRule();
  constructor() { void this.load(); }
  async load(): Promise<void> { this.loading.set(true); try { const [summary, channels, rules, deliveries] = await Promise.all([this.http.json<Summary>('/api/notifications/summary'), this.http.json<{ items: Channel[] }>('/api/notifications/channels'), this.http.json<{ items: Rule[] }>('/api/notifications/rules'), this.http.json<{ items: Delivery[] }>('/api/notifications/deliveries?limit=100')]); this.summary.set(summary); this.channels.set(channels.items || []); this.rules.set(rules.items || []); this.deliveries.set(deliveries.items || []); } catch (error) { this.error.set(`외부 채널 정보를 불러오지 못했습니다: ${String(error)}`); } finally { this.loading.set(false); } }
  openChannelPanel(): void { this.editingChannelId.set(null); this.channelForm = emptyChannel(); this.channelPanelOpen.set(true); }
  openRulePanel(): void { this.ruleForm = emptyRule(); this.rulePanelOpen.set(true); }
  closePanels(): void { this.channelPanelOpen.set(false); this.rulePanelOpen.set(false); this.editingChannelId.set(null); }
  async createChannel(): Promise<void> { await this.mutate(async () => { const f = this.channelForm; const config = f.provider === 'smtp' ? { host: f.smtpHost, port: Number(f.smtpPort), from: f.smtpFrom, recipients: csv(f.smtpRecipients), titlePrefix: f.titlePrefix } : f.provider === 'twilio' ? { accountSid: f.twilioAccountSid, messagingServiceSid: f.twilioServiceSid, from: f.twilioFrom, recipients: csv(f.twilioRecipients), titlePrefix: f.titlePrefix } : { target: f.target, titlePrefix: f.titlePrefix }; const secret = f.provider === 'smtp' ? { username: f.smtpUsername, password: f.smtpPassword } : f.provider === 'twilio' ? { authToken: f.twilioToken } : { webhookUrl: f.webhookUrl }; const editingId = this.editingChannelId(); await this.request(editingId ? `/api/notifications/channels/${editingId}` : '/api/notifications/channels', { name: f.name, provider: f.provider, config, secret, reason: f.reason }, editingId ? 'PUT' : 'POST'); this.closePanels(); }); }
  async editSmtp(channel: Channel): Promise<void> { this.busy.set(true); this.error.set(''); try { const value = await this.http.json<{ name: string; provider: Provider; config: { host: string; port: number; from: string; recipients: string[]; titlePrefix?: string } }>(`/api/notifications/channels/${channel.id}`); this.channelForm = { ...emptyChannel(), name: value.name, provider: value.provider, smtpHost: value.config.host || '', smtpPort: Number(value.config.port || 587), smtpFrom: value.config.from || '', smtpRecipients: (value.config.recipients || []).join(', '), titlePrefix: value.config.titlePrefix || '' }; this.editingChannelId.set(channel.id); this.channelPanelOpen.set(true); } catch (error) { this.error.set(`SMTP 구성을 불러오지 못했습니다: ${String(error)}`); } finally { this.busy.set(false); } }
  async createRule(): Promise<void> { await this.mutate(async () => { const f = this.ruleForm; await this.request('/api/notifications/rules', { name: f.name, priority: Number(f.priority), minSeverity: f.minSeverity, sources: csv(f.sources), categories: csv(f.categories), channelIds: f.channelIds, dedupWindowSeconds: Number(f.dedupWindowSeconds), reason: f.reason }); this.closePanels(); }); }
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
  private async request(path: string, body: unknown, method = 'POST'): Promise<void> { const response = await this.http.request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); if (!response.ok) { const out = await response.json().catch(() => ({})); throw new Error(out.error || `HTTP ${response.status}`); } }
  private openPendingAction(title: string, description: string, path: string, confirmLabel: string, testRecipient?: string): void { this.pendingAction.set({ title, description, path, confirmLabel, reason: '운영자 수동 실행', testRecipient }); }
  cancelPendingAction(): void { this.pendingAction.set(null); }
  async executePendingAction(): Promise<void> { const action = this.pendingAction(); if (!action) return; await this.mutate(async () => { await this.request(action.path, { reason: action.reason.trim(), ...(action.testRecipient !== undefined ? { testRecipient: action.testRecipient.trim() } : {}) }); this.cancelPendingAction(); }); }
  private async mutate(action: () => Promise<void>): Promise<void> { this.busy.set(true); this.error.set(''); try { await action(); await this.load(); } catch (error) { this.error.set(`변경을 완료하지 못했습니다: ${String(error)}`); } finally { this.busy.set(false); } }
}
function csv(value: string): string[] { return String(value || '').split(',').map((item) => item.trim()).filter(Boolean); }
