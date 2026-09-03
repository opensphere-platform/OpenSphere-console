import { ChangeDetectionStrategy, Component, ElementRef, inject } from '@angular/core';

/** CON-FR-007/014/017 · C_WEB · read-only installation/acceptance explanation, not runtime health. */
@Component({
  selector: 'os-landing-installation-milestones',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './landing-installation-milestones.html',
  styleUrl: './landing-installation-milestones.scss',
})
export class LandingInstallationMilestones {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  jumpTo(id: string): void {
    // This is a local navigation action, never an installation/apply action.
    if (!/^M0[1-8]$/.test(id)) return;
    const title = this.element.nativeElement.querySelector<HTMLElement>('#milestone-title-' + id);
    const unit = this.element.nativeElement.querySelector<HTMLElement>('#milestone-' + id);
    title?.focus({ preventScroll: true });
    unit?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }
}
