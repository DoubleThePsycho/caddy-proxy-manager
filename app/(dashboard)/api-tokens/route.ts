/**
 * API tokens are managed on the Profile page (its "API tokens" section);
 * /api-tokens only sends the browser there. A route handler rather than a
 * page, so it is not a dashboard page of its own (src/lib/navigation.ts).
 */
export function GET(): Response {
  return new Response(null, { status: 307, headers: { Location: "/profile#api-tokens" } });
}
