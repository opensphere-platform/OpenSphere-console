export type FoundationConceptTabId =
  | 'service-stacks'
  | 'dupa'
  | 'control-pillars'
  | 'control-engine'
  | 'ai-lifecycle';

export interface FoundationConceptTab {
  id: FoundationConceptTabId;
  label: string;
  eyebrow: string;
  summary: string;
  pictogram: string;
  pictogramAlt: string;
}

export interface ArchitectureDefinition {
  id: string;
  name: string;
  role: string;
  owns: readonly string[];
  excludes: readonly string[];
  evidence: string;
  productLogo?: string;
  productLogoAlt?: string;
}

export interface LifecycleDefinition {
  step: string;
  title: string;
  owner: string;
  outcome: string;
  evidence: string;
}

export interface ControlEngineNode {
  id: string;
  name: string;
  role: string;
  boundary: string;
  pictogram: string;
  pictogramAlt: string;
}

export declare const FOUNDATION_CONCEPT_TABS: readonly FoundationConceptTab[];

export declare const SERVICE_STACKS: readonly ArchitectureDefinition[];

export declare const CBSS_COMPONENTS: readonly ArchitectureDefinition[];

export declare const PFSS_CAPABILITIES: readonly ArchitectureDefinition[];

export declare const DUPA_INSTALL_STAGES: readonly LifecycleDefinition[];

export declare const DUPA_PLUGIN_ROLES: readonly ArchitectureDefinition[];

export declare const AGENT_RUNTIME_SPECTRUM: readonly ArchitectureDefinition[];

export declare const CONTROL_PILLARS: readonly ArchitectureDefinition[];

export declare const CONTROL_BEAMS: readonly ArchitectureDefinition[];

export declare const CONTROL_ENGINE_SURFACES: readonly ControlEngineNode[];

export declare const CONTROL_ENGINE_TARGETS: readonly ControlEngineNode[];

export declare const CONTROL_ENGINE_STAGES: readonly LifecycleDefinition[];

export declare const CONTROL_ENGINE_PICTOGRAMS: { "engine": string; "api": string };

export declare const AI_LIFECYCLE: readonly LifecycleDefinition[];

export declare const MODEL_LOCATIONS: readonly ArchitectureDefinition[];
