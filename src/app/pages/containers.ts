import { Component, ChangeDetectionStrategy } from '@angular/core';
import { CarbonIcon } from '../os/carbon-icon';
import Launch16 from '@carbon/icons/es/launch/16';
import Information20 from '@carbon/icons/es/information/20';
import Code32 from '@carbon/icons/es/code/32';
import Kubernetes32 from '@carbon/icons/es/kubernetes/32';
import ContainerRegistry32 from '@carbon/icons/es/container-registry/32';

interface JumpCard { title: string; sub: string; icon: any }

/**
 * ContainersOverview — Containers 섹션의 Overview 콘텐츠(ACC /containers/overview 이식).
 * 2단 보조 내비는 상위 ContainersLayout이 소유(여기는 콘텐츠만). 배경/패딩도 레이아웃의 .cc-content가 제공.
 */
@Component({
  selector: 'os-containers-overview',
  imports: [CarbonIcon],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `
    <section class="ibm-containers-hero">
      <div class="ibm-containers-hero__copy">
        <h1>Run and manage containerized applications</h1>
        <p>From Kubernetes and Red Hat OpenShift, to Serverless solutions, we’ve got you covered.</p>
      </div>
      <div class="ibm-containers-hero__art" aria-hidden="true">
        <img src="/ibm-assets/containers-pillar-overview-header.svg" alt="" />
      </div>
    </section>

    <section class="ibm-containers-promo" aria-label="Containers promotion">
      <os-cicon [icon]="iInfo" [size]="20" />
      <div>
        <strong>50% savings for 6 months with promo code TRYCONTAINERS</strong>
        <p>For a limited time, use this promo code to save on selected IBM Cloud container services.</p>
      </div>
      <a class="cc-link" href="#claim" (click)="$event.preventDefault()">Claim now</a>
    </section>

    <section class="ibm-containers-section">
      <h2>Jump in</h2>
      <div class="ibm-containers-jump-grid">
        @for (c of jumpCards; track c.title) {
          <div class="ibm-containers-action-card">
            <os-cicon [icon]="c.icon" [size]="32" />
            <h3>{{ c.title }}</h3>
            <p>{{ c.sub }}</p>
          </div>
        }
      </div>
    </section>

    <section class="ibm-containers-section">
      <h2>Dashboard</h2>
      <div class="ibm-containers-dashboard-grid">
        <div class="ibm-containers-inventory-card">
          <div class="ibm-containers-card-heading"><h3>Inventory</h3></div>
          <ul>
            @for (r of inventory; track r.label) {
              <li><span>{{ r.label }}</span><a class="cc-link" href="#" (click)="$event.preventDefault()">{{ r.n }}</a></li>
            }
          </ul>
        </div>
        <div class="ibm-containers-side-card">
          <h3>Jump back in</h3>
          <p>Your recently used container resources will appear here.</p>
        </div>
        <div class="ibm-containers-side-card">
          <h3>Explore the docs</h3>
          <p>Find tutorials, CLI references, and container service guides.</p>
          <a class="cc-link cc-link--icon" href="#docs" (click)="$event.preventDefault()">Open docs <os-cicon [icon]="iLaunch" [size]="16" /></a>
        </div>
      </div>
    </section>
  `,
  styles: [
    `
      .ibm-containers-hero, .ibm-containers-promo, .ibm-containers-section { max-width: 87rem; }
      .ibm-containers-hero {
        display: grid; align-items: center; min-height: 17rem;
        grid-template-columns: minmax(0, 1fr) 22rem; padding: 1.5rem 0 2.25rem;
      }
      .ibm-containers-hero__copy h1 {
        max-width: 43rem; margin: 0; font-size: clamp(3rem, 4vw, 4rem); font-weight: 300;
        letter-spacing: -0.03em; line-height: 1.05; color: var(--os-ink);
      }
      .ibm-containers-hero__copy p { max-width: 42rem; margin: 1.25rem 0 0; color: var(--os-ink-muted); font-size: 1.125rem; line-height: 1.45; }
      .ibm-containers-hero__art { position: relative; height: 14rem; transform: scale(0.82); transform-origin: center right; }
      .ibm-containers-hero__art img { display: block; height: 100%; width: 100%; object-fit: contain; object-position: right center; }

      .ibm-containers-promo {
        display: grid; grid-template-columns: auto 1fr auto; align-items: flex-start; gap: 2rem;
        margin: 0 0 2.25rem; padding: 0.875rem 1rem; background: #edf5ff; border: 1px solid #0f62fe;
      }
      .ibm-containers-promo > os-cicon { color: #0f62fe; margin-block-start: 0.125rem; }
      .ibm-containers-promo strong { display: block; margin-block-end: 0.25rem; font-size: 1rem; font-weight: 400; color: var(--os-ink); }
      .ibm-containers-promo p { margin: 0; color: var(--os-ink-muted); font-size: 0.875rem; }

      .ibm-containers-section { margin: 0 0 2.25rem; }
      .ibm-containers-section h2 { margin: 0 0 0.75rem; font-size: 1.5rem; font-weight: 400; color: var(--os-ink); }

      .ibm-containers-jump-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.0625rem; }
      .ibm-containers-action-card { display: flex; flex-direction: column; min-height: 10.5rem; padding: 1rem; background: #fff; }
      .ibm-containers-action-card os-cicon { color: var(--os-ink-muted); order: 3; margin-block-start: auto; }
      .ibm-containers-action-card h3 { margin: 0 0 0.75rem; font-size: 1.125rem; font-weight: 400; line-height: 1.3; color: var(--os-ink); }
      .ibm-containers-action-card p { margin: 0; color: var(--os-ink-muted); font-size: 0.875rem; line-height: 1.45; }

      .ibm-containers-dashboard-grid { display: grid; grid-template-columns: 1.35fr 1fr 1fr; gap: 0.0625rem; }
      .ibm-containers-inventory-card, .ibm-containers-side-card { min-height: 12rem; padding: 1rem; background: #fff; }
      .ibm-containers-card-heading h3, .ibm-containers-side-card h3 { margin: 0 0 1rem; font-size: 1.125rem; font-weight: 400; line-height: 1.3; color: var(--os-ink); }
      .ibm-containers-inventory-card ul { padding: 0; margin: 1.5rem 0 0; list-style: none; }
      .ibm-containers-inventory-card li { display: grid; grid-template-columns: 1fr auto; align-items: center; min-height: 2.75rem; border-block-end: 1px solid var(--os-hairline); }
      .ibm-containers-inventory-card li span { color: var(--os-ink-muted); }
      .ibm-containers-inventory-card li a { font-size: 0.875rem; }
      .ibm-containers-side-card p { margin: 0 0 1rem; color: var(--os-ink-muted); font-size: 0.875rem; line-height: 1.45; }

      .cc-link { color: #0f62fe; text-decoration: none; cursor: pointer; }
      .cc-link:hover { text-decoration: underline; }
      .cc-link--icon { display: inline-flex; align-items: center; gap: 0.35rem; }

      @media screen and (max-width: 66rem) {
        .ibm-containers-hero, .ibm-containers-jump-grid, .ibm-containers-dashboard-grid { grid-template-columns: 1fr; }
        .ibm-containers-hero__art { display: none; }
      }
    `,
  ],
})
export class ContainersOverview {
  readonly iInfo = Information20;
  readonly iLaunch = Launch16;
  readonly jumpCards: JumpCard[] = [
    { title: 'Run code, jobs, or container images', sub: 'Deploy serverless workloads with IBM Cloud Code Engine.', icon: Code32 },
    { title: 'Create a cluster', sub: 'Build Kubernetes or Red Hat OpenShift clusters for production apps.', icon: Kubernetes32 },
    { title: 'Browse deployable architectures', sub: 'Start from deployable architectures and reusable templates.', icon: ContainerRegistry32 },
  ];
  readonly inventory = [
    { label: 'Serverless projects', n: 0 },
    { label: 'Clusters', n: 0 },
    { label: 'Namespaces', n: 0 },
  ];
}
