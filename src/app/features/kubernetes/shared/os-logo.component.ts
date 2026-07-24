import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

/**
 * OS 배포판 로고 — 재사용 인라인 SVG(웹컴포넌트/외부 의존 없음). VM 카탈로그·목록·상세에서 운영체제 식별.
 * os id: cirros|fedora|centos|ubuntu|debian|opensuse|rhel|windows|generic. 이미지/OS 문자열에서 매핑(osIdFromImage).
 */
@Component({
  selector: 'app-os-logo',
  standalone: true,
  imports: [CommonModule],
  template: `
    <svg [attr.width]="size" [attr.height]="size" viewBox="0 0 48 48" [ngSwitch]="os" role="img" [attr.aria-label]="os">
      <!-- Fedora -->
      <g *ngSwitchCase="'fedora'">
        <circle cx="24" cy="24" r="22" fill="#3c6eb4"/>
        <path d="M31 12.5c-4.2 0-7.5 3.3-7.5 7.5v3.5h-4.2v5h4.2V35.5h6V25.5h4.3l1-5h-5.3v-2.8c0-1 .7-1.7 1.6-1.7H35v-3.5z" fill="#fff"/>
      </g>
      <!-- Red Hat / RHEL -->
      <g *ngSwitchCase="'rhel'">
        <circle cx="24" cy="24" r="22" fill="#fff"/>
        <ellipse cx="24" cy="31" rx="17" ry="4.5" fill="#ee0000"/>
        <path d="M13 29c0-7 4.8-12.5 11-12.5S35 22 35 29c0 0-5-2.6-11-2.6S13 29 13 29z" fill="#cc0000"/>
        <path d="M29.5 18.2c2.6 1 4.5 3.4 4.5 6.8 0 0-3.6-1.6-8-1.6-1 0-2 .1-2 .1 1.6-3.4 3-4.4 5.5-5.3z" fill="#ee0000"/>
      </g>
      <!-- CentOS -->
      <g *ngSwitchCase="'centos'">
        <circle cx="24" cy="24" r="22" fill="#fff"/>
        <path d="M24 23V6.5a17.5 17.5 0 0112 5z" fill="#932279"/>
        <path d="M25 24h16.5a17.5 17.5 0 01-5 12z" fill="#efa724"/>
        <path d="M24 25v16.5a17.5 17.5 0 01-12-5z" fill="#262577"/>
        <path d="M23 24H6.5a17.5 17.5 0 015-12z" fill="#9ccd2a"/>
        <rect x="21" y="21" width="6" height="6" fill="#fff"/>
      </g>
      <!-- Ubuntu -->
      <g *ngSwitchCase="'ubuntu'">
        <circle cx="24" cy="24" r="22" fill="#E95420"/>
        <circle cx="24" cy="24" r="7" fill="none" stroke="#fff" stroke-width="2.6"/>
        <circle cx="24" cy="10.5" r="3.3" fill="#fff"/>
        <circle cx="12.5" cy="30.5" r="3.3" fill="#fff"/>
        <circle cx="35.5" cy="30.5" r="3.3" fill="#fff"/>
      </g>
      <!-- Debian -->
      <g *ngSwitchCase="'debian'">
        <circle cx="24" cy="24" r="22" fill="#fff"/>
        <path d="M29 13c-8-2.5-15.5 3.5-15.5 11.5 0 7 5 12 11.5 12 4.6 0 7.6-1.8 9-4.8-1.8 1.7-3.8 2.6-6.5 2.6-5.6 0-9.5-3.9-9.5-9.5s4.6-10.6 10.3-10.6c.4 0 .5-.3.7-1.2z" fill="#A81D33"/>
      </g>
      <!-- openSUSE -->
      <g *ngSwitchCase="'opensuse'">
        <circle cx="24" cy="24" r="22" fill="#73ba25"/>
        <circle cx="24" cy="24" r="13" fill="none" stroke="#fff" stroke-width="3"/>
        <circle cx="30" cy="17" r="2.4" fill="#fff"/>
      </g>
      <!-- RHEL fallback via redhat alias handled above; Windows -->
      <g *ngSwitchCase="'windows'" fill="#00A4EF">
        <rect x="6" y="7" width="15.5" height="15.5"/>
        <rect x="26.5" y="7" width="15.5" height="15.5"/>
        <rect x="6" y="25.5" width="15.5" height="15.5"/>
        <rect x="26.5" y="25.5" width="15.5" height="15.5"/>
      </g>
      <!-- CirrOS / generic VM -->
      <g *ngSwitchCase="'cirros'">
        <circle cx="24" cy="24" r="22" fill="#5b6770"/>
        <rect x="13" y="15" width="22" height="14" rx="1.5" fill="none" stroke="#fff" stroke-width="2"/>
        <rect x="20" y="31" width="8" height="2.5" fill="#fff"/>
        <circle cx="24" cy="22" r="3.2" fill="#fff"/>
      </g>
      <g *ngSwitchDefault>
        <rect x="6" y="11" width="36" height="24" rx="2.5" fill="none" stroke="#888" stroke-width="2.4"/>
        <rect x="18" y="37" width="12" height="2.6" fill="#888"/>
        <circle cx="24" cy="23" r="4.5" fill="#888"/>
      </g>
    </svg>
  `,
})
export class OsLogoComponent {
  @Input() os = 'generic';
  @Input() size = 40;
}

/** 이미지/OS 문자열 → 로고 id 추론. */
export function osIdFromImage(s?: string): string {
  const v = (s || '').toLowerCase();
  if (v.includes('cirros')) return 'cirros';
  if (v.includes('fedora')) return 'fedora';
  if (v.includes('centos')) return 'centos';
  if (v.includes('ubuntu')) return 'ubuntu';
  if (v.includes('debian')) return 'debian';
  if (v.includes('suse')) return 'opensuse';
  if (v.includes('rhel') || v.includes('redhat') || v.includes('red hat')) return 'rhel';
  if (v.includes('win')) return 'windows';
  return 'generic';
}
