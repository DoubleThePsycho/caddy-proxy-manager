/**
 * Reserved ports for L4 proxy host listen addresses.
 *
 * Ingressi's generated Caddy config always binds these ports for its own listeners:
 * the HTTP app listens on :80/:443 and the admin API on :2019. An L4 server on
 * one of these ports creates a second listener on the same port; Caddy sets
 * SO_REUSEPORT on every listener, so the bind succeeds and the kernel silently
 * splits connections between the two sockets (~50% of TLS handshakes fail).
 * See issue #295.
 */
export const RESERVED_L4_PORTS = [80, 443, 2019] as const;

/** Extract the TCP/UDP port from an L4 listen address (":PORT" or "HOST:PORT"). */
export function extractL4ListenPort(listenAddress: string): number | null {
  const match = listenAddress.trim().match(/:(\d+)$/);
  if (!match) return null;
  const port = parseInt(match[1], 10);
  return port >= 1 && port <= 65535 ? port : null;
}

/** True if the listen address uses a port Ingressi's own Caddy listeners bind. */
export function isReservedL4Port(listenAddress: string): boolean {
  const port = extractL4ListenPort(listenAddress);
  return port !== null && (RESERVED_L4_PORTS as readonly number[]).includes(port);
}
