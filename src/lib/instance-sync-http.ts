/**
 * Whether instance sync may use plain HTTP (INSTANCE_SYNC_ALLOW_HTTP=true or
 * 1): test and lab setups on a trusted network only. One rule for every
 * request that carries a sync secret or a credential derived from one.
 */
export function isHttpSyncAllowed(): boolean {
  const envValue = process.env.INSTANCE_SYNC_ALLOW_HTTP;
  return envValue === "true" || envValue === "1";
}
