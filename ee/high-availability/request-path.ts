// SPDX-License-Identifier: Elastic-2.0
/**
 * Request-path routes: the routes a high availability standby keeps serving
 * (proxy.ts answers every other dashboard and API request on a standby with
 * 503 "standby"). Caddy calls some of them for every request to a protected
 * or monetized host, so they must not depend on which node is the leader.
 *
 * This is the single list. Add a route here only when it is on the path of
 * proxied traffic (Caddy calls it, or a visitor of a protected host is sent
 * to it) and it works on a standby: there the database is a read-only copy
 * that trails the leader by a few seconds (ee/docs/high-availability.md), so
 * the route must not write to SQLite; state it changes belongs in shared
 * state (Redis or Valkey). Dashboard pages, the REST API, sign-in to the
 * dashboard and anything that changes configuration never belong here.
 */

export type RequestPathRoute = {
  /** The pathname, without a trailing slash. */
  path: string;
  /** "exact" matches the path only; "prefix" also everything under path + "/". */
  match: "exact" | "prefix";
  /** Who calls it and why a standby must answer. */
  reason: string;
};

export const REQUEST_PATH_ROUTES: readonly RequestPathRoute[] = [
  {
    path: "/api/forward-auth/verify",
    match: "exact",
    reason: "Caddy's forward-auth subrequest for every request to a host protected by Ingressi forward auth",
  },
  {
    path: "/api/forward-auth/callback",
    match: "exact",
    reason: "Caddy sends /.ingressi-auth/callback on protected hosts here after sign-in, to set the session cookie",
  },
  {
    path: "/portal",
    match: "exact",
    reason: "the forward-auth sign-in page visitors of protected hosts are redirected to",
  },
  {
    path: "/api/forward-auth/login",
    match: "exact",
    reason: "the portal's sign-in form",
  },
  {
    path: "/api/forward-auth/session-login",
    match: "exact",
    reason: "the portal's sign-in for a visitor signed in to the dashboard through an identity provider",
  },
  {
    path: "/api/branding",
    match: "prefix",
    reason: "the logos and favicon the portal shows before sign-in (read-only)",
  },
  {
    path: "/api/monetization/gate",
    match: "exact",
    reason: "Caddy's subrequest for every request to a host with API monetization",
  },
];

/** Whether `pathname` is a request-path route that a standby keeps serving. */
export function isRequestPathRoute(pathname: string): boolean {
  for (const route of REQUEST_PATH_ROUTES) {
    if (pathname === route.path) return true;
    if (route.match === "prefix" && pathname.startsWith(`${route.path}/`)) return true;
  }
  return false;
}
