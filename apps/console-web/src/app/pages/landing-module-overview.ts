import {Component, inject} from '@angular/core';
import {ConsoleIndexContentService} from '../core/console-index-content.service';

// CON-FR-014/017 · C_WEB: explanatory content only; no runtime or navigation authority.
@Component({
  selector: 'os-landing-module-overview',
  template: `
<section class="module-naming" aria-labelledby="module-naming-title">
        <div class="section-heading">
          <div class="section-heading-title">
            <img src="/assets/pictograms/microservices.svg" alt="" width="52" height="52" />
            <div><p class="eyebrow">{{ copy('module-naming-eyebrow') }}</p><h2 id="module-naming-title">{{ copy('module-naming-title') }}</h2></div>
          </div>
          <p>{{ copy('module-naming-lead') }}</p>
        </div>
        <div class="naming-definitions">
          <article><h3>{{ copy('module-definition-title') }}</h3><p>{{ copy('module-definition-body') }}</p></article>
          <article><h3>{{ copy('feature-definition-title') }}</h3><p>{{ copy('feature-definition-body') }}</p></article>
        </div>
        <p class="naming-note">{{ copy('module-classification-note') }}</p>
        <div class="module-overview-grid">
          @for (module of moduleOverview; track module.id) {
            <article class="module-overview-card">
              <div class="module-card-heading">
                <img [src]="'/assets/pictograms/' + module.pictogram + '.svg'" alt="" width="40" height="40" />
                <div><span>{{ copy(module.groupKey) }}</span><h3>{{ module.name }}</h3></div>
              </div>
              <p>{{ copy(module.summaryKey) }}</p>
              <ul class="module-feature-list" [attr.aria-label]="module.name + ' · ' + copy('module-features-label')">
                @for (feature of module.featureKeys; track feature) {
                  <li>{{ copy(feature) }}</li>
                }
              </ul>
            </article>
          }
        </div>
        <h3 class="naming-relations-title">{{ copy('naming-relations-title') }}</h3>
        <div class="naming-relations">
          <article><h4>{{ copy('naming-service-title') }}</h4><p>{{ copy('naming-service-body') }}</p><div class="naming-service-logos"><img src="/assets/product-logos/supabase-icon.svg" alt="Supabase" width="28" height="28" /><img src="/assets/product-logos/gitea.svg" alt="Gitea" width="28" height="28" /></div></article>
          <article><h4>{{ copy('naming-integration-title') }}</h4><p>{{ copy('naming-integration-body') }}</p></article>
          <article><h4>{{ copy('naming-extension-title') }}</h4><p>{{ copy('naming-extension-body') }}</p></article>
        </div>
        <p class="naming-note">{{ copy('naming-tools-note') }}</p>
        <div class="naming-axes"><h3>{{ copy('naming-axes-title') }}</h3><p>{{ copy('naming-axes-body') }}</p></div>
      </section>
  `,
  styles: [`

:host { display: block; }
.section-heading { display: flex; justify-content: space-between; align-items: start; gap: 1.5rem; margin-bottom: 1rem; }
.section-heading-title { display: flex; align-items: center; gap: 0.85rem; }
.section-heading-title img { flex: 0 0 3.25rem; object-fit: contain; }
h2 { font-size: var(--arch-section-title); margin: 0; line-height: 1.4; }
.module-naming .eyebrow { color: var(--os-accent); font-size: var(--arch-label); letter-spacing: .1em; margin: 0 0 .35rem; }
.section-heading > p { max-width: 35rem; }
@media screen and (max-width: 56rem) { .section-heading { display: block; } }
      .module-naming { margin-block: 1.5rem 2rem; min-width: 0; }
      .naming-definitions, .naming-relations { display: grid; gap: 1rem; grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .naming-definitions article, .naming-relations article, .naming-axes { padding: 1rem; background: var(--os-canvas); border: 1px solid var(--os-hairline); }
      .module-naming h3, .module-naming h4 { margin: 0; font-size: var(--arch-card-title); color: var(--os-ink); }
      .module-naming p { margin: 0.5rem 0 0; font-size: var(--arch-body); line-height: 1.65; color: var(--os-ink-muted); }
      .module-naming .naming-note { margin-block: 1rem; font-size: var(--arch-detail); }
      .module-overview-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 19rem), 1fr)); gap: 1rem; }
      .module-overview-card { min-width: 0; padding: 1rem; border: 1px solid var(--os-hairline); border-top: 3px solid var(--os-accent); background: var(--os-canvas); }
      .module-card-heading { display: flex; align-items: center; gap: 0.75rem; }
      .module-card-heading img { flex: 0 0 2.5rem; object-fit: contain; }
      .module-card-heading span { color: var(--os-ink-muted); font-size: var(--arch-detail); }
      .module-feature-list { display: grid; gap: 0.5rem; list-style: none; padding: 0; margin: 1rem 0 0; }
      .module-feature-list li { padding: 0.55rem 0.75rem; border: 1px solid var(--os-hairline); background: var(--os-surface-1); font-size: var(--arch-body); overflow-wrap: anywhere; }
      .module-naming .naming-relations-title { margin-block: 1.5rem 0.75rem; }
      .naming-relations { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .naming-service-logos { display: flex; gap: 0.75rem; margin-top: 0.75rem; }
      .naming-service-logos img { object-fit: contain; }
      .naming-axes { border-inline-start: 3px solid var(--os-accent); }
      @media screen and (max-width: 56rem) { .naming-definitions, .naming-relations { grid-template-columns: 1fr; } }

  `],
})
export class LandingModuleOverview {
  private readonly content = inject(ConsoleIndexContentService);
  readonly copy = (key: string): string => this.content.text('architecture', key);
  // Reviewed product descriptions, not runtime readiness or navigation authority.
  readonly moduleOverview = [
  {
    "id": "console",
    "name": "Console",
    "pictogram": "console",
    "groupKey": "module-console-group",
    "summaryKey": "module-console-summary",
    "featureKeys": [
      "feature-extensions",
      "feature-r2d2",
      "feature-shell"
    ]
  },
  {
    "id": "cluster",
    "name": "Cluster Manager",
    "pictogram": "cloud-infrastructure-management",
    "groupKey": "module-cluster-group",
    "summaryKey": "module-cluster-summary",
    "featureKeys": [
      "feature-kubernetes",
      "feature-hiss",
      "feature-ceph"
    ]
  },
  {
    "id": "foundation",
    "name": "Foundation",
    "pictogram": "connected-ecosystem",
    "groupKey": "module-foundation-group",
    "summaryKey": "module-foundation-summary",
    "featureKeys": [
      "feature-foundation-catalog",
      "feature-foundation-binding"
    ]
  },
  {
    "id": "developer",
    "name": "Developer",
    "pictogram": "developer-tools",
    "groupKey": "module-developer-group",
    "summaryKey": "module-developer-summary",
    "featureKeys": [
      "feature-developer-task",
      "feature-developer-preview"
    ]
  },
  {
    "id": "ai",
    "name": "AI Workbench",
    "pictogram": "intelligence",
    "groupKey": "module-ai-group",
    "summaryKey": "module-ai-summary",
    "featureKeys": [
      "feature-ai-experiment"
    ]
  },
  {
    "id": "pulse",
    "name": "Pulse",
    "pictogram": "control-tower",
    "groupKey": "module-pulse-group",
    "summaryKey": "module-pulse-summary",
    "featureKeys": [
      "feature-pulse-observation",
      "feature-pulse-incident"
    ]
  },
  {
    "id": "workspace",
    "name": "Workspace",
    "pictogram": "systems",
    "groupKey": "module-workspace-group",
    "summaryKey": "module-workspace-summary",
    "featureKeys": [
      "feature-workspace-account",
      "feature-workspace-apps"
    ]
  }
];

}
