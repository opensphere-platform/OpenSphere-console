import { ConsoleIndexContentService } from '../core/console-index-content.service';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { ClarityModule } from '@clr/angular';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ExtensionHostService } from '../core/extension-host.service';
import { PerspectiveService } from '../core/perspective.service';
import { routeForPlugin } from '../core/perspectives';
import type { SERVICE_REALIZATION_LAYERS } from '../architecture/service-realization.model';
import { LandingModuleOverview } from './landing-module-overview';
import { LandingFoundations } from './landing-foundations';
import { LandingOsaaDialogueState } from './landing-osaa-dialogue-state';
import { LandingRegistryCatalog } from './landing-registry-catalog';
import { LandingPfssDelivery } from './landing-pfss-delivery';
import { LandingInstallationMilestones } from './landing-installation-milestones';

interface IndexLink {
  path: string;
  title: string;
  sub: string;
}

interface PerspectiveDef {
  num: number;
  name: string;
  korean: string;
  band: string;
  question: string;
  pluginId: string;
}

type ArchitecturePageId =
  | 'architecture'
  | 'service-stacks'
  | 'dupa'
  | 'control-pillars'
  | 'control-engine'
  | 'registry-catalog'
  | 'pfss-delivery'
  | 'ai-lifecycle'
  | 'osaa-dialogue-state'
  | 'installation';

/**
 * The horizontal axis is exactly ten Perspectives. Console is not an
 * eleventh Perspective; it is a Platform Control realization object in L3.
 * A Perspective link becomes actionable only when DUPA publishes its page.
 */
declare const PERSPECTIVES: PerspectiveDef[];

@Component({
  selector: 'os-landing',
  imports: [RouterLink, LandingModuleOverview, LandingFoundations, LandingOsaaDialogueState, LandingRegistryCatalog, LandingPfssDelivery, LandingInstallationMilestones, ClarityModule],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <main class="architecture-index">
      @if (content.state() === 'loading') {
        <p role="status">Console index 콘텐츠를 불러오는 중입니다.</p>
      } @else if (content.state() === 'error') {
        <section role="alert"><h2>Console index 콘텐츠를 불러오지 못했습니다.</h2>
          <p>콘텐츠 파일의 누락·호환성·무결성을 확인해 주세요. 서비스 운영 상태와는 별도의 오류입니다.</p>
          <button class="btn btn-outline" (click)="content.load()">다시 시도</button>
        </section>
      } @else {
      <clr-tabs class="architecture-page-tabs">
        <clr-tab>
          <button clrTabLink (click)="selectPage('architecture')">{{ copy('10p-6l-architecture') }}</button>
          <clr-tab-content *clrIfActive="activePage() === 'architecture'">
            <div class="architecture-page" id="architecture-page-realization">
      <section class="architecture-hero" aria-labelledby="architecture-title">
        <div>
          <div class="architecture-title-lockup">
            <img src="/assets/pictograms/systems.svg" [attr.alt]="copy('interconnected-opensphere-architecture-systems')" width="72" height="72" />
            <div>
              <p class="eyebrow">{{ copy('opensphere-architecture-index') }}</p>
              <h1 id="architecture-title">
                {{ copy('opensphere-ten-perspective-and-six-layer') }}
                <span>{{ copy('service-realization-architecture') }}</span>
              </h1>
            </div>
          </div>
          <p class="hero-lead">
            {{ copy('10개의-수평적-perspective로-서비스의-의미를-정의하고-6개의-수직적-layer로-그-서비스가-설치-활성화-운영-복구') }}
          </p>
        </div>
        <div class="model-equation" [attr.aria-label]="copy('ten-perspectives-by-six-layers')">
          <div>
            <strong>{{ copy('10') }}</strong>
            <span>{{ copy('perspectives') }}</span>
            <small>{{ copy('horizontal-service-lenses') }}</small>
          </div>
          <b aria-hidden="true">{{ copy('symbol') }}</b>
          <div>
            <strong>{{ copy('6') }}</strong>
            <span>{{ copy('layers') }}</span>
            <small>{{ copy('vertical-realization-structure') }}</small>
          </div>
        </div>
      </section>

      <section class="axis-definitions" [attr.aria-label]="copy('architecture-axes')">
        <article>
          <span class="axis-mark axis-mark-horizontal">{{ copy('horizontal') }}</span>
          <div class="axis-copy">
            <img src="/assets/pictograms/connected-ecosystem.svg" [attr.alt]="copy('connected-service-perspectives')" width="44" height="44" />
            <div>
              <h2>{{ copy('10-perspectives') }}</h2>
              <p>{{ copy('서비스를-어떤-사용자-업무-정보-흐름의-관점에서-읽고-제공하는지를-정의합니다') }}</p>
            </div>
          </div>
        </article>
        <article>
          <span class="axis-mark axis-mark-vertical">{{ copy('vertical') }}</span>
          <div class="axis-copy">
            <img src="/assets/pictograms/cloud-infrastructure-management.svg" [attr.alt]="copy('layered-service-infrastructure')" width="44" height="44" />
            <div>
              <h2>{{ copy('6-service-realization-layers') }}</h2>
              <p>{{ copy('무엇이-먼저-성립해야-하며-누가-권위를-갖고-어떤-증거로-다음-layer를-여는지-정의합니다') }}</p>
            </div>
          </div>
        </article>
        <article class="coordinate-rule">
          <span class="axis-mark">{{ copy('coordinate') }}</span>
          <div class="axis-copy">
            <img src="/assets/pictograms/microservices.svg" [attr.alt]="copy('atomic-service-coordinate')" width="44" height="44" />
            <div>
              <h2>{{ copy('service-perspective-layer') }}</h2>
              <p>{{ copy('제품-이름이-아니라-서비스의-의미와-운영-책임이-만나는-좌표에-객체를-배치합니다') }}</p>
            </div>
          </div>
        </article>
      </section>

      <os-landing-module-overview />

      <section class="architecture-capabilities" aria-labelledby="architecture-contract-title">
        <div class="section-heading">
          <div class="section-heading-title">
            <img src="/assets/pictograms/control-panel.svg" [attr.alt]="copy('architecture-operating-contract-controls')" width="52" height="52" />
            <div><p class="eyebrow">{{ copy('operating-contract') }}</p><h2 id="architecture-contract-title">{{ copy('좌표를-실제-운영-계약으로-바꾸는-네-가지-기능') }}</h2></div>
          </div>
          <p>{{ copy('각-객체는-분류에서-끝나지-않고-입력-소유자-완료-조건과-증거가-함께-정의되어야-합니다') }}</p>
        </div>
        <div class="architecture-capability-grid">
          <article><span>{{ copy('01') }}</span><h3>{{ copy('좌표-분류') }}</h3><p>{{ copy('사용자-업무-의미를-perspective로-실제-구현-책임을-주-layer로-고정합니다') }}</p><small>{{ copy('입력-service-intent-출력-perspective-layer-coordinate') }}</small></article>
          <article><span>{{ copy('02') }}</span><h3>{{ copy('선행-조건-검증') }}</h3><p>{{ copy('requires가-충족되지-않은-객체는-다음-layer의-ready로-승격하지-않습니다') }}</p><small>{{ copy('입력-dependency-evidence-출력-admitted-or-blocked-decision') }}</small></article>
          <article><span>{{ copy('03') }}</span><h3>{{ copy('소유자와-증거-확정') }}</h3><p>{{ copy('한-lifecycle-owner가-establishes와-ready-evidence를-함께-책임지도록-계약합니다') }}</p><small>{{ copy('입력-owner-contract-출력-authority-and-evidence-binding') }}</small></article>
          <article><span>{{ copy('04') }}</span><h3>{{ copy('실행-표면-연결') }}</h3><p>{{ copy('모델-객체와-현재-registry-console-route를-구분해-실제-사용-가능한-진입점만-노출합니다') }}</p><small>{{ copy('입력-verified-projection-출력-live-navigation-or-model-only-state') }}</small></article>
        </div>
      </section>

      <section class="model-section" aria-labelledby="model-title">
        <div class="section-heading">
          <div class="section-heading-title">
            <img src="/assets/pictograms/microservices.svg" [attr.alt]="copy('service-realization-model')" width="52" height="52" />
            <div>
              <p class="eyebrow">{{ copy('10p-6l-model') }}</p>
              <h2 id="model-title">{{ copy('opensphere-service-realization-map') }}</h2>
            </div>
          </div>
          <p>{{ copy('구조는-아래에서-위로-축적되며-설립-순서는-l1-bootstrap에서-l3를-거쳐-l1-hiss를-실증하는-feedback을') }}</p>
        </div>

        <div class="model-scroll" tabindex="0" [attr.aria-label]="copy('10-perspectives-and-6-layers-architecture-map')">
          <table class="realization-map">
            <thead>
              <tr>
                <th class="axis-corner" scope="col">
                  <span>{{ copy('service-meaning') }}</span>
                  <strong>{{ copy('perspectives-2') }}</strong>
                  <small>{{ copy('realization') }}</small>
                </th>
                @for (p of perspectiveCards(); track p.num) {
                  <th class="perspective-column" scope="col">
                    @if (p.live) {
                      <a [routerLink]="p.path" [attr.aria-label]="'Perspective ' + p.num + ' ' + p.name">
                        <span>P{{ perspectiveNumber(p.num) }}</span>
                        <strong>{{ p.name }}</strong>
                        <small>{{ p.korean }} · {{ p.band }}</small>
                        <em>{{ copy('등록됨') }}</em>
                      </a>
                    } @else {
                      <div [attr.aria-label]="'Perspective ' + p.num + ' ' + p.name">
                        <span>P{{ perspectiveNumber(p.num) }}</span>
                        <strong>{{ p.name }}</strong>
                        <small>{{ p.korean }} · {{ p.band }}</small>
                        <em>{{ copy('모델-정의') }}</em>
                      </div>
                    }
                  </th>
                }
              </tr>
            </thead>
            <tbody>
              @for (layer of layers; track layer.id) {
                <tr>
                  <th class="layer-heading" scope="row">
                    <span>L{{ layer.ordinal }}</span>
                    <strong>{{ layer.short }}</strong>
                    <small>{{ layer.id }} · {{ layer.scope }}</small>
                  </th>
                  <td class="layer-track" [class]="'layer-track layer-' + layer.ordinal" colspan="10">
                    <div class="layer-overview">
                      <div>
                        <span class="layer-kicker">{{ layer.id }} · {{ layer.scope }}</span>
                        <h3>{{ layer.name }}</h3>
                        <p>{{ layer.role }}</p>
                      </div>
                      <div class="object-list" [attr.aria-label]="copy('representative-objects')">
                        @for (object of layer.objects; track object) {
                          <span>{{ object }}</span>
                        }
                      </div>
                    </div>
                    <dl class="layer-contract">
                      <div>
                        <dt>{{ copy('requires') }}</dt>
                        <dd>{{ layer.requires }}</dd>
                      </div>
                      <div>
                        <dt>{{ copy('establishes') }}</dt>
                        <dd>{{ layer.establishes }}</dd>
                      </div>
                      <div>
                        <dt>{{ copy('ready-evidence') }}</dt>
                        <dd>{{ layer.evidence }}</dd>
                      </div>
                      <div>
                        <dt>{{ copy('lifecycle-authority') }}</dt>
                        <dd>{{ layer.authority }}</dd>
                      </div>
                    </dl>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      <section class="model-rules" aria-labelledby="rules-title">
        <div class="section-heading">
          <div class="section-heading-title">
            <img src="/assets/pictograms/control-panel.svg" [attr.alt]="copy('architecture-reading-rules')" width="52" height="52" />
            <div>
              <p class="eyebrow">{{ copy('reading-rules') }}</p>
              <h2 id="rules-title">{{ copy('이-모델을-읽는-세-가지-원칙') }}</h2>
            </div>
          </div>
        </div>
        <div>
          <article>
            <span>{{ copy('01') }}</span>
            <h3>{{ copy('layer는-설치-단계가-아닙니다') }}</h3>
            <p>{{ copy('지속되는-운영-구조이며-bootstrap은-l1-l2-l3-뒤-l1-hiss를-실증하는-feedback을-가집니다') }}</p>
          </article>
          <article>
            <span>{{ copy('02') }}</span>
            <h3>{{ copy('존재는-ready의-증거가-아닙니다') }}</h3>
            <p>{{ copy('pod나-객체의-존재가-아니라-실제-i-o-sync-rollback-restore와-정책-실증으로-판정합니다') }}</p>
          </article>
          <article>
            <span>{{ copy('03') }}</span>
            <h3>{{ copy('한-객체의-lifecycle-owner는-하나입니다') }}</h3>
            <p>{{ copy('여러-perspective에-노출되고-하위-layer에서-증거를-얻더라도-설치-변경-삭제를-소유하는-주-layer는-하나입니다') }}</p>
          </article>
        </div>
      </section>

      <section class="service-index" aria-labelledby="service-index-title">
        <div class="section-heading">
          <div class="section-heading-title">
            <img src="/assets/pictograms/console.svg" [attr.alt]="copy('operational-console-service-index')" width="52" height="52" />
            <div>
              <p class="eyebrow">{{ copy('current-implementation') }}</p>
              <h2 id="service-index-title">{{ copy('operational-service-index') }}</h2>
            </div>
          </div>
          <p>{{ copy('구조-모델과-현재-실행-가능한-console-진입점을-분리해-표시합니다') }}</p>
        </div>
        <div class="service-index-grid">
          <article>
            <div class="service-group-heading">
              <div>
                <span>{{ copy('native') }}</span>
                <h3>{{ copy('console-control-surfaces') }}</h3>
              </div>
              <strong>{{ coreCards().length }}</strong>
            </div>
            <div class="service-links">
              @for (item of coreCards(); track item.path) {
                <a [routerLink]="item.path">
                  <span>{{ item.title }}</span>
                  <small>{{ item.sub }}</small>
                </a>
              }
            </div>
          </article>
          <article>
            <div class="service-group-heading">
              <div>
                <span>{{ copy('dupa-registry') }}</span>
                <h3>{{ copy('registered-service-surfaces') }}</h3>
              </div>
              <strong>{{ extCards().length }}</strong>
            </div>
            @if (extCards().length) {
              <div class="service-links">
                @for (item of extCards(); track item.path) {
                  <a [routerLink]="item.path">
                    <span>{{ item.title }}</span>
                    <small>{{ item.sub }}</small>
                  </a>
                }
              </div>
            } @else {
              <p class="empty-state">{{ copy('검증-활성화되어-registry에-게시된-서비스가-없습니다') }}</p>
            }
          </article>
        </div>
      </section>
            </div>
          </clr-tab-content>
        </clr-tab>

        <clr-tab>
          <button clrTabLink (click)="selectPage('service-stacks')">{{ copy('service-stacks') }}</button>
          <clr-tab-content *clrIfActive="activePage() === 'service-stacks'">
            <os-landing-foundations page="service-stacks" />
          </clr-tab-content>
        </clr-tab>

        <clr-tab>
          <button clrTabLink (click)="selectPage('dupa')">{{ copy('dupa') }}</button>
          <clr-tab-content *clrIfActive="activePage() === 'dupa'">
            <os-landing-foundations page="dupa" />
          </clr-tab-content>
        </clr-tab>

        <clr-tab>
          <button clrTabLink (click)="selectPage('control-pillars')">{{ copy('control-pillars') }}</button>
          <clr-tab-content *clrIfActive="activePage() === 'control-pillars'">
            <os-landing-foundations page="control-pillars" />
          </clr-tab-content>
        </clr-tab>

        <clr-tab>
          <button clrTabLink (click)="selectPage('control-engine')">{{ copy('osce') }}</button>
          <clr-tab-content *clrIfActive="activePage() === 'control-engine'">
            <os-landing-foundations page="control-engine" />
          </clr-tab-content>
        </clr-tab>

        <clr-tab>
          <button clrTabLink (click)="selectPage('registry-catalog')">{{ copy('registry-catalog') }}</button>
          <clr-tab-content *clrIfActive="activePage() === 'registry-catalog'">
            <os-landing-registry-catalog />
          </clr-tab-content>
        </clr-tab>

        <clr-tab>
          <button clrTabLink (click)="selectPage('pfss-delivery')">{{ copy('pfss-delivery') }}</button>
          <clr-tab-content *clrIfActive="activePage() === 'pfss-delivery'">
            <os-landing-pfss-delivery />
          </clr-tab-content>
        </clr-tab>

        <clr-tab>
          <button clrTabLink (click)="selectPage('ai-lifecycle')">{{ copy('ai-lifecycle') }}</button>
          <clr-tab-content *clrIfActive="activePage() === 'ai-lifecycle'">
            <os-landing-foundations page="ai-lifecycle" />
          </clr-tab-content>
        </clr-tab>

        <clr-tab>
          <button clrTabLink (click)="selectPage('osaa-dialogue-state')">{{ copy('osdst') }}</button>
          <clr-tab-content *clrIfActive="activePage() === 'osaa-dialogue-state'">
            <os-landing-osaa-dialogue-state />
          </clr-tab-content>
        </clr-tab>
        <clr-tab>
          <button clrTabLink (click)="selectPage('installation')">{{ copy('설치-이정표') }}</button>
          <clr-tab-content *clrIfActive="activePage() === 'installation'">
            <os-landing-installation-milestones />
          </clr-tab-content>
        </clr-tab>
      </clr-tabs>
      }
    </main>
  `,
  styles: [
    `
      :host { display: block; }
      .architecture-index {
        --arch-page-title: clamp(1.55rem, 2.2vw, 2rem);
        --arch-section-title: 1.2rem;
        --arch-card-title: 0.98rem;
        --arch-body: 0.9rem;
        --arch-detail: 0.8rem;
        --arch-label: 0.68rem;
        margin: -1.5rem;
        min-height: calc(100% + 3rem);
        padding: 1.5rem 2rem 3rem;
        background: var(--os-overview-bg);
        color: var(--os-ink);
      }
      .architecture-page-tabs { display: block; width: 100%; min-width: 0; max-width: 100%; }
      :host ::ng-deep .architecture-page-tabs > .nav {
        position: relative;
        z-index: 1;
        margin: 0 0 1.25rem;
        overflow-x: auto;
        overflow-y: hidden;
        border-bottom: 1px solid var(--os-hairline);
        background: var(--os-overview-bg);
        scrollbar-width: thin;
      }
      :host ::ng-deep .architecture-page-tabs > .nav .nav-item { flex: 0 0 auto; }
      :host ::ng-deep .architecture-page-tabs > .nav .nav-link {
        min-height: 2.4rem;
        font-size: 0.82rem;
        font-weight: 600;
        white-space: nowrap;
      }
      :host ::ng-deep .architecture-page-tabs > .nav .nav-link.active,
      :host ::ng-deep .architecture-page-tabs > .nav .nav-link[aria-selected='true'] {
        background: var(--os-canvas);
        box-shadow: inset 0 -3px 0 var(--os-accent);
        color: var(--os-accent);
        font-weight: 700;
      }
      :host ::ng-deep .architecture-page-tabs > .nav .nav-link:focus-visible {
        outline: 2px solid var(--os-accent);
        outline-offset: -2px;
      }
      :host ::ng-deep .architecture-page-tabs > .tab-content { min-width: 0; padding: 0; }
      .architecture-page { min-width: 0; max-width: 100%; }
      .architecture-hero,
      .axis-definitions,
      .architecture-capabilities,
      .model-section,
      .model-rules,
      .service-index {
        width: 100%;
      }
      .architecture-hero {
        display: grid;
        grid-template-columns: minmax(0, 1.55fr) minmax(20rem, 0.75fr);
        gap: 2.5rem;
        align-items: end;
        padding: 1.25rem 0 1.75rem;
        border-bottom: 1px solid var(--os-hairline);
      }
      .eyebrow {
        margin: 0 0 0.55rem;
        color: var(--os-accent);
        font-size: var(--arch-label);
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .architecture-hero h1 {
        max-width: 64rem;
        margin: 0;
        font-size: var(--arch-page-title);
        font-weight: 500;
        letter-spacing: -0.025em;
        line-height: 1.14;
      }
      .architecture-hero h1 span {
        display: block;
        margin-top: 0.15rem;
        color: var(--os-ink-muted);
        font-weight: 400;
      }
      .architecture-title-lockup { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr); align-items: center; gap: 1rem; }
      .architecture-title-lockup > img { width: 5rem; height: 5rem; object-fit: contain; }
      .hero-lead {
        max-width: 55rem;
        margin: 1rem 0 0;
        color: var(--os-ink-muted);
        font-size: var(--arch-body);
        line-height: 1.65;
      }
      .model-equation {
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        min-height: 8rem;
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .model-equation > div { display: grid; gap: 0.15rem; padding: 1rem 1.15rem; }
      .model-equation strong { color: var(--os-accent); font-size: 2.25rem; font-weight: 300; line-height: 1; }
      .model-equation span { font-size: var(--arch-detail); font-weight: 650; }
      .model-equation small { color: var(--os-ink-muted); font-size: var(--arch-label); }
      .model-equation b { color: var(--os-ink-muted); font-size: 1.4rem; font-weight: 300; }

      .axis-definitions {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        border: 1px solid var(--os-hairline);
        border-top: 0;
        background: var(--os-canvas);
      }
      .axis-definitions article {
        display: grid;
        grid-template-columns: 5.5rem minmax(0, 1fr);
        gap: 0.75rem;
        min-height: 7.25rem;
        padding: 1rem;
        border-right: 1px solid var(--os-hairline);
      }
      .axis-definitions article:last-child { border-right: 0; }
      .axis-mark {
        align-self: start;
        padding-top: 0.25rem;
        border-top: 3px solid var(--os-ink);
        color: var(--os-ink-muted);
        font-size: 0.58rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .axis-mark-horizontal { border-color: var(--os-accent); }
      .axis-mark-vertical { border-color: #8a3ffc; }
      .axis-definitions h2 { margin: 0; font-size: var(--arch-card-title); font-weight: 650; }
      .axis-definitions p { margin: 0.45rem 0 0; color: var(--os-ink-muted); font-size: var(--arch-detail); line-height: 1.58; }
      .axis-copy { display: grid; grid-template-columns: 3rem minmax(0, 1fr); align-items: start; gap: 0.7rem; }
      .axis-copy > img { width: 2.75rem; height: 2.75rem; object-fit: contain; }
      .coordinate-rule { background: var(--os-surface-1); }

      .architecture-capabilities,
      .model-section,
      .model-rules,
      .service-index { margin-top: 2rem; }
      .section-heading {
        display: flex;
        justify-content: space-between;
        gap: 2rem;
        align-items: end;
        margin-bottom: 0.65rem;
      }
      .section-heading h2 { margin: 0; font-size: var(--arch-section-title); font-weight: 550; line-height: 1.3; }
      .section-heading > p { max-width: 38rem; margin: 0; color: var(--os-ink-muted); font-size: var(--arch-detail); line-height: 1.55; text-align: right; }

      .model-scroll {
        overflow-x: auto;
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .model-scroll:focus-visible { outline: 2px solid var(--os-accent); outline-offset: 2px; }
      .realization-map {
        width: 100%;
        min-width: 86rem;
        border-collapse: collapse;
        table-layout: fixed;
      }
      .realization-map th,
      .realization-map td { border-right: 1px solid var(--os-hairline); border-bottom: 1px solid var(--os-hairline); }
      .realization-map tr:last-child > * { border-bottom: 0; }
      .realization-map tr > *:last-child { border-right: 0; }
      .axis-corner,
      .layer-heading { width: 13rem; }
      .axis-corner {
        padding: 0.65rem 0.75rem;
        background: #161616;
        color: #fff;
        text-align: left;
        vertical-align: bottom;
      }
      .axis-corner span,
      .axis-corner small { display: block; color: #c6c6c6; font-size: 0.61rem; font-weight: 400; }
      .axis-corner strong { display: block; margin: 0.25rem 0; font-size: 0.72rem; }
      .perspective-column { width: 7.3rem; padding: 0; background: var(--os-surface-1); vertical-align: top; }
      .perspective-column a,
      .perspective-column div {
        display: grid;
        align-content: start;
        min-height: 7.75rem;
        padding: 0.65rem 0.55rem;
        color: inherit;
        text-align: left;
        text-decoration: none;
      }
      .perspective-column a { box-shadow: inset 0 3px 0 var(--os-accent); }
      .perspective-column a:hover { background: var(--os-accent-subtle); }
      .perspective-column span { color: var(--os-accent); font-family: var(--os-font-mono); font-size: 0.57rem; }
      .perspective-column strong { margin-top: 0.45rem; font-size: 0.64rem; line-height: 1.25; }
      .perspective-column small { margin-top: 0.2rem; color: var(--os-ink-muted); font-size: 0.58rem; line-height: 1.4; }
      .perspective-column em { align-self: end; margin-top: auto; padding-top: 0.55rem; color: var(--os-ink-muted); font-size: 0.56rem; font-style: normal; }
      .perspective-column a em { color: var(--os-success); font-weight: 650; }

      .layer-heading {
        padding: 0.8rem 0.75rem;
        background: var(--os-surface-1);
        text-align: left;
        vertical-align: top;
      }
      .layer-heading > span {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 2rem;
        height: 1.35rem;
        background: #161616;
        color: #fff;
        font-family: var(--os-font-mono);
        font-size: 0.58rem;
      }
      .layer-heading strong { display: block; margin-top: 0.55rem; font-size: 0.72rem; }
      .layer-heading small { display: block; margin-top: 0.15rem; color: var(--os-ink-muted); font-size: 0.59rem; line-height: 1.4; }
      .layer-track {
        padding: 0;
        background-color: var(--os-canvas);
        background-image: linear-gradient(to right, transparent calc(10% - 1px), rgba(0, 0, 0, 0.055) calc(10% - 1px), rgba(0, 0, 0, 0.055) 10%);
        background-size: 10% 100%;
        vertical-align: top;
      }
      .layer-6 { box-shadow: inset 4px 0 0 #8a3ffc; }
      .layer-5 { box-shadow: inset 4px 0 0 #0f62fe; }
      .layer-4 { box-shadow: inset 4px 0 0 #007d79; }
      .layer-3 { box-shadow: inset 4px 0 0 #525252; }
      .layer-2 { box-shadow: inset 4px 0 0 #6f6f6f; }
      .layer-1 { box-shadow: inset 4px 0 0 #8d8d8d; }
      .layer-overview {
        display: grid;
        grid-template-columns: minmax(17rem, 1.1fr) minmax(22rem, 1.7fr);
        gap: 1rem;
        padding: 0.75rem 0.85rem 0.6rem;
        background: rgba(255, 255, 255, 0.93);
      }
      .layer-kicker { color: var(--os-ink-muted); font-size: 0.52rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
      .layer-overview h3 { margin: 0.2rem 0 0; font-size: 0.78rem; font-weight: 650; }
      .layer-overview p { margin: 0.3rem 0 0; color: var(--os-ink-muted); font-size: 0.68rem; line-height: 1.5; }
      .object-list { display: flex; flex-wrap: wrap; align-content: start; gap: 0.3rem; }
      .object-list span {
        padding: 0.22rem 0.4rem;
        border: 1px solid var(--os-hairline);
        background: var(--os-surface-1);
        color: var(--os-ink-muted);
        font-size: 0.6rem;
      }
      .layer-contract {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        margin: 0;
        border-top: 1px solid var(--os-hairline);
        background: rgba(255, 255, 255, 0.93);
      }
      .layer-contract div { min-width: 0; padding: 0.55rem 0.7rem; border-right: 1px solid var(--os-hairline); }
      .layer-contract div:last-child { border-right: 0; }
      .layer-contract dt { color: var(--os-ink-muted); font-size: 0.5rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
      .layer-contract dd { margin: 0.18rem 0 0; color: var(--os-ink); font-size: 0.62rem; line-height: 1.48; }

      .model-rules > div,
      .service-index-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        border: 1px solid var(--os-hairline);
        background: var(--os-canvas);
      }
      .model-rules article { min-height: 8rem; padding: 0.85rem; border-right: 1px solid var(--os-hairline); }
      .model-rules article:last-child { border-right: 0; }
      .model-rules article > span { color: var(--os-accent); font-family: var(--os-font-mono); font-size: 0.58rem; }
      .model-rules h3 { margin: 0.75rem 0 0; font-size: 0.72rem; }
      .model-rules p { margin: 0.35rem 0 0; color: var(--os-ink-muted); font-size: 0.68rem; line-height: 1.55; }

      .service-index-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .service-index-grid > article:first-child { border-right: 1px solid var(--os-hairline); }
      .service-group-heading {
        display: flex;
        justify-content: space-between;
        align-items: center;
        min-height: 3.6rem;
        padding: 0.65rem 0.8rem;
        border-bottom: 1px solid var(--os-hairline);
        background: var(--os-surface-1);
      }
      .service-group-heading span { color: var(--os-ink-muted); font-size: 0.5rem; text-transform: uppercase; }
      .service-index-grid h3 { margin: 0.12rem 0 0; font-size: 0.72rem; }
      .service-group-heading > strong { color: var(--os-accent); font-size: 1.35rem; font-weight: 300; }
      .service-links { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .service-links a {
        display: grid;
        min-height: 3.6rem;
        padding: 0.6rem 0.75rem;
        border-right: 1px solid var(--os-hairline);
        border-bottom: 1px solid var(--os-hairline);
        color: inherit;
        text-decoration: none;
      }
      .service-links a:nth-child(2n) { border-right: 0; }
      .service-links a:hover { box-shadow: inset 3px 0 0 var(--os-accent); background: var(--os-accent-subtle); }
      .service-links span { font-size: 0.65rem; font-weight: 650; }
      .service-links small { margin-top: 0.15rem; color: var(--os-ink-muted); font-size: 0.59rem; line-height: 1.4; }
      .empty-state { margin: 0; padding: 1rem; color: var(--os-ink-muted); font-size: 0.69rem; }

      @media screen and (max-width: 76rem) {
        .architecture-hero { grid-template-columns: 1fr; }
        .model-equation { max-width: 38rem; }
        .axis-definitions { grid-template-columns: 1fr; }
        .axis-definitions article { border-right: 0; border-bottom: 1px solid var(--os-hairline); }
        .axis-definitions article:last-child { border-bottom: 0; }
      }
      @media screen and (max-width: 56rem) {
        .architecture-index { padding-inline: 1.5rem; }
        .section-heading { display: block; }
        .section-heading > p { margin-top: 0.35rem; text-align: left; }
        .model-rules > div,
        .service-index-grid { grid-template-columns: 1fr; }
        .model-rules article,
        .service-index-grid > article:first-child { border-right: 0; border-bottom: 1px solid var(--os-hairline); }
        .service-index-grid > article:last-child { border-bottom: 0; }
      }
      @media screen and (max-width: 36rem) {
        .architecture-index { margin: -1rem; padding: 1rem 1rem 2rem; }
        .architecture-hero h1 { font-size: var(--arch-page-title); }
        .architecture-title-lockup { grid-template-columns: 1fr; }
        .model-equation { grid-template-columns: 1fr; }
        .model-equation b { display: none; }
        .model-equation > div + div { border-top: 1px solid var(--os-hairline); }
        .axis-definitions article { grid-template-columns: 1fr; }
        .service-links { grid-template-columns: 1fr; }
        .service-links a { border-right: 0; }
      }
    `,
  ],
})
export class Landing {
  readonly content = inject(ConsoleIndexContentService);
  readonly copy = (key: string): string => this.content.text('architecture', key);

  constructor() { void this.content.load(); }

  private ext = inject(ExtensionHostService);
  private psp = inject(PerspectiveService);

  get layers(): typeof SERVICE_REALIZATION_LAYERS { return this.content.model('SERVICE_REALIZATION_LAYERS'); }
  readonly activePage = signal<ArchitecturePageId>(
    inject(ActivatedRoute).snapshot.fragment === 'installation' ? 'installation' : 'architecture',
  );

  selectPage(page: ArchitecturePageId): void {
    this.activePage.set(page);
  }

  readonly coreCards = computed<IndexLink[]>(() => {
    const base: IndexLink[] = [
      { path: '/manage/catalog', title: 'Developer Catalog', sub: 'Service assets and extensions' },
      { path: '/manage/apis', title: 'APIs', sub: 'Information flow and contracts' },
      { path: '/manual', title: 'Manual', sub: 'Architecture and operations' },
      { path: '/me', title: '내 정보', sub: 'Identity and session' },
    ];
    if (this.psp.isAdmin()) {
      base.push(
        { path: '/manage/data-identity', title: 'Console Backbone', sub: 'Supabase and Gitea authority' },
        { path: '/manage/platform-control', title: 'Platform Control', sub: 'Readiness and evidence' },
        { path: '/manage/extensions', title: 'Extensions', sub: 'DUPA lifecycle and Registry' },
        { path: '/manage/roles', title: '역할', sub: 'Roles and assignments' },
      );
    }
    return base;
  });

  readonly extCards = computed<IndexLink[]>(() =>
    this.ext.navigationItems().map((page) => ({
      path: page.route,
      title: page.title,
      sub: `${page.navBand} · ${page.id}`,
    })),
  );

  readonly perspectiveCards = computed(() => {
    const registered = new Set(this.ext.navigationItems().map((page) => page.id));
    return this.content.model<typeof PERSPECTIVES>('PERSPECTIVES').map((perspective) => ({
      ...perspective,
      live: registered.has(perspective.pluginId),
      path: routeForPlugin(perspective.pluginId),
    }));
  });

  perspectiveNumber(num: number): string {
    return String(num).padStart(2, '0');
  }
}
