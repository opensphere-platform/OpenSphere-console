import { Component, ChangeDetectionStrategy, OnDestroy, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ClarityModule } from '@clr/angular';
import { CarbonIcon } from './carbon-icon';
import { OsaaMessageContent } from './osaa-message-content';
import { HttpRequestTimeoutError, HttpService } from '../core/http.service';
import Send16 from '@carbon/icons/es/send/16';
import Close16 from '@carbon/icons/es/close/16';
import Restart16 from '@carbon/icons/es/restart/16';
import Maximize16 from '@carbon/icons/es/maximize/16';
import Edit16 from '@carbon/icons/es/edit/16';
import Time16 from '@carbon/icons/es/time/16';
import OverflowMenuVertical16 from '@carbon/icons/es/overflow-menu--vertical/16';
import TrashCan16 from '@carbon/icons/es/trash-can/16';
import Copy16 from '@carbon/icons/es/copy/16';
import Add16 from '@carbon/icons/es/add/16';
import WarningAlt16 from '@carbon/icons/es/warning--alt/16';
import Microphone16 from '@carbon/icons/es/microphone/16';
import ChevronDown16 from '@carbon/icons/es/chevron--down/16';
import Model16 from '@carbon/icons/es/model/16';
import StopFilled16 from '@carbon/icons/es/stop--filled/16';

type OsaaRole = 'user' | 'assistant' | 'system';
interface OsaaSource {
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
interface OsaaConcept {
  id: string;
  type: string;
  name: string;
  summary?: string;
  authorityTier?: number | null;
  sourceIds?: string[];
}
interface OsaaSuggestedAction {
  id: string;
  title: string;
  intent: string;
  toolId: string;
  riskLevel: string;
  confirmation: string;
  command: string;
}
interface OsaaUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  source: 'provider' | 'unavailable';
  recorded: boolean;
}
interface OsaaMessage {
  id: string;
  role: OsaaRole;
  content: string;
  meta?: string;
  sources?: OsaaSource[];
  concepts?: OsaaConcept[];
  actions?: OsaaSuggestedAction[];
  usage?: OsaaUsage;
}
interface OsaaSession {
  id: string;
  title: string;
  status: 'active' | 'archived';
  modelId: string;
  preview: string;
  updatedAt: string;
}

const R2D2_CHAT_TIMEOUT_MS = 120000;

/**
 * os-osaa-agent — Console-native global OSAA(OpenSphere AI Agent) 우측 도크 패널.
 * 헤더에서 토글되는 셸 소유 컴포넌트다(route/plugin/subShell/Registry 항목이 아님).
 * 안전 렌더링만 사용(텍스트 바인딩, innerHTML 없음) — 답변·출처·개념 메타데이터는 항상 문자열로 표시한다.
 * 동일 출처 `/api/osaa/chat`만 HttpService로 호출하며, 인증은 Console Backend의 불투명
 * HttpOnly 세션과 CSRF 정책을 따른다. 브라우저 JavaScript가 bearer token을 직접 조립하지 않는다.
 * API 키는 이 컴포넌트에 저장·표시되지 않는다(키 관리는 /manage 백본 관리 화면의 서버측 책임).
 * 제안 행동(suggestedActions)은 입력창에 명령을 채워 넣을 뿐 — Kubernetes를 직접 변경하는 우회 경로가 아니다.
 * 실제 비-read 실행은 게이트웨이(서버) 단계에서 확인/감사 후에만 이루어지며, Cluster Manager Activated +
 * HIS Preflight Ready 이전에는 서버가 모든 Kubernetes mutation/action tool을 제공하지 않는다
 * (CONSTITUTION-0004 §4.2, fail-closed — 이 컴포넌트는 UI 제안일 뿐 gate를 대체하지 않는다).
 * Provider/키 미배포 시에도 폭이 셸을 깨지 않고 이 패널 안에서 오류 메시지로 성능 저하(Degraded)를 표시한다.
 *
 * 저장소 경계: 대화와 메시지는 OSAA Gateway가 인증된 사용자 소유 데이터로 PostgreSQL에 저장한다.
 * 브라우저는 서버 대화 ID와 현재 화면 상태만 보유하며 메시지를 sessionStorage/localStorage에 복제하지 않는다.
 * dock width 같은 비민감 UI preference(패널 폭)만 `localStorage`에 저장한다.
 */
@Component({
  selector: 'os-osaa-agent',
  imports: [FormsModule, ClarityModule, CarbonIcon, OsaaMessageContent],
  template: `
    <button class="osaa-trigger" [class.osaa-active]="open()" (click)="toggle()" title="R2D2" aria-label="R2D2">
      <span class="osaa-agent-mark" aria-hidden="true">
        <span class="osaa-agent-spark"></span>
        <span class="osaa-agent-smile"></span>
      </span>
    </button>

    @if (open()) {
      <aside class="osaa-panel" [class.osaa-full]="full()" role="dialog" aria-label="R2D2">
        <div class="osaa-resizer" (pointerdown)="startResize($event)" (dblclick)="resetDockWidth()" title="Drag to resize chat. Double-click to reset." aria-hidden="true"></div>
        <header class="osaa-head">
          <div class="osaa-head-left">
            <button class="osaa-iconbtn" (click)="toggleFull()" [title]="full() ? 'Restore dock' : 'Expand to workspace'" [attr.aria-label]="full() ? 'Restore dock' : 'Expand to workspace'">
              <os-cicon [icon]="iconMaximize" [size]="16" />
            </button>
            <button class="osaa-new" (click)="newChat()" title="New chat">New chat</button>
          </div>
          <div class="osaa-tools">
            <button class="osaa-iconbtn" (click)="editTitle()" title="Edit chat title" aria-label="Edit chat title"><os-cicon [icon]="iconEdit" [size]="16" /></button>
            <button class="osaa-iconbtn" [class.osaa-selected]="historyOpen()" (click)="toggleHistory()" title="Chat history" aria-label="Chat history"><os-cicon [icon]="iconHistory" [size]="16" /></button>
            <button class="osaa-iconbtn" [class.osaa-selected]="menuOpen()" (click)="menuOpen.set(!menuOpen())" title="More" aria-label="More"><os-cicon [icon]="iconMore" [size]="16" /></button>
            <button class="osaa-iconbtn" (click)="close()" title="Close" aria-label="Close"><os-cicon [icon]="iconClose" [size]="16" /></button>

            @if (menuOpen()) {
              <div class="osaa-menu" role="menu">
                <button type="button" (click)="copyTranscript()"><os-cicon [icon]="iconCopy" [size]="16" /> Copy transcript</button>
                <button type="button" (click)="clearHistory()"><os-cicon [icon]="iconTrash" [size]="16" /> Clear history</button>
              </div>
            }
          </div>
        </header>

        <div class="osaa-chat-title">
          <span>{{ chatTitle() }}</span>
          <span>{{ modelLabel() }}</span>
        </div>

        @if (historyOpen()) {
          <div class="osaa-history">
            <div class="osaa-history-head">Recent chats <span>{{ sessions().length }}</span></div>
            @for (s of sessions(); track s.id) {
              <button type="button" class="osaa-history-item" (click)="loadSession(s)">
                <span>{{ s.title }}</span>
                <small>{{ relativeTime(s.updatedAt) }}</small>
              </button>
            } @empty {
              <div class="osaa-history-empty">No saved chats</div>
            }
          </div>
        }

        <div class="osaa-thread">
          @for (m of messages(); track m.id) {
            <div class="osaa-msg" [class.osaa-user]="m.role === 'user'" [class.osaa-assistant]="m.role === 'assistant'" [class.osaa-system]="m.role === 'system'">
              <div class="osaa-bubble">
                <div class="osaa-content">
                  @if (m.role === 'assistant') {
                    <os-osaa-message-content [content]="m.content" />
                  } @else {
                    {{ m.content }}
                  }
                </div>
                @if (m.meta) { <div class="osaa-meta">{{ m.meta }}</div> }
                @if (m.usage; as usage) {
                  <div class="osaa-token-usage" aria-label="LLM 토큰 사용량">
                    <span>입력 {{ formatTokenCount(usage.inputTokens) }}</span>
                    <span>출력 {{ formatTokenCount(usage.outputTokens) }}</span>
                    @if (usage.cachedInputTokens) { <span>캐시 {{ formatTokenCount(usage.cachedInputTokens) }}</span> }
                    @if (usage.reasoningTokens) { <span>추론 {{ formatTokenCount(usage.reasoningTokens) }}</span> }
                    <strong>총 {{ formatTokenCount(usage.totalTokens) }} tokens</strong>
                    <span [class.osaa-usage-pending]="!usage.recorded">{{ usage.recorded ? 'Supabase 기록됨' : '원장 기록 지연' }}</span>
                  </div>
                }
                @if (m.sources?.length) {
                  <div class="osaa-sources" aria-label="R2D2 answer sources">
                    <div class="osaa-sources-title">Sources</div>
                    @for (s of m.sources || []; track sourceTrack(s)) {
                      <div class="osaa-source">
                        <span class="osaa-source-title" [title]="s.sourcePath || s.sourceUrl || s.sourceId">{{ s.title }}</span>
                        <span class="osaa-source-ref" [title]="s.sourcePath || s.sourceUrl || sourceLabel(s)">{{ sourceLabel(s) }}</span>
                      </div>
                    }
                  </div>
                }
                @if (m.concepts?.length) {
                  <div class="osaa-sources" aria-label="R2D2 concept graph">
                    <div class="osaa-sources-title">Concepts</div>
                    @for (c of m.concepts || []; track c.id) {
                      <div class="osaa-source">
                        <span class="osaa-source-title" [title]="c.summary || c.id">{{ c.name }}</span>
                        <span class="osaa-source-ref" [title]="c.id">{{ c.type }}{{ c.authorityTier == null ? '' : ' T' + c.authorityTier }}</span>
                      </div>
                    }
                  </div>
                }
                @if (m.actions?.length) {
                  <div class="osaa-sources osaa-actions-list" aria-label="R2D2 suggested actions">
                    <div class="osaa-sources-title">Suggested Actions</div>
                    @for (a of m.actions || []; track a.id) {
                      <div class="osaa-action-card">
                        <div>
                          <span class="osaa-source-title" [title]="a.id">{{ a.title }}</span>
                          <span class="osaa-source-ref" [title]="a.toolId">{{ a.intent }} / {{ a.riskLevel }} / {{ a.confirmation }}</span>
                        </div>
                        <button type="button" class="osaa-use-action" (click)="useSuggestedAction(a)">Use</button>
                      </div>
                    }
                  </div>
                }
              </div>
            </div>
          }
          @if (busy()) {
            <div class="osaa-msg osaa-assistant"><div class="osaa-bubble osaa-thinking"><span></span><span></span><span></span></div></div>
          }
        </div>

        @if (error()) {
          <div class="osaa-error">{{ error() }}</div>
        }

        <form class="osaa-compose" (submit)="send($event)">
          <textarea
            name="osaaPrompt"
            [(ngModel)]="draft"
            [disabled]="busy()"
            placeholder="무엇이든 요청하세요"
            rows="3"
            (keydown)="onKeydown($event)"
            aria-label="R2D2 메시지"
          ></textarea>
          <div class="osaa-compose-bar">
            <div class="osaa-compose-left">
              <button class="osaa-compose-tool" type="button" (click)="includeEnvironment.set(!includeEnvironment())" title="환경 컨텍스트 전환" aria-label="환경 컨텍스트 전환">
                <os-cicon [icon]="iconAdd" [size]="18" />
              </button>
              <button class="osaa-context-chip" type="button" [class.osaa-context-on]="includeEnvironment()" (click)="includeEnvironment.set(!includeEnvironment())" [attr.aria-pressed]="includeEnvironment()">
                <os-cicon [icon]="iconWarning" [size]="14" />
                {{ includeEnvironment() ? '환경 컨텍스트' : '페이지 컨텍스트' }}
              </button>
            </div>
            <div class="osaa-compose-right">
              <span class="osaa-model-chip" [title]="modelLabel()">
                <os-cicon [icon]="iconModel" [size]="14" />
                {{ displayModel() }}
                <os-cicon [icon]="iconChevronDown" [size]="14" />
              </span>
              <button class="osaa-compose-tool" type="button" [class.osaa-listening]="listening()" (click)="toggleVoiceInput()" title="음성 입력" aria-label="음성 입력">
                <os-cicon [icon]="iconMicrophone" [size]="17" />
              </button>
              @if (busy()) {
                <button class="osaa-send osaa-stop" type="button" (click)="stopGeneration()" title="응답 중지" aria-label="응답 중지">
                  <os-cicon [icon]="iconStop" [size]="15" />
                </button>
              } @else {
                <button class="osaa-send" type="submit" [disabled]="!draft.trim()" title="전송 (Enter)" aria-label="전송">
                  <os-cicon [icon]="iconSend" [size]="17" />
                </button>
              }
            </div>
          </div>
        </form>
      </aside>
    }

    <clr-modal
      [clrModalOpen]="renameOpen()"
      (clrModalOpenChange)="onRenameOpenChange($event)"
      [clrModalClosable]="true"
      [clrModalSize]="'sm'"
    >
      <h3 class="modal-title">채팅 제목 변경</h3>
      <div class="modal-body">
        <clr-input-container>
          <label for="osaa-chat-title-input">채팅 제목</label>
          <input
            clrInput
            id="osaa-chat-title-input"
            name="osaa-chat-title"
            [(ngModel)]="renameDraft"
            maxlength="80"
            required
            (keydown.enter)="applyTitle()"
          />
          <clr-control-helper>현재 탭의 대화 기록에 표시할 제목입니다.</clr-control-helper>
        </clr-input-container>
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-outline" (click)="cancelTitleEdit()">취소</button>
        <button type="button" class="btn btn-primary" (click)="applyTitle()" [disabled]="!renameDraft.trim()">저장</button>
      </div>
    </clr-modal>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .osaa-trigger {
        display: inline-flex; align-items: center; justify-content: center;
        width: 36px; height: 36px; margin-right: 0.3rem;
        border: 0; border-radius: 4px; background: transparent; color: #c7d0e8;
        cursor: pointer;
      }
      .osaa-trigger:hover, .osaa-trigger.osaa-active { background: rgba(255, 255, 255, 0.1); color: #fff; }
      .osaa-agent-mark {
        position: relative; display: inline-flex; align-items: center; justify-content: center;
        width: 24px; height: 24px;
      }
      .osaa-agent-spark {
        position: absolute; top: 0; left: 8px; z-index: 1;
        width: 12px; height: 12px; transform: rotate(45deg);
        background: linear-gradient(135deg, #3b82f6, #9b5cff 52%, #ff4f8b);
        clip-path: polygon(50% 0, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0 50%, 38% 38%);
      }
      .osaa-agent-smile {
        position: absolute; left: 3px; bottom: 2px; width: 18px; height: 10px;
        border-bottom: 4px solid #6d5dfc; border-left: 4px solid #5f7cff;
        border-right: 4px solid #ff5c8a; border-top: 0;
        border-radius: 0 0 16px 16px; transform: rotate(1deg);
      }
      .osaa-agent-smile::after {
        content: ''; position: absolute; right: -6px; bottom: -6px;
        width: 8px; height: 3px; border-radius: 999px; background: #ff4f62;
      }
      .osaa-panel {
        position: fixed; top: 3rem; right: 0; bottom: 0; z-index: var(--os-z-osaa, 1000);
        width: var(--osaa-dock-width, 390px); display: flex; flex-direction: column;
        height: calc(100dvh - 3rem); max-height: calc(100dvh - 3rem);
        background: #f7f8fb; border-left: 1px solid #d9dde7;
        border-top-left-radius: 8px; overflow: hidden;
      }
      .osaa-panel.osaa-full {
        left: var(--osaa-full-left, 0px); width: auto; border-top-left-radius: 0;
      }
      .osaa-resizer {
        position: absolute; top: 0; bottom: 0; left: 0; z-index: 3;
        width: 12px; cursor: ew-resize; touch-action: none;
      }
      .osaa-resizer::after {
        content: ''; position: absolute; top: 0; bottom: 0; left: 0;
        width: 2px; background: #d9dde7; transition: background 120ms ease, box-shadow 120ms ease;
      }
      .osaa-resizer:hover::after, :host-context(body.osaa-agent-resizing) .osaa-resizer::after {
        background: #1f6feb; box-shadow: 0 0 0 2px rgba(31, 111, 235, 0.14);
      }
      .osaa-panel.osaa-full .osaa-resizer::after {
        background: transparent;
      }
      .osaa-head {
        flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
        height: 2.45rem; padding: 0 0.45rem; border-bottom: 1px solid #e5e7eb; background: #fff;
      }
      .osaa-head-left, .osaa-tools { display: flex; align-items: center; gap: 0.25rem; }
      .osaa-tools { position: relative; }
      .osaa-new {
        height: 1.75rem; padding: 0 0.65rem; border: 1px solid #e1e5ec; border-radius: 8px;
        background: #fff; color: #1f2733; cursor: pointer; font-size: 0.72rem;
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
      }
      .osaa-new:hover { background: #f7f8fb; }
      .osaa-iconbtn {
        display: inline-flex; align-items: center; justify-content: center;
        width: 28px; height: 28px; border: 1px solid transparent; border-radius: 4px;
        background: transparent; color: #586174; cursor: pointer;
      }
      .osaa-iconbtn:hover, .osaa-iconbtn.osaa-selected { background: #eef2f7; color: #1f2733; border-color: #dce2eb; }
      .osaa-menu {
        position: absolute; top: 2rem; right: 1.8rem; z-index: 2;
        min-width: 10rem; padding: 0.3rem; border: 1px solid #dce2eb; border-radius: 6px;
        background: #fff; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.18);
      }
      .osaa-menu button {
        width: 100%; display: flex; align-items: center; gap: 0.45rem;
        border: 0; background: transparent; color: #1f2733; cursor: pointer;
        padding: 0.45rem 0.5rem; border-radius: 4px; text-align: left; font-size: 0.68rem;
      }
      .osaa-menu button:hover { background: #f2f5fa; }
      .osaa-chat-title {
        flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
        gap: 0.7rem; min-height: 2rem; padding: 0.4rem 0.8rem;
        border-bottom: 1px solid #e5e7eb; background: #fff; color: #1f2733;
      }
      .osaa-chat-title span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.76rem; font-weight: 600; }
      .osaa-chat-title span:last-child { flex: 0 0 auto; color: #6b7280; font-family: monospace; font-size: 0.56rem; }
      .osaa-history {
        flex: 0 0 auto; max-height: 13rem; overflow: auto;
        border-bottom: 1px solid #e5e7eb; background: #fff;
      }
      .osaa-history-head {
        display: flex; justify-content: space-between; padding: 0.55rem 0.8rem 0.35rem;
        color: #6b7280; font-size: 0.62rem; text-transform: uppercase;
      }
      .osaa-history-item {
        width: 100%; display: grid; grid-template-columns: 1fr auto; gap: 0.7rem;
        border: 0; background: transparent; padding: 0.5rem 0.8rem; cursor: pointer; text-align: left;
      }
      .osaa-history-item:hover { background: #f2f5fa; }
      .osaa-history-item span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #1f2733; font-size: 0.7rem; }
      .osaa-history-item small { color: #7a8496; font-size: 0.58rem; }
      .osaa-history-empty { padding: 0.8rem; color: #7a8496; font-size: 0.68rem; }
      .osaa-thread {
        flex: 1 1 auto; min-height: 0; overflow: auto;
        padding: 0.9rem; display: flex; flex-direction: column; gap: 0.65rem;
      }
      .osaa-msg { display: flex; }
      .osaa-user { justify-content: flex-end; }
      .osaa-assistant, .osaa-system { justify-content: flex-start; }
      .osaa-bubble {
        max-width: 88%; border: 1px solid #dfe5ee; border-radius: 8px;
        padding: 0.65rem 0.75rem; background: #fff; color: #1f2733;
        box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
      }
      .osaa-user .osaa-bubble { background: #1f6feb; color: #fff; border-color: #1f6feb; }
      .osaa-system .osaa-bubble { background: #eef2f7; color: #566174; border-color: #dfe5ee; }
      .osaa-content { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.73rem; line-height: 1.55; }
      .osaa-meta { margin-top: 0.35rem; font-size: 0.56rem; color: #7a8496; font-family: monospace; }
      .osaa-user .osaa-meta { color: rgba(255, 255, 255, 0.75); }
      .osaa-sources {
        margin-top: 0.55rem; padding-top: 0.45rem; border-top: 1px solid #e6ebf2;
        display: flex; flex-direction: column; gap: 0.28rem;
      }
      .osaa-sources-title {
        color: #667085; font-size: 0.56rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0;
      }
      .osaa-source {
        display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; gap: 0.45rem;
        color: #3f4a5f; font-size: 0.6rem;
      }
      .osaa-source-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
      .osaa-source-ref {
        max-width: 13rem; overflow: hidden; text-overflow: ellipsis;
        color: #718096; font-family: monospace; white-space: nowrap;
      }
      .osaa-actions-list { gap: 0.38rem; }
      .osaa-action-card {
        display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.45rem; align-items: center;
        border: 1px solid #dde5ef; border-radius: 6px; background: #fbfcff; padding: 0.45rem 0.5rem;
      }
      .osaa-action-card > div { min-width: 0; display: grid; gap: 0.1rem; }
      .osaa-use-action {
        border: 1px solid #c9d4e4; background: #fff; color: #1f2733; border-radius: 4px;
        height: 1.55rem; padding: 0 0.5rem; font-size: 0.6rem; cursor: pointer;
      }
      .osaa-use-action:hover { border-color: #1f6feb; color: #1f6feb; }
      .osaa-thinking { display: inline-flex; gap: 0.22rem; align-items: center; min-width: 48px; min-height: 31px; }
      .osaa-thinking span {
        width: 6px; height: 6px; border-radius: 50%; background: #6b7280;
        animation: osaaPulse 1s infinite ease-in-out;
      }
      .osaa-thinking span:nth-child(2) { animation-delay: 0.15s; }
      .osaa-thinking span:nth-child(3) { animation-delay: 0.3s; }
      @keyframes osaaPulse { 0%, 80%, 100% { opacity: 0.35; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }
      .osaa-error {
        margin: 0 0.9rem 0.6rem; padding: 0.5rem 0.6rem;
        border: 1px solid #f0b4b4; background: #fff1f1; color: #9b1c1c;
        border-radius: 6px; font-size: 0.68rem;
      }
    `,
  ],
})
export class OsOsaaAgent implements OnDestroy {
  private http = inject(HttpService);
  readonly iconSend = Send16;
  readonly iconClose = Close16;
  readonly iconReset = Restart16;
  readonly iconMaximize = Maximize16;
  readonly iconEdit = Edit16;
  readonly iconHistory = Time16;
  readonly iconMore = OverflowMenuVertical16;
  readonly iconTrash = TrashCan16;
  readonly iconCopy = Copy16;
  readonly iconAdd = Add16;
  readonly iconWarning = WarningAlt16;
  readonly iconMicrophone = Microphone16;
  readonly iconChevronDown = ChevronDown16;
  readonly iconModel = Model16;
  readonly iconStop = StopFilled16;
  readonly open = signal(false);
  readonly full = signal(false);
  readonly historyOpen = signal(false);
  readonly menuOpen = signal(false);
  readonly renameOpen = signal(false);
  readonly busy = signal(false);
  readonly listening = signal(false);
  readonly includeEnvironment = signal(true);
  readonly error = signal('');
  readonly sessions = signal<OsaaSession[]>([]);
  readonly currentId = signal('');
  readonly chatTitle = signal('New chat');
  readonly messages = signal<OsaaMessage[]>(this.initialMessages());
  readonly dockWidth = signal(this.initialDockWidth());
  draft = '';
  renameDraft = '';
  readonly modelLabel = computed(() => {
    const last = [...this.messages()].reverse().find((m) => m.role === 'assistant' && m.meta);
    return last?.meta || 'deepseek-v4-flash';
  });
  readonly displayModel = computed(() => {
    const lastProviderTurn = [...this.messages()].reverse().find((message) =>
      message.role === 'assistant' && message.meta && !/^opensphere\s*\/\s*osaa-control-tools\b/i.test(message.meta));
    const meta = lastProviderTurn?.meta || 'deepseek-v4-flash';
    const parts = meta.split('/').map((part) => part.trim()).filter(Boolean);
    return parts.length > 1 ? parts[1] : parts[0] || 'deepseek-v4-flash';
  });
  private activeRequest: AbortController | null = null;
  private speechRecognition: any = null;

  constructor() {
    window.addEventListener('resize', this.onWindowResize);
    effect(() => {
      document.body.classList.toggle('osaa-agent-open', this.open());
      document.body.classList.toggle('osaa-agent-full', this.open() && this.full());
      document.documentElement.classList.toggle('osaa-agent-open', this.open());
      document.documentElement.classList.toggle('osaa-agent-full', this.open() && this.full());
      document.body.style.setProperty('--osaa-dock-width', `${this.dockWidth()}px`);
      this.syncFullLeft();
    });
    void this.refreshHistory(true);
  }

  ngOnDestroy(): void {
    this.activeRequest?.abort();
    this.speechRecognition?.abort?.();
    window.removeEventListener('resize', this.onWindowResize);
    document.body.classList.remove('osaa-agent-open', 'osaa-agent-full', 'osaa-agent-resizing');
    document.documentElement.classList.remove('osaa-agent-open', 'osaa-agent-full');
    document.body.style.removeProperty('--osaa-dock-width');
    document.body.style.removeProperty('--osaa-full-left');
  }

  toggle(): void {
    this.open.update((v) => !v);
    if (this.open()) void this.refreshHistory(false);
  }

  close(): void {
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
      document.body.style.setProperty('--osaa-dock-width', `${width}px`);
    };
    const up = () => {
      document.body.classList.remove('osaa-agent-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.localStorage.setItem('opensphere.osaa.dockWidth', String(this.dockWidth()));
    };
    document.body.classList.add('osaa-agent-resizing');
    move(ev);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }

  resetDockWidth(): void {
    const width = this.clampDockWidth(390);
    this.full.set(false);
    this.dockWidth.set(width);
    document.body.style.setProperty('--osaa-dock-width', `${width}px`);
    window.localStorage.setItem('opensphere.osaa.dockWidth', String(width));
  }

  newChat(): void {
    this.error.set('');
    this.menuOpen.set(false);
    this.historyOpen.set(false);
    this.currentId.set('');
    this.chatTitle.set('New chat');
    this.messages.set(this.initialMessages());
    this.draft = '';
  }

  reset(): void {
    this.newChat();
  }

  editTitle(): void {
    this.renameDraft = this.chatTitle();
    this.renameOpen.set(true);
  }

  onRenameOpenChange(open: boolean): void {
    if (!open && this.renameOpen()) this.cancelTitleEdit();
  }

  cancelTitleEdit(): void {
    this.renameOpen.set(false);
    this.renameDraft = '';
  }

  async applyTitle(): Promise<void> {
    const title = this.renameDraft.trim();
    if (!title) return;
    try {
      if (this.currentId()) {
        const response = await this.http.request(`/api/osaa/conversations/${encodeURIComponent(this.currentId())}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      }
      this.chatTitle.set(title);
      this.renameOpen.set(false);
      this.renameDraft = '';
      await this.refreshHistory(false);
    } catch (error) {
      this.error.set('대화 제목을 저장하지 못했습니다: ' + error);
    }
  }

  toggleHistory(): void {
    this.menuOpen.set(false);
    this.historyOpen.update((v) => !v);
    if (this.historyOpen()) void this.refreshHistory(false);
  }

  async loadSession(s: OsaaSession): Promise<void> {
    try {
      const response = await this.http.request(`/api/osaa/conversations/${encodeURIComponent(s.id)}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      const stored = Array.isArray(body.messages) ? body.messages.map((message: unknown) => this.fromStoredMessage(message)) : [];
      this.currentId.set(String(body.id || s.id));
      this.chatTitle.set(String(body.title || s.title));
      this.messages.set(stored.length ? stored : this.initialMessages());
      this.historyOpen.set(false);
      this.error.set('');
    } catch (error) {
      this.error.set('대화를 불러오지 못했습니다: ' + error);
    }
  }

  async clearHistory(): Promise<void> {
    try {
      for (const conversation of this.sessions()) {
        const response = await this.http.request(`/api/osaa/conversations/${encodeURIComponent(conversation.id)}`, { method: 'DELETE' });
        if (!response.ok && response.status !== 404) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${response.status}`);
        }
      }
      this.sessions.set([]);
      this.newChat();
    } catch (error) {
      this.error.set('대화 기록을 삭제하지 못했습니다: ' + error);
    } finally {
      this.menuOpen.set(false);
    }
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
    if (ev.isComposing || ev.key !== 'Enter' || ev.shiftKey) return;
    ev.preventDefault();
    void this.send();
  }

  toggleVoiceInput(): void {
    if (this.listening()) {
      this.speechRecognition?.stop?.();
      return;
    }
    const Recognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Recognition) {
      this.error.set('이 브라우저는 음성 입력을 지원하지 않습니다.');
      return;
    }
    const recognition = new Recognition();
    recognition.lang = 'ko-KR';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => this.listening.set(true);
    recognition.onend = () => { this.listening.set(false); this.speechRecognition = null; };
    recognition.onerror = () => { this.listening.set(false); this.speechRecognition = null; this.error.set('음성 입력을 시작하지 못했습니다.'); };
    recognition.onresult = (event: any) => {
      const transcript = String(event?.results?.[0]?.[0]?.transcript || '').trim();
      if (transcript) this.draft = `${this.draft}${this.draft ? ' ' : ''}${transcript}`;
    };
    this.speechRecognition = recognition;
    recognition.start();
  }

  stopGeneration(): void {
    this.activeRequest?.abort();
    this.activeRequest = null;
    this.busy.set(false);
  }

  /** 유일한 네트워크 호출 지점 — 동일 출처 /api/osaa/chat을 공통 HttpService로 호출한다.
   *  API 키와 bearer token은 여기서 절대 다루지 않는다(서버측 세션·게이트웨이 경계가 소유). */
  async send(ev?: Event): Promise<void> {
    ev?.preventDefault();
    const text = this.draft.trim();
    if (!text || this.busy()) return;
    this.error.set('');
    this.draft = '';
    if (this.chatTitle() === 'New chat') this.chatTitle.set(text.slice(0, 48));
    const next = [...this.messages(), { id: 'u-' + Date.now(), role: 'user' as const, content: text }];
    this.messages.set(next);
    this.busy.set(true);
    const request = new AbortController();
    this.activeRequest = request;
    try {
      const r = await this.http.request('/api/osaa/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // keyId를 고정하지 않는다. Gateway가 활성 provider inventory에서 정식 ID
        // (예: deepseek-main)를 선택하므로 UI와 Secret 이름이 어긋나지 않는다.
        body: JSON.stringify({
          conversationId: this.currentId() || undefined,
          clientRequestId: crypto.randomUUID(),
          message: text,
          context: this.pageContext(),
          includeEnvironment: this.includeEnvironment(),
          source: 'console-osaa-agent',
        }),
        signal: request.signal,
        timeoutMs: R2D2_CHAT_TIMEOUT_MS,
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        // Degraded/unavailable(provider·key 미배포 포함)은 채팅 패널 내부 오류 배너로만 표시된다 —
        // 셸이나 Manual 등 다른 네이티브 화면에는 영향이 없다.
        this.error.set(body.error || `R2D2 request failed (HTTP ${r.status})`);
        return;
      }
      const sourceCount = Array.isArray(body.sources) ? body.sources.length : 0;
      const conceptCount = Array.isArray(body.concepts?.concepts) ? body.concepts.concepts.length : 0;
      const actionCount = Array.isArray(body.suggestedActions) ? body.suggestedActions.length : 0;
      const envCount = Array.isArray(body.environment?.namespaces) ? body.environment.namespaces.length : 0;
      const meta = `${body.provider || 'llm'} / ${body.model || ''} / ${body.latencyMs || 0}ms${sourceCount ? ` / sources ${sourceCount}` : ''}${conceptCount ? ` / concepts ${conceptCount}` : ''}${actionCount ? ` / actions ${actionCount}` : ''}${envCount ? ` / env ${envCount}` : ''}`;
      this.currentId.set(String(body.conversationId || this.currentId()));
      this.messages.update((items) => [...items, {
        id: String(body.assistantMessage?.id || 'a-' + Date.now()),
        role: 'assistant',
        content: body.message || '(empty response)',
        meta,
        usage: this.normalizeUsage(body.usage, body.usageRecorded),
        sources: this.normalizeSources(body.sources),
        concepts: this.normalizeConcepts(body.concepts?.concepts),
        actions: this.normalizeSuggestedActions(body.suggestedActions),
      }]);
      await this.refreshHistory(false);
    } catch (e: any) {
      if (e instanceof HttpRequestTimeoutError) {
        this.error.set('R2D2 응답 대기 시간이 초과되었습니다. 질문을 다시 시도하거나 운영 범위를 줄여 주세요.');
      } else if (e?.name !== 'AbortError') {
        this.error.set('R2D2 request failed: ' + e);
      }
    } finally {
      if (this.activeRequest === request) this.activeRequest = null;
      this.busy.set(false);
    }
  }

  /** 제안 행동은 명령을 입력창에 채우기만 한다 — 여기서 직접 실행/변형하지 않는다(비-read 실행은
   *  서버 게이트웨이의 확인/감사 절차를 거쳐야 함). */
  useSuggestedAction(action: OsaaSuggestedAction): void {
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

  formatTokenCount(value: number): string {
    return new Intl.NumberFormat('ko-KR').format(Math.max(0, Number(value) || 0));
  }

  private initialMessages(): OsaaMessage[] {
    return [{ id: 'welcome-' + Date.now(), role: 'system', content: 'R2D2 ready.', meta: 'deepseek-v4-flash' }];
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

  sourceTrack(s: OsaaSource): string {
    return `${s.sourceType}/${s.sourceId}/${s.chunkIndex}`;
  }

  sourceLabel(s: OsaaSource): string {
    const tier = s.authorityTier == null ? '' : ` T${s.authorityTier}`;
    const score = typeof s.score === 'number' ? ` ${s.score.toFixed(2)}` : '';
    return `${s.sourceType}/${s.sourceId}#${s.chunkIndex}${tier}${score}`.trim();
  }

  private normalizeSources(value: unknown): OsaaSource[] {
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

  private normalizeConcepts(value: unknown): OsaaConcept[] {
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

  private normalizeSuggestedActions(value: unknown): OsaaSuggestedAction[] {
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

  private normalizeUsage(value: unknown, recorded: unknown): OsaaUsage | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const raw = value as Record<string, unknown>;
    const token = (candidate: unknown) => Math.max(0, Math.floor(Number(candidate) || 0));
    return {
      inputTokens: token(raw['inputTokens']),
      outputTokens: token(raw['outputTokens']),
      cachedInputTokens: token(raw['cachedInputTokens']),
      reasoningTokens: token(raw['reasoningTokens']),
      totalTokens: token(raw['totalTokens']),
      source: raw['source'] === 'provider' ? 'provider' : 'unavailable',
      recorded: recorded === true,
    };
  }

  private fromStoredMessage(value: unknown): OsaaMessage {
    const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const role = raw['role'] === 'user' || raw['role'] === 'assistant' || raw['role'] === 'system'
      ? raw['role'] : 'assistant';
    const response = raw['response'] && typeof raw['response'] === 'object'
      ? raw['response'] as Record<string, unknown> : {};
    const provider = String(response['provider'] || 'llm');
    const model = String(raw['modelId'] || response['model'] || '');
    const latency = Math.max(0, Number(response['latencyMs']) || 0);
    return {
      id: String(raw['id'] || crypto.randomUUID()),
      role,
      content: String(raw['content'] || ''),
      meta: role === 'assistant' ? `${provider} / ${model} / ${latency}ms` : undefined,
      sources: this.normalizeSources(raw['sources'] || response['sources']),
      concepts: this.normalizeConcepts(raw['concepts'] || (response['concepts'] as any)?.concepts),
      actions: this.normalizeSuggestedActions(raw['actions'] || response['suggestedActions']),
      usage: this.normalizeUsage(raw['usage'] || response['usage'], response['usageRecorded']),
    };
  }

  private async refreshHistory(loadNewest: boolean): Promise<void> {
    try {
      const response = await this.http.request('/api/osaa/conversations?status=active&limit=40');
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      const conversations = Array.isArray(body.conversations)
        ? body.conversations.map((raw: any): OsaaSession => ({
            id: String(raw?.id || ''),
            title: String(raw?.title || '새 대화'),
            status: raw?.status === 'archived' ? 'archived' : 'active',
            modelId: String(raw?.modelId || ''),
            preview: String(raw?.preview || ''),
            updatedAt: String(raw?.updatedAt || raw?.lastMessageAt || ''),
          })).filter((conversation: OsaaSession) => conversation.id)
        : [];
      this.sessions.set(conversations);
      if (loadNewest && !this.currentId() && conversations[0]) await this.loadSession(conversations[0]);
    } catch (error) {
      if (this.open()) this.error.set('대화 기록을 불러오지 못했습니다: ' + error);
    }
  }

  private readonly onWindowResize = (): void => {
    const width = this.clampDockWidth(this.dockWidth());
    if (width !== this.dockWidth()) this.dockWidth.set(width);
    document.body.style.setProperty('--osaa-dock-width', `${width}px`);
    this.syncFullLeft();
  };

  private initialDockWidth(): number {
    const raw = Number(window.localStorage.getItem('opensphere.osaa.dockWidth'));
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
    document.body.style.setProperty('--osaa-full-left', `${Math.max(0, Math.round(contentLeft))}px`);
  }
}
