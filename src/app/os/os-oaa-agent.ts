import { Component, ChangeDetectionStrategy, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CarbonIcon } from './carbon-icon';
import { AuthService } from '../core/auth.service';
import Send16 from '@carbon/icons/es/send/16';
import Close16 from '@carbon/icons/es/close/16';
import Restart16 from '@carbon/icons/es/restart/16';
import Maximize16 from '@carbon/icons/es/maximize/16';
import Edit16 from '@carbon/icons/es/edit/16';
import Time16 from '@carbon/icons/es/time/16';
import OverflowMenuVertical16 from '@carbon/icons/es/overflow-menu--vertical/16';
import TrashCan16 from '@carbon/icons/es/trash-can/16';
import Copy16 from '@carbon/icons/es/copy/16';

type OaaRole = 'user' | 'assistant' | 'system';
interface OaaSource {
  title: string;
  sourceType: string;
  sourceId: string;
  chunkIndex: number;
  score?: number;
  authorityTier?: number | null;
  documentType?: string;
  sectionHeading?: string;
  route?: string;
  sourcePath?: string;
  sourceUrl?: string;
  sourceName?: string;
}
interface OaaConcept {
  id: string;
  type: string;
  name: string;
  summary?: string;
  authorityTier?: number | null;
  sourceIds?: string[];
}
interface OaaSuggestedAction {
  id: string;
  title: string;
  intent: string;
  toolId: string;
  riskLevel: string;
  confirmation: string;
  command: string;
}
interface OaaMessage {
  id: string;
  role: OaaRole;
  content: string;
  meta?: string;
  sources?: OaaSource[];
  concepts?: OaaConcept[];
  actions?: OaaSuggestedAction[];
}
interface OaaSession {
  id: string;
  title: string;
  messages: OaaMessage[];
  updatedAt: string;
}

/**
 * os-oaa-agent — Console-native global OAA(OpenSphere AI Agent) 우측 도크 패널.
 * 헤더에서 토글되는 셸 소유 컴포넌트다(route/plugin/subShell/Registry 항목이 아님).
 * 안전 렌더링만 사용(텍스트 바인딩, innerHTML 없음) — 답변·출처·개념 메타데이터는 항상 문자열로 표시한다.
 * 동일 출처 `/api/oaa/chat`만 호출하며, 인증은 AuthService의 id_token(Bearer)로 처리한다.
 * API 키는 이 컴포넌트에 저장·표시되지 않는다(키 관리는 /manage 백본 관리 화면의 서버측 책임).
 * 제안 행동(suggestedActions)은 입력창에 명령을 채워 넣을 뿐 — Kubernetes를 직접 변경하는 우회 경로가 아니다.
 * 실제 비-read 실행은 게이트웨이(서버) 단계에서 확인/감사 후에만 이루어지며, Cluster Manager Activated +
 * HIS Preflight Ready 이전에는 서버가 모든 Kubernetes mutation/action tool을 제공하지 않는다
 * (CONSTITUTION-0004 §4.2, fail-closed — 이 컴포넌트는 UI 제안일 뿐 gate를 대체하지 않는다).
 * Provider/키 미배포 시에도 폭이 셸을 깨지 않고 이 패널 안에서 오류 메시지로 성능 저하(Degraded)를 표시한다.
 *
 * 저장소 경계: 대화 내용(세션/메시지)은 `sessionStorage`에만 저장한다 — 현재 탭에서만 유지되고, 탭을 닫거나
 * 다른 탭/새 로그인에서는 보이지 않는다. 대화 내용을 `localStorage`(영구 저장)에 절대 쓰지 않는다.
 * dock width 같은 비민감 UI preference(패널 폭)만 `localStorage`에 저장해 탭 간·재방문 간 유지한다.
 */
@Component({
  selector: 'os-oaa-agent',
  imports: [FormsModule, CarbonIcon],
  template: `
    <button class="oaa-trigger" [class.oaa-active]="open()" (click)="toggle()" title="OpenSphere AI Agent" aria-label="OpenSphere AI Agent">
      <span class="oaa-agent-mark" aria-hidden="true">
        <span class="oaa-agent-spark"></span>
        <span class="oaa-agent-smile"></span>
      </span>
    </button>

    @if (open()) {
      <aside class="oaa-panel" [class.oaa-full]="full()" role="dialog" aria-label="OpenSphere AI Agent">
        <div class="oaa-resizer" (pointerdown)="startResize($event)" (dblclick)="resetDockWidth()" title="Drag to resize chat. Double-click to reset." aria-hidden="true"></div>
        <header class="oaa-head">
          <div class="oaa-head-left">
            <button class="oaa-iconbtn" (click)="toggleFull()" [title]="full() ? 'Restore dock' : 'Expand to workspace'" [attr.aria-label]="full() ? 'Restore dock' : 'Expand to workspace'">
              <os-cicon [icon]="iconMaximize" [size]="16" />
            </button>
            <button class="oaa-new" (click)="newChat()" title="New chat">New chat</button>
          </div>
          <div class="oaa-tools">
            <button class="oaa-iconbtn" (click)="editTitle()" title="Edit chat title" aria-label="Edit chat title"><os-cicon [icon]="iconEdit" [size]="16" /></button>
            <button class="oaa-iconbtn" [class.oaa-selected]="historyOpen()" (click)="toggleHistory()" title="Chat history" aria-label="Chat history"><os-cicon [icon]="iconHistory" [size]="16" /></button>
            <button class="oaa-iconbtn" [class.oaa-selected]="menuOpen()" (click)="menuOpen.set(!menuOpen())" title="More" aria-label="More"><os-cicon [icon]="iconMore" [size]="16" /></button>
            <button class="oaa-iconbtn" (click)="close()" title="Close" aria-label="Close"><os-cicon [icon]="iconClose" [size]="16" /></button>

            @if (menuOpen()) {
              <div class="oaa-menu" role="menu">
                <button type="button" (click)="copyTranscript()"><os-cicon [icon]="iconCopy" [size]="16" /> Copy transcript</button>
                <button type="button" (click)="clearHistory()"><os-cicon [icon]="iconTrash" [size]="16" /> Clear history</button>
              </div>
            }
          </div>
        </header>

        <div class="oaa-chat-title">
          <span>{{ chatTitle() }}</span>
          <span>{{ modelLabel() }}</span>
        </div>

        @if (historyOpen()) {
          <div class="oaa-history">
            <div class="oaa-history-head">Recent chats <span>{{ sessions().length }}</span></div>
            @for (s of sessions(); track s.id) {
              <button type="button" class="oaa-history-item" (click)="loadSession(s)">
                <span>{{ s.title }}</span>
                <small>{{ relativeTime(s.updatedAt) }}</small>
              </button>
            } @empty {
              <div class="oaa-history-empty">No saved chats</div>
            }
          </div>
        }

        <div class="oaa-thread">
          @for (m of messages(); track m.id) {
            <div class="oaa-msg" [class.oaa-user]="m.role === 'user'" [class.oaa-assistant]="m.role === 'assistant'" [class.oaa-system]="m.role === 'system'">
              <div class="oaa-bubble">
                <div class="oaa-content">{{ m.content }}</div>
                @if (m.meta) { <div class="oaa-meta">{{ m.meta }}</div> }
                @if (m.sources?.length) {
                  <div class="oaa-sources" aria-label="OAA answer sources">
                    <div class="oaa-sources-title">Sources</div>
                    @for (s of m.sources || []; track sourceTrack(s)) {
                      <div class="oaa-source">
                        <span class="oaa-source-title" [title]="s.sourcePath || s.sourceUrl || s.sourceId">{{ s.title }}</span>
                        <span class="oaa-source-ref" [title]="s.sourcePath || s.sourceUrl || sourceLabel(s)">{{ sourceLabel(s) }}</span>
                      </div>
                    }
                  </div>
                }
                @if (m.concepts?.length) {
                  <div class="oaa-sources" aria-label="OAA concept graph">
                    <div class="oaa-sources-title">Concepts</div>
                    @for (c of m.concepts || []; track c.id) {
                      <div class="oaa-source">
                        <span class="oaa-source-title" [title]="c.summary || c.id">{{ c.name }}</span>
                        <span class="oaa-source-ref" [title]="c.id">{{ c.type }}{{ c.authorityTier == null ? '' : ' T' + c.authorityTier }}</span>
                      </div>
                    }
                  </div>
                }
                @if (m.actions?.length) {
                  <div class="oaa-sources oaa-actions-list" aria-label="OAA suggested actions">
                    <div class="oaa-sources-title">Suggested Actions</div>
                    @for (a of m.actions || []; track a.id) {
                      <div class="oaa-action-card">
                        <div>
                          <span class="oaa-source-title" [title]="a.id">{{ a.title }}</span>
                          <span class="oaa-source-ref" [title]="a.toolId">{{ a.intent }} / {{ a.riskLevel }} / {{ a.confirmation }}</span>
                        </div>
                        <button type="button" class="oaa-use-action" (click)="useSuggestedAction(a)">Use</button>
                      </div>
                    }
                  </div>
                }
              </div>
            </div>
          }
          @if (busy()) {
            <div class="oaa-msg oaa-assistant"><div class="oaa-bubble oaa-thinking"><span></span><span></span><span></span></div></div>
          }
        </div>

        @if (error()) {
          <div class="oaa-error">{{ error() }}</div>
        }

        <form class="oaa-compose" (submit)="send($event)">
          <textarea
            name="oaaPrompt"
            [(ngModel)]="draft"
            [disabled]="busy()"
            placeholder="@ for objects, / for commands"
            rows="3"
            (keydown)="onKeydown($event)"
          ></textarea>
          <button class="oaa-send" type="submit" [disabled]="busy() || !draft.trim()" title="Send" aria-label="Send">
            <os-cicon [icon]="iconSend" [size]="18" />
          </button>
        </form>
      </aside>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .oaa-trigger {
        display: inline-flex; align-items: center; justify-content: center;
        width: 36px; height: 36px; margin-right: 0.3rem;
        border: 0; border-radius: 4px; background: transparent; color: #c7d0e8;
        cursor: pointer;
      }
      .oaa-trigger:hover, .oaa-trigger.oaa-active { background: rgba(255, 255, 255, 0.1); color: #fff; }
      .oaa-agent-mark {
        position: relative; display: inline-flex; align-items: center; justify-content: center;
        width: 24px; height: 24px;
      }
      .oaa-agent-spark {
        position: absolute; top: 0; left: 8px; z-index: 1;
        width: 12px; height: 12px; transform: rotate(45deg);
        background: linear-gradient(135deg, #3b82f6, #9b5cff 52%, #ff4f8b);
        clip-path: polygon(50% 0, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0 50%, 38% 38%);
      }
      .oaa-agent-smile {
        position: absolute; left: 3px; bottom: 2px; width: 18px; height: 10px;
        border-bottom: 4px solid #6d5dfc; border-left: 4px solid #5f7cff;
        border-right: 4px solid #ff5c8a; border-top: 0;
        border-radius: 0 0 16px 16px; transform: rotate(1deg);
      }
      .oaa-agent-smile::after {
        content: ''; position: absolute; right: -6px; bottom: -6px;
        width: 8px; height: 3px; border-radius: 999px; background: #ff4f62;
      }
      .oaa-panel {
        position: fixed; top: 3rem; right: 0; bottom: 0; z-index: var(--os-z-oaa, 1000);
        width: var(--oaa-dock-width, 390px); display: flex; flex-direction: column;
        height: calc(100dvh - 3rem); max-height: calc(100dvh - 3rem);
        background: #f7f8fb; border-left: 1px solid #d9dde7;
        border-top-left-radius: 8px; overflow: hidden;
      }
      .oaa-panel.oaa-full {
        left: var(--oaa-full-left, 0px); width: auto; border-top-left-radius: 0;
      }
      .oaa-resizer {
        position: absolute; top: 0; bottom: 0; left: 0; z-index: 3;
        width: 12px; cursor: ew-resize; touch-action: none;
      }
      .oaa-resizer::after {
        content: ''; position: absolute; top: 0; bottom: 0; left: 0;
        width: 2px; background: #d9dde7; transition: background 120ms ease, box-shadow 120ms ease;
      }
      .oaa-resizer:hover::after, :host-context(body.oaa-agent-resizing) .oaa-resizer::after {
        background: #1f6feb; box-shadow: 0 0 0 2px rgba(31, 111, 235, 0.14);
      }
      .oaa-panel.oaa-full .oaa-resizer::after {
        background: transparent;
      }
      .oaa-head {
        flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
        height: 2.45rem; padding: 0 0.45rem; border-bottom: 1px solid #e5e7eb; background: #fff;
      }
      .oaa-head-left, .oaa-tools { display: flex; align-items: center; gap: 0.25rem; }
      .oaa-tools { position: relative; }
      .oaa-new {
        height: 1.75rem; padding: 0 0.65rem; border: 1px solid #e1e5ec; border-radius: 8px;
        background: #fff; color: #1f2733; cursor: pointer; font-size: 0.72rem;
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
      }
      .oaa-new:hover { background: #f7f8fb; }
      .oaa-iconbtn {
        display: inline-flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; border: 1px solid transparent; border-radius: 4px;
        background: transparent; color: #586174; cursor: pointer;
      }
      .oaa-iconbtn:hover, .oaa-iconbtn.oaa-selected { background: #eef2f7; color: #1f2733; border-color: #dce2eb; }
      .oaa-menu {
        position: absolute; top: 2rem; right: 1.8rem; z-index: 2;
        min-width: 10rem; padding: 0.3rem; border: 1px solid #dce2eb; border-radius: 6px;
        background: #fff; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.18);
      }
      .oaa-menu button {
        width: 100%; display: flex; align-items: center; gap: 0.45rem;
        border: 0; background: transparent; color: #1f2733; cursor: pointer;
        padding: 0.45rem 0.5rem; border-radius: 4px; text-align: left; font-size: 0.68rem;
      }
      .oaa-menu button:hover { background: #f2f5fa; }
      .oaa-chat-title {
        flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
        gap: 0.7rem; min-height: 2rem; padding: 0.4rem 0.8rem;
        border-bottom: 1px solid #e5e7eb; background: #fff; color: #1f2733;
      }
      .oaa-chat-title span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.76rem; font-weight: 600; }
      .oaa-chat-title span:last-child { flex: 0 0 auto; color: #6b7280; font-family: monospace; font-size: 0.56rem; }
      .oaa-history {
        flex: 0 0 auto; max-height: 13rem; overflow: auto;
        border-bottom: 1px solid #e5e7eb; background: #fff;
      }
      .oaa-history-head {
        display: flex; justify-content: space-between; padding: 0.55rem 0.8rem 0.35rem;
        color: #6b7280; font-size: 0.62rem; text-transform: uppercase;
      }
      .oaa-history-item {
        width: 100%; display: grid; grid-template-columns: 1fr auto; gap: 0.7rem;
        border: 0; background: transparent; padding: 0.5rem 0.8rem; cursor: pointer; text-align: left;
      }
      .oaa-history-item:hover { background: #f2f5fa; }
      .oaa-history-item span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #1f2733; font-size: 0.7rem; }
      .oaa-history-item small { color: #7a8496; font-size: 0.58rem; }
      .oaa-history-empty { padding: 0.8rem; color: #7a8496; font-size: 0.68rem; }
      .oaa-thread {
        flex: 1 1 auto; min-height: 0; overflow: auto;
        padding: 0.9rem; display: flex; flex-direction: column; gap: 0.65rem;
      }
      .oaa-msg { display: flex; }
      .oaa-user { justify-content: flex-end; }
      .oaa-assistant, .oaa-system { justify-content: flex-start; }
      .oaa-bubble {
        max-width: 88%; border: 1px solid #dfe5ee; border-radius: 8px;
        padding: 0.65rem 0.75rem; background: #fff; color: #1f2733;
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
      }
      .oaa-user .oaa-bubble { background: #1f6feb; color: #fff; border-color: #1f6feb; }
      .oaa-system .oaa-bubble { background: #eef2f7; color: #566174; border-color: #dfe5ee; }
      .oaa-content { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.73rem; line-height: 1.55; }
      .oaa-meta { margin-top: 0.35rem; font-size: 0.56rem; color: #7a8496; font-family: monospace; }
      .oaa-user .oaa-meta { color: rgba(255, 255, 255, 0.75); }
      .oaa-sources {
        margin-top: 0.55rem; padding-top: 0.45rem; border-top: 1px solid #e6ebf2;
        display: flex; flex-direction: column; gap: 0.28rem;
      }
      .oaa-sources-title {
        color: #667085; font-size: 0.56rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0;
      }
      .oaa-source {
        display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; gap: 0.45rem;
        color: #3f4a5f; font-size: 0.6rem;
      }
      .oaa-source-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
      .oaa-source-ref {
        max-width: 13rem; overflow: hidden; text-overflow: ellipsis;
        color: #718096; font-family: monospace; white-space: nowrap;
      }
      .oaa-actions-list { gap: 0.38rem; }
      .oaa-action-card {
        display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.45rem; align-items: center;
        border: 1px solid #dde5ef; border-radius: 6px; background: #fbfcff; padding: 0.45rem 0.5rem;
      }
      .oaa-action-card > div { min-width: 0; display: grid; gap: 0.1rem; }
      .oaa-use-action {
        border: 1px solid #c9d4e4; background: #fff; color: #1f2733; border-radius: 4px;
        height: 1.55rem; padding: 0 0.5rem; font-size: 0.6rem; cursor: pointer;
      }
      .oaa-use-action:hover { border-color: #1f6feb; color: #1f6feb; }
      .oaa-thinking { display: inline-flex; gap: 0.22rem; align-items: center; min-width: 48px; min-height: 31px; }
      .oaa-thinking span {
        width: 6px; height: 6px; border-radius: 50%; background: #6b7280;
        animation: oaaPulse 1s infinite ease-in-out;
      }
      .oaa-thinking span:nth-child(2) { animation-delay: 0.15s; }
      .oaa-thinking span:nth-child(3) { animation-delay: 0.3s; }
      @keyframes oaaPulse { 0%, 80%, 100% { opacity: 0.35; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }
      .oaa-error {
        margin: 0 0.9rem 0.6rem; padding: 0.5rem 0.6rem;
        border: 1px solid #f0b4b4; background: #fff1f1; color: #9b1c1c;
        border-radius: 6px; font-size: 0.68rem;
      }
      .oaa-compose {
        flex: 0 0 auto; display: grid; grid-template-columns: 1fr auto; gap: 0.55rem;
        padding: 0.75rem; border-top: 1px solid #e2e6ef; background: #fff;
      }
      .oaa-compose textarea {
        width: 100%; min-height: 4.25rem; max-height: 9rem; resize: none;
        border: 1px solid #ccd4df; border-radius: 6px; padding: 0.6rem 0.65rem;
        font-size: 0.74rem; line-height: 1.45; color: #1f2733; background: #fff;
      }
      .oaa-compose textarea:focus { outline: 2px solid rgba(31, 111, 235, 0.2); border-color: #1f6feb; }
      .oaa-send {
        align-self: end; display: inline-flex; align-items: center; justify-content: center;
        width: 38px; height: 38px; border: 0; border-radius: 6px;
        background: #1f6feb; color: #fff; cursor: pointer;
      }
      .oaa-send:disabled { background: #c9d2df; cursor: not-allowed; }
    `,
  ],
})
export class OsOaaAgent implements OnDestroy {
  private auth = inject(AuthService);
  // sessionStorage only — chat transcripts are not persisted beyond the current browser tab.
  private readonly storageKey = 'opensphere.oaa.sessions';
  readonly iconSend = Send16;
  readonly iconClose = Close16;
  readonly iconReset = Restart16;
  readonly iconMaximize = Maximize16;
  readonly iconEdit = Edit16;
  readonly iconHistory = Time16;
  readonly iconMore = OverflowMenuVertical16;
  readonly iconTrash = TrashCan16;
  readonly iconCopy = Copy16;
  readonly open = signal(false);
  readonly full = signal(false);
  readonly historyOpen = signal(false);
  readonly menuOpen = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly sessions = signal<OaaSession[]>(this.readSessions());
  readonly currentId = signal(this.makeId());
  readonly chatTitle = signal('New chat');
  readonly messages = signal<OaaMessage[]>(this.initialMessages());
  readonly dockWidth = signal(this.initialDockWidth());
  draft = '';
  readonly modelLabel = computed(() => {
    const last = [...this.messages()].reverse().find((m) => m.role === 'assistant' && m.meta);
    return last?.meta || 'deepseek-v4-flash';
  });

  constructor() {
    window.addEventListener('resize', this.onWindowResize);
    effect(() => {
      document.body.classList.toggle('oaa-agent-open', this.open());
      document.body.classList.toggle('oaa-agent-full', this.open() && this.full());
      document.documentElement.classList.toggle('oaa-agent-open', this.open());
      document.documentElement.classList.toggle('oaa-agent-full', this.open() && this.full());
      document.body.style.setProperty('--oaa-dock-width', `${this.dockWidth()}px`);
      this.syncFullLeft();
    });
  }

  ngOnDestroy(): void {
    window.removeEventListener('resize', this.onWindowResize);
    document.body.classList.remove('oaa-agent-open', 'oaa-agent-full', 'oaa-agent-resizing');
    document.documentElement.classList.remove('oaa-agent-open', 'oaa-agent-full');
    document.body.style.removeProperty('--oaa-dock-width');
    document.body.style.removeProperty('--oaa-full-left');
  }

  toggle(): void {
    this.open.update((v) => !v);
  }

  close(): void {
    this.saveCurrentSession();
    this.open.set(false);
    this.menuOpen.set(false);
    this.historyOpen.set(false);
  }

  toggleFull(): void {
    this.full.update((v) => !v);
    this.syncFullLeft();
  }

  startResize(ev: PointerEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    if (this.full()) this.full.set(false);
    const move = (next: PointerEvent) => {
      const width = this.clampDockWidth(window.innerWidth - next.clientX);
      this.dockWidth.set(width);
      document.body.style.setProperty('--oaa-dock-width', `${width}px`);
    };
    const up = () => {
      document.body.classList.remove('oaa-agent-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.localStorage.setItem('opensphere.oaa.dockWidth', String(this.dockWidth()));
    };
    document.body.classList.add('oaa-agent-resizing');
    move(ev);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }

  resetDockWidth(): void {
    const width = this.clampDockWidth(390);
    this.full.set(false);
    this.dockWidth.set(width);
    document.body.style.setProperty('--oaa-dock-width', `${width}px`);
    window.localStorage.setItem('opensphere.oaa.dockWidth', String(width));
  }

  newChat(): void {
    this.saveCurrentSession();
    this.error.set('');
    this.menuOpen.set(false);
    this.historyOpen.set(false);
    this.currentId.set(this.makeId());
    this.chatTitle.set('New chat');
    this.messages.set(this.initialMessages());
    this.draft = '';
  }

  reset(): void {
    this.newChat();
  }

  editTitle(): void {
    const next = window.prompt('Chat title', this.chatTitle());
    if (next == null) return;
    const title = next.trim() || 'New chat';
    this.chatTitle.set(title);
    this.saveCurrentSession();
  }

  toggleHistory(): void {
    this.saveCurrentSession();
    this.menuOpen.set(false);
    this.historyOpen.update((v) => !v);
  }

  loadSession(s: OaaSession): void {
    this.currentId.set(s.id);
    this.chatTitle.set(s.title);
    this.messages.set(s.messages?.length ? s.messages : this.initialMessages());
    this.historyOpen.set(false);
    this.error.set('');
  }

  clearHistory(): void {
    this.sessions.set([]);
    this.writeSessions([]);
    this.menuOpen.set(false);
  }

  async copyTranscript(): Promise<void> {
    const text = this.messages()
      .filter((m) => m.role !== 'system')
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(text || '');
      this.error.set('');
    } catch (e) {
      this.error.set('Transcript copy failed: ' + e);
    } finally {
      this.menuOpen.set(false);
    }
  }

  onKeydown(ev: KeyboardEvent): void {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      void this.send();
    }
  }

  /** 유일한 네트워크 호출 지점 — 동일 출처 /api/oaa/chat, AuthService의 id_token을 Bearer로 첨부.
   *  API 키는 여기서 절대 다루지 않는다(게이트웨이가 서버측에서 보관·주입). */
  async send(ev?: Event): Promise<void> {
    ev?.preventDefault();
    const text = this.draft.trim();
    if (!text || this.busy()) return;
    this.error.set('');
    this.draft = '';
    if (this.chatTitle() === 'New chat') this.chatTitle.set(text.slice(0, 48));
    const next = [...this.messages(), { id: 'u-' + Date.now(), role: 'user' as const, content: text }];
    this.messages.set(next);
    this.saveCurrentSession();
    this.busy.set(true);
    try {
      const payloadMessages = next
        .filter((m) => m.role !== 'system')
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content }));
      const r = await fetch('/api/oaa/chat', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + (this.auth.token() || ''), 'content-type': 'application/json' },
        body: JSON.stringify({ keyId: 'deepseek', messages: payloadMessages, context: this.pageContext() }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        // Degraded/unavailable(provider·key 미배포 포함)은 채팅 패널 내부 오류 배너로만 표시된다 —
        // 셸이나 Manual 등 다른 네이티브 화면에는 영향이 없다.
        this.error.set(body.error || `OAA request failed (HTTP ${r.status})`);
        return;
      }
      const sourceCount = Array.isArray(body.sources) ? body.sources.length : 0;
      const conceptCount = Array.isArray(body.concepts?.concepts) ? body.concepts.concepts.length : 0;
      const actionCount = Array.isArray(body.suggestedActions) ? body.suggestedActions.length : 0;
      const envCount = Array.isArray(body.environment?.namespaces) ? body.environment.namespaces.length : 0;
      const meta = `${body.provider || 'llm'} / ${body.model || ''} / ${body.latencyMs || 0}ms${sourceCount ? ` / sources ${sourceCount}` : ''}${conceptCount ? ` / concepts ${conceptCount}` : ''}${actionCount ? ` / actions ${actionCount}` : ''}${envCount ? ` / env ${envCount}` : ''}`;
      this.messages.update((items) => [...items, {
        id: 'a-' + Date.now(),
        role: 'assistant',
        content: body.message || '(empty response)',
        meta,
        sources: this.normalizeSources(body.sources),
        concepts: this.normalizeConcepts(body.concepts?.concepts),
        actions: this.normalizeSuggestedActions(body.suggestedActions),
      }]);
      this.saveCurrentSession();
    } catch (e) {
      this.error.set('OAA request failed: ' + e);
    } finally {
      this.busy.set(false);
    }
  }

  /** 제안 행동은 명령을 입력창에 채우기만 한다 — 여기서 직접 실행/변형하지 않는다(비-read 실행은
   *  서버 게이트웨이의 확인/감사 절차를 거쳐야 함). */
  useSuggestedAction(action: OaaSuggestedAction): void {
    this.draft = action.command || `/action ${action.id}`;
    this.error.set('');
  }

  relativeTime(value: string): string {
    const ms = Date.now() - new Date(value).getTime();
    if (!Number.isFinite(ms)) return '';
    const min = Math.max(0, Math.floor(ms / 60000));
    if (min < 1) return 'now';
    if (min < 60) return `${min}m`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  }

  private initialMessages(): OaaMessage[] {
    return [{ id: 'welcome-' + Date.now(), role: 'system', content: 'OAA ready.', meta: 'deepseek-v4-flash' }];
  }

  private pageContext(): Record<string, string> {
    const selection = window.getSelection?.()?.toString() || '';
    return {
      path: `${window.location.pathname || '/'}${window.location.search || ''}`,
      hash: window.location.hash || '',
      title: document.title || '',
      selectedText: selection.slice(0, 500),
    };
  }

  sourceTrack(s: OaaSource): string {
    return `${s.sourceType}/${s.sourceId}/${s.chunkIndex}`;
  }

  sourceLabel(s: OaaSource): string {
    const tier = s.authorityTier == null ? '' : ` T${s.authorityTier}`;
    const score = typeof s.score === 'number' ? ` ${s.score.toFixed(2)}` : '';
    return `${s.sourceType}/${s.sourceId}#${s.chunkIndex}${tier}${score}`.trim();
  }

  private normalizeSources(value: unknown): OaaSource[] {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 6).map((raw: any) => ({
      title: String(raw?.title || raw?.sourceId || 'Source'),
      sourceType: String(raw?.sourceType || ''),
      sourceId: String(raw?.sourceId || ''),
      chunkIndex: Number(raw?.chunkIndex || 0),
      score: Number.isFinite(Number(raw?.score)) ? Number(raw.score) : undefined,
      authorityTier: raw?.authorityTier == null ? null : Number(raw.authorityTier),
      documentType: raw?.documentType ? String(raw.documentType) : '',
      sectionHeading: raw?.sectionHeading ? String(raw.sectionHeading) : '',
      route: raw?.route ? String(raw.route) : '',
      sourcePath: raw?.sourcePath ? String(raw.sourcePath) : '',
      sourceUrl: raw?.sourceUrl ? String(raw.sourceUrl) : '',
      sourceName: raw?.sourceName ? String(raw.sourceName) : '',
    })).filter((s) => s.sourceId);
  }

  private normalizeConcepts(value: unknown): OaaConcept[] {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 8).map((raw: any) => ({
      id: String(raw?.id || ''),
      type: String(raw?.type || 'concept'),
      name: String(raw?.name || raw?.id || 'Concept'),
      summary: raw?.summary ? String(raw.summary) : '',
      authorityTier: raw?.authorityTier == null ? null : Number(raw.authorityTier),
      sourceIds: Array.isArray(raw?.sourceIds) ? raw.sourceIds.map((x: unknown) => String(x)).slice(0, 6) : [],
    })).filter((c) => c.id);
  }

  private normalizeSuggestedActions(value: unknown): OaaSuggestedAction[] {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 4).map((raw: any) => ({
      id: String(raw?.id || ''),
      title: String(raw?.title || raw?.id || 'Action'),
      intent: String(raw?.intent || ''),
      toolId: String(raw?.toolId || ''),
      riskLevel: String(raw?.riskLevel || 'read'),
      confirmation: String(raw?.confirmation || 'none'),
      command: String(raw?.command || ''),
    })).filter((a) => a.id && a.command);
  }

  private saveCurrentSession(): void {
    if (this.messages().filter((m) => m.role !== 'system').length === 0) return;
    const item: OaaSession = {
      id: this.currentId(),
      title: this.chatTitle(),
      messages: this.messages(),
      updatedAt: new Date().toISOString(),
    };
    const next = [item, ...this.sessions().filter((s) => s.id !== item.id)].slice(0, 20);
    this.sessions.set(next);
    this.writeSessions(next);
  }

  /** Chat history lives only in sessionStorage — current tab, cleared on tab close. Never localStorage. */
  private readSessions(): OaaSession[] {
    try {
      const raw = window.sessionStorage.getItem(this.storageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.slice(0, 20) : [];
    } catch {
      return [];
    }
  }

  private writeSessions(items: OaaSession[]): void {
    try {
      window.sessionStorage.setItem(this.storageKey, JSON.stringify(items));
    } catch {
      /* ignore */
    }
  }

  private makeId(): string {
    return 'oaa-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  private readonly onWindowResize = (): void => {
    const width = this.clampDockWidth(this.dockWidth());
    if (width !== this.dockWidth()) this.dockWidth.set(width);
    document.body.style.setProperty('--oaa-dock-width', `${width}px`);
    this.syncFullLeft();
  };

  private initialDockWidth(): number {
    const raw = Number(window.localStorage.getItem('opensphere.oaa.dockWidth'));
    return this.clampDockWidth(Number.isFinite(raw) && raw > 0 ? raw : 390);
  }

  private clampDockWidth(value: number): number {
    const left = document.querySelector('.content-container')?.getBoundingClientRect().left ?? 0;
    const min = Math.min(360, Math.max(320, window.innerWidth - left - 80));
    const max = Math.max(min, Math.min(960, window.innerWidth - left - 80));
    return Math.round(Math.max(min, Math.min(max, value)));
  }

  private syncFullLeft(): void {
    const contentLeft = document.querySelector('.content-area')?.getBoundingClientRect().left ?? 0;
    document.body.style.setProperty('--oaa-full-left', `${Math.max(0, Math.round(contentLeft))}px`);
  }
}
