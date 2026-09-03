export type ServiceRealizationLayerId =
  | 'SRL-L1'
  | 'SRL-L2'
  | 'SRL-L3'
  | 'SRL-L4'
  | 'SRL-L5'
  | 'SRL-L6';

export interface ServiceRealizationLayer {
  id: ServiceRealizationLayerId;
  ordinal: 1 | 2 | 3 | 4 | 5 | 6;
  name: string;
  short: string;
  scope: string;
  role: string;
  requires: string;
  establishes: string;
  evidence: string;
  authority: string;
  failurePolicy: string;
  objects: string[];
}

/**
 * Service Realization Layers are persistent operating strata, not repository
 * folders, product modules, or a strictly linear installer sequence.
 *
 * The array is ordered top-down for the architecture map. Establishment uses
 * SERVICE_REALIZATION_ESTABLISHMENT_SEQUENCE because full HISS verification is
 * performed through the L3 Cluster Manager after the L1 bootstrap gate exists.
 */
export declare const SERVICE_REALIZATION_LAYERS: readonly ServiceRealizationLayer[];

/**
 * Persistent layer order and establishment order are intentionally different.
 * The first L1 entry is the small bootstrap gate; the second is full HISS
 * verification performed after L3 has established Cluster Manager authority.
 */
export declare const SERVICE_REALIZATION_ESTABLISHMENT_SEQUENCE: readonly (string)[];
