'use strict';

// One-way reader for the exact agent component identity used by installations
// created before OSAA became canonical. These names are never accepted in a
// new request, target lock, route, or API field.
const LEGACY_INSTALLED_AGENT_COMPONENTS = Object.freeze({
  oaaGateway: 'opensphere-console-oaa-gateway',
  oaaGovernedAdapter: 'opensphere-oaa-governed-adapter',
});

const CANONICAL_AGENT_COMPONENTS = Object.freeze({
  osaaGateway: 'opensphere-console-osaa-gateway',
  osaaGovernedAdapter: 'opensphere-osaa-governed-adapter',
});

const LEGACY_TO_CANONICAL = Object.freeze({
  oaaGateway: 'osaaGateway',
  oaaGovernedAdapter: 'osaaGovernedAdapter',
});

const CANONICAL_TO_LEGACY = Object.freeze(
  Object.fromEntries(Object.entries(LEGACY_TO_CANONICAL)
    .map(([legacy, canonical]) => [canonical, legacy])),
);

function legacyInstalledComponentMap(canonicalComponents) {
  const components = Object.fromEntries(
    Object.entries(canonicalComponents)
      .filter(([name]) => !Object.hasOwn(CANONICAL_AGENT_COMPONENTS, name)),
  );
  return Object.freeze({ ...components, ...LEGACY_INSTALLED_AGENT_COMPONENTS });
}

function canonicalNameForInstalledComponent(name) {
  return LEGACY_TO_CANONICAL[name] ?? name;
}

function installedNameForCanonicalComponent(name) {
  return CANONICAL_TO_LEGACY[name] ?? name;
}

function isAgentIdentityCutover(baseComponents, targetComponents) {
  return Object.keys(LEGACY_INSTALLED_AGENT_COMPONENTS)
    .every((name) => Object.hasOwn(baseComponents ?? {}, name))
    && Object.keys(CANONICAL_AGENT_COMPONENTS)
      .every((name) => Object.hasOwn(targetComponents ?? {}, name));
}

function hasLegacyInstalledAgentIdentity(components) {
  return Object.keys(LEGACY_INSTALLED_AGENT_COMPONENTS)
    .every((name) => Object.hasOwn(components ?? {}, name))
    && Object.keys(CANONICAL_AGENT_COMPONENTS)
      .every((name) => !Object.hasOwn(components ?? {}, name));
}

module.exports = {
  LEGACY_INSTALLED_AGENT_COMPONENTS,
  CANONICAL_AGENT_COMPONENTS,
  legacyInstalledComponentMap,
  canonicalNameForInstalledComponent,
  installedNameForCanonicalComponent,
  isAgentIdentityCutover,
  hasLegacyInstalledAgentIdentity,
};
