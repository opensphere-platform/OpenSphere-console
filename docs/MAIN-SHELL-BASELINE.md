# OpenSphere Main Shell Baseline

Status: base deployment contract

## Purpose

The default Console deployment establishes the Main Shell before any subShell or plugin is installed.
It follows the mandatory order defined by `CONSTITUTION-0003`:

`Backbone → Main Shell/Console → subShell → plugin`

## Required base

The base is Ready only when all of the following are Ready:

1. Backbone PostgreSQL for append-only audit and Console state.
2. Backbone RustFS for bundles, uploads, and backup objects.
3. Backbone Gitea for desired-state history.
4. Kanidm and the Console authentication BFF.
5. Console frontend and same-origin ingress.
6. Console backend, DUPA controller, Registry projection, and API mediation.

The Main Shell owns the product frame, login/session, global navigation, extension host,
capability gates, routing, search/notification aggregation, and native administration pages.
It does not own a domain workflow.

## Empty Consumer invariant

A clean base deployment has:

- zero `UIPluginPackage` resources;
- zero `UIPluginRegistration` resources;
- zero workloads with the `opensphere.io/dupa-plugin` label;
- no OAA Gateway workload or proxy;
- an empty Extensions section that explains how an approved Consumer can be registered later.

Consumer source repositories and staging manifests may exist in the workspace, but they are not
part of the base runtime and must never be applied by the base Console deployment.

## Native base functions

- OIDC/PKCE login, logout, profile, and role-aware administration.
- Console-native `os` administrator CLI source, downloads, and `console==cli` contract. It is not a Binding.
- Backbone readiness and read-only component diagnostics.
- Durable, fail-closed administrative audit.
- Developer Catalog and API discovery backed by Console core services.
- A single management tree under `/manage/*`: assets/extensions, identity/access,
  platform foundation, and operations. Legacy duplicate routes are not retained.
- Empty Registry and extension lifecycle administration.
- Global navigation, local search, notifications with a right-side detail panel, responsive layout,
  and deep-link routing.
- TOTP development policy management from Console administration.

## Admission rule for the first subShell

No Consumer is installed implicitly. Installation requires an explicit operator decision and a
separate signed `UIPluginPackage` plus `UIPluginRegistration`. The first reference Consumer should
be the AI subShell only after this baseline passes its build, runtime, and browser checks.
