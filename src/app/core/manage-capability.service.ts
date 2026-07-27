import { Injectable, inject, signal } from '@angular/core';
import { HttpService } from './http.service';

export type ManageFeature = 'extensions' | 'cli' | 'oaa' | 'observability';
export type ManageFeaturePhase =
  | 'checking'
  | 'available'
  | 'degraded'
  | 'restricted'
  | 'not-configured';

export interface ManageFeatureState {
  phase: ManageFeaturePhase;
  label: string;
  detail: string;
  observedAt: string;
}

interface FeatureProbe {
  feature: ManageFeature;
  path: string;
}

const PROBES: readonly FeatureProbe[] = [
  { feature: 'extensions', path: '/api/admin/plugins/catalog' },
  { feature: 'cli', path: '/api/cli/index.json' },
  { feature: 'oaa', path: '/api/oaa/health' },
  { feature: 'observability', path: '/api/admin/observability/status' },
];

const INITIAL_STATE: Readonly<Record<ManageFeature, ManageFeatureState>> = Object.freeze({
  extensions: {
    phase: 'checking',
    label: '확인 중',
    detail: 'Extension 제어 API를 확인하고 있습니다.',
    observedAt: '',
  },
  cli: {
    phase: 'checking',
    label: '확인 중',
    detail: 'CLI 배포 인덱스를 확인하고 있습니다.',
    observedAt: '',
  },
  oaa: {
    phase: 'checking',
    label: '확인 중',
    detail: 'OAA Gateway를 확인하고 있습니다.',
    observedAt: '',
  },
  observability: {
    phase: 'checking',
    label: '확인 중',
    detail: 'HIS Binding 소비 API를 확인하고 있습니다.',
    observedAt: '',
  },
});

/**
 * `/manage` optional feature availability is derived from the exact same-origin
 * contracts the target pages consume. This prevents a deployment from
 * advertising a menu merely because its Angular route exists while the
 * required runtime or delivery artifact is absent.
 */
@Injectable({ providedIn: 'root' })
export class ManageCapabilityService {
  private readonly http = inject(HttpService);
  private inFlight: Promise<void> | null = null;

  readonly states = signal<Readonly<Record<ManageFeature, ManageFeatureState>>>(INITIAL_STATE);

  load(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = Promise.all(PROBES.map((probe) => this.probe(probe)))
      .then((results) => {
        this.states.set(Object.fromEntries(results) as Record<ManageFeature, ManageFeatureState>);
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  state(feature: ManageFeature): ManageFeatureState {
    return this.states()[feature];
  }

  isNavigable(feature: ManageFeature): boolean {
    return (
      this.state(feature).phase !== 'checking' && this.state(feature).phase !== 'not-configured'
    );
  }

  private async probe(probe: FeatureProbe): Promise<readonly [ManageFeature, ManageFeatureState]> {
    const observedAt = new Date().toISOString();
    try {
      const response = await this.http.request(probe.path, { cache: 'no-store' });
      if (response.status === 404) {
        return [
          probe.feature,
          {
            phase: 'not-configured',
            label: '미구성',
            detail: `${probe.path} 계약이 현재 배포에 없습니다.`,
            observedAt,
          },
        ];
      }
      if (response.status === 401 || response.status === 403) {
        return [
          probe.feature,
          {
            phase: 'restricted',
            label: '권한 필요',
            detail: `기능은 배포되어 있으나 현재 세션이 HTTP ${response.status}로 제한되었습니다.`,
            observedAt,
          },
        ];
      }
      if (!response.ok) {
        return [
          probe.feature,
          {
            phase: 'degraded',
            label: '저하',
            detail: `기능 계약이 HTTP ${response.status} 상태입니다.`,
            observedAt,
          },
        ];
      }

      if (probe.feature === 'oaa') {
        const body = (await response
          .clone()
          .json()
          .catch(() => ({}))) as {
          status?: string;
          degraded?: boolean;
          degradedReason?: string | null;
        };
        if (body.degraded || (body.status && body.status !== 'ready')) {
          return [
            probe.feature,
            {
              phase: 'degraded',
              label: '저하',
              detail: body.degradedReason || body.status || 'OAA readiness가 저하되었습니다.',
              observedAt,
            },
          ];
        }
      }

      return [
        probe.feature,
        {
          phase: 'available',
          label: '사용 가능',
          detail: `${probe.path} 계약이 응답했습니다.`,
          observedAt,
        },
      ];
    } catch (error) {
      return [
        probe.feature,
        {
          phase: 'degraded',
          label: '확인 불가',
          detail: `기능 상태 조회 실패: ${String(error)}`,
          observedAt,
        },
      ];
    }
  }
}
