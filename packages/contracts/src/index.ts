/**
 * @opensphere/console-contracts — Console host↔guest 표준 계약.
 *
 * subShell·plugin·외부 개발자가 의존하는 단일 진실 출처(SSOT). 셸의 extension-host에 박혀 있던
 * 계약을 추출·승격한 것. 개념: C1 capabilities · C2 context · C3 kinds · C4 manifest · C5 integrations.
 *
 * 진입점(guest 저작):
 *   import type { OpenSpherePluginContext, PluginModule } from '@opensphere/console-contracts';
 *   export function activate(ctx: OpenSpherePluginContext) { ctx.extensions.registerPage(...) }
 *   export function deactivate() {}
 */
export * from './contract/kinds.js';
export * from './contract/capabilities.js';
export * from './contract/context.js';
export * from './contract/manifest.js';
export * from './contract/binding.js';
export * from './contract/module-package.js';
