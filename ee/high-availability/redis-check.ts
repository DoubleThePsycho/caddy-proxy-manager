// SPDX-License-Identifier: Elastic-2.0
/**
 * "Test connection" for a Redis or Valkey certificate storage, run from this
 * web container: connect (through the Sentinels in Sentinel mode, following
 * a cluster redirect in cluster mode), sign in, select the database, then
 * write, read back and delete a short-lived key under the key prefix. The
 * same steps Caddy needs, without involving Caddy.
 *
 * Uses the minimal RESP2 client in resp.ts, so no dependency is needed.
 * Replies are bounded in size and time, and nothing a server sends is shown:
 * every step reports a fixed message, at most naming a known Redis error
 * code, so the test cannot be used to read other services on the network.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { decryptSecret } from "@/src/lib/secret";
import {
  KNOWN_REDIS_ERRORS,
  ProtocolError,
  RespError,
  describeSocketError,
  joinAddress,
  openConnection,
  sendCommand as send,
  splitAddress,
  type Resp,
  type RespConnection,
} from "./resp";
import { STORAGE_SECRET_ENV_FIELDS } from "./settings";
import type { StorageSecretField, StorageTestResult, StorageTestStep, StorageTestStepName, StoredRedisStorage } from "./types";

/** The whole test, every connection included. */
const TEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
/** The test key expires on its own if deleting it fails. */
const TEST_KEY_TTL_MS = 60_000;

function describeReplyError(error: RespError, step: StorageTestStepName): string {
  const known = KNOWN_REDIS_ERRORS[error.code];
  if (known) return known;
  if (step === "auth") return "the server refused to sign in (is a password set on the server?)";
  if (step === "sentinel") return "the address does not answer like a Sentinel";
  if (step === "select") return "the server refused to select the database";
  return "the server answered with an error";
}

type SecretSource = { kind: "value"; value: string } | { kind: "env"; name: string } | { kind: "none" } | { kind: "unreadable" };

function secretSource(redis: StoredRedisStorage, field: StorageSecretField): SecretSource {
  const env = redis[STORAGE_SECRET_ENV_FIELDS[field]];
  if (env) return { kind: "env", name: env };
  const stored = redis[field];
  if (!stored) return { kind: "none" };
  try {
    return { kind: "value", value: decryptSecret(stored, "certificate storage test") };
  } catch {
    return { kind: "unreadable" };
  }
}

class Steps {
  readonly list: StorageTestStep[] = [];
  complete = true;
  /** The step under way, reported when an unexpected error interrupts it. */
  current: StorageTestStepName = "connect";
  begin(step: StorageTestStepName) {
    this.current = step;
  }
  ok(step: StorageTestStepName, detail: string) {
    this.list.push({ step, ok: true, detail });
  }
  failed(step: StorageTestStepName, detail: string): never {
    this.list.push({ step, ok: false, detail });
    throw new StepFailed();
  }
}

class StepFailed extends Error {}

function isOk(reply: Resp): boolean {
  return reply === "OK";
}

/**
 * Signs in on a fresh connection. Returns false when the password is read
 * from the Caddy nodes' environment, so it could not be tested here.
 */
async function signIn(
  connection: RespConnection,
  username: string | undefined,
  password: SecretSource,
  steps: Steps,
  deadline: number,
  label: string
): Promise<boolean> {
  if (password.kind === "none") return true;
  if (password.kind === "unreadable") {
    steps.failed("auth", `the stored ${label} cannot be decrypted with this instance's SESSION_SECRET; enter it again`);
  }
  if (password.kind === "env") {
    steps.complete = false;
    steps.ok("auth", `skipped: the ${label} is read from ${password.name} on the Caddy nodes, which this test cannot see`);
    return false;
  }
  steps.begin("auth");
  const reply = await send(connection, username ? ["AUTH", username, password.value] : ["AUTH", password.value], deadline);
  if (reply instanceof RespError) steps.failed("auth", describeReplyError(reply, "auth"));
  if (!isOk(reply)) steps.failed("auth", "unexpected reply to AUTH");
  steps.ok("auth", username ? `signed in as ${username}` : "signed in");
  return true;
}

/** Asks the Sentinels, in order, where the master is. */
async function findMaster(redis: StoredRedisStorage, steps: Steps, deadline: number): Promise<string> {
  const sentinelPassword = secretSource(redis, "sentinelPassword");
  if (sentinelPassword.kind === "unreadable") {
    steps.failed("sentinel", "the stored Sentinel password cannot be decrypted with this instance's SESSION_SECRET; enter it again");
  }
  steps.begin("sentinel");
  let lastProblem = "no Sentinel could be reached";
  for (const address of redis.addresses) {
    let connection: RespConnection | null = null;
    try {
      connection = await openConnection(address, redis, deadline);
      if (sentinelPassword.kind === "value") {
        const auth = await send(connection, ["AUTH", sentinelPassword.value], deadline);
        if (auth instanceof RespError || !isOk(auth)) {
          lastProblem = `Sentinel ${address}: ${auth instanceof RespError ? describeReplyError(auth, "auth") : "unexpected reply to AUTH"}`;
          continue;
        }
      }
      const reply = await send(connection, ["SENTINEL", "get-master-addr-by-name", redis.masterName ?? ""], deadline);
      if (reply instanceof RespError) {
        lastProblem = `Sentinel ${address}: ${describeReplyError(reply, "sentinel")}`;
        continue;
      }
      if (reply === null) {
        lastProblem = `Sentinel ${address} does not know a master named ${redis.masterName}`;
        continue;
      }
      if (!Array.isArray(reply) || reply.length !== 2 || typeof reply[0] !== "string" || typeof reply[1] !== "string") {
        throw new ProtocolError();
      }
      const [host, port] = reply as [string, string];
      const master = joinAddress(host, port);
      if (!master) throw new ProtocolError();
      steps.ok("sentinel", `Sentinel ${address} named the master ${master}`);
      return master;
    } catch (error) {
      if (error instanceof StepFailed) throw error;
      lastProblem = `Sentinel ${address}: ${describeSocketError(error)}`;
    } finally {
      connection?.close();
    }
  }
  steps.failed("sentinel", lastProblem);
}

/** The node a MOVED error points to (an empty host means the same host). */
function redirectTarget(error: RespError, current: string): string | null {
  const [, , where] = error.text.split(" ");
  if (!where) return null;
  const colon = where.lastIndexOf(":");
  const host = where.slice(0, colon).replace(/^\[|\]$/g, "") || splitAddress(current).host;
  const port = where.slice(colon + 1);
  return joinAddress(host, port);
}

/** Connects to the first address that answers. */
async function connectToAny(
  addresses: string[],
  redis: StoredRedisStorage,
  steps: Steps,
  deadline: number
): Promise<{ connection: RespConnection; address: string }> {
  steps.begin("connect");
  let lastProblem = "connection failed";
  for (const address of addresses) {
    try {
      const connection = await openConnection(address, redis, deadline);
      steps.ok("connect", `connected to ${address}${redis.tls.enabled ? " over TLS" : ""}`);
      return { connection, address };
    } catch (error) {
      lastProblem = `${address}: ${describeSocketError(error)}`;
    }
  }
  steps.failed("connect", lastProblem);
}

async function runSteps(redis: StoredRedisStorage, steps: Steps, deadline: number): Promise<string | null> {
  const password = secretSource(redis, "password");
  if (redis.mode === "sentinel") {
    const sentinelPassword = secretSource(redis, "sentinelPassword");
    if (sentinelPassword.kind === "env") {
      // The Sentinels cannot be asked without their password: only show one answers.
      const { connection } = await connectToAny(redis.addresses, redis, steps, deadline);
      connection.close();
      steps.complete = false;
      steps.ok(
        "sentinel",
        `skipped: the Sentinel password is read from ${sentinelPassword.name} on the Caddy nodes, which this test cannot see`
      );
      return null;
    }
  }
  const addresses = redis.mode === "sentinel" ? [await findMaster(redis, steps, deadline)] : redis.addresses;
  let { connection, address } = await connectToAny(addresses, redis, steps, deadline);
  try {
    if (!(await signIn(connection, redis.username, password, steps, deadline, "password"))) {
      // Without the password only reachability can be shown.
      steps.begin("connect");
      const ping = await send(connection, ["PING"], deadline);
      if (ping instanceof RespError && ping.code !== "NOAUTH") steps.failed("connect", describeReplyError(ping, "connect"));
      if (!(ping instanceof RespError) && ping !== "PONG") throw new ProtocolError();
      return address;
    }
    if (redis.mode === "cluster") {
      // Caddy's cluster client refuses a server without cluster support.
      steps.begin("connect");
      const info = await send(connection, ["CLUSTER", "INFO"], deadline);
      if (info instanceof RespError) {
        steps.failed(
          "connect",
          info.code === "ERR" ? "the server has cluster support disabled: choose the single server mode" : describeReplyError(info, "connect")
        );
      }
      if (typeof info !== "string") throw new ProtocolError();
      if (!/cluster_state:ok/.test(info)) steps.failed("connect", "the cluster does not report cluster_state:ok");
    }
    if (redis.db !== 0 && redis.mode !== "cluster") {
      steps.begin("select");
      const reply = await send(connection, ["SELECT", String(redis.db)], deadline);
      if (reply instanceof RespError) steps.failed("select", describeReplyError(reply, "select"));
      steps.ok("select", `selected database ${redis.db}`);
    }

    const key = `${redis.keyPrefix}/.storage-test/${randomUUID()}`;
    const value = randomBytes(16).toString("hex");
    steps.begin("write");
    let written = await send(connection, ["SET", key, value, "PX", String(TEST_KEY_TTL_MS), "NX"], deadline);
    for (let redirects = 0; written instanceof RespError && written.code === "MOVED" && redis.mode === "cluster"; redirects++) {
      const next = redirectTarget(written, address);
      if (!next || redirects >= MAX_REDIRECTS) steps.failed("write", "the cluster kept redirecting the test key");
      connection.close();
      try {
        connection = await openConnection(next, redis, deadline);
      } catch (error) {
        steps.failed("write", `the cluster sent the test key to ${next}: ${describeSocketError(error)}`);
      }
      address = next;
      await signIn(connection, redis.username, password, steps, deadline, "password");
      written = await send(connection, ["SET", key, value, "PX", String(TEST_KEY_TTL_MS), "NX"], deadline);
    }
    if (written instanceof RespError) steps.failed("write", describeReplyError(written, "write"));
    if (!isOk(written)) steps.failed("write", "the test key could not be written");
    steps.ok("write", `wrote a test key under ${redis.keyPrefix}/`);

    steps.begin("read");
    const read = await send(connection, ["GET", key], deadline);
    if (read instanceof RespError) steps.failed("read", describeReplyError(read, "read"));
    if (read !== value) steps.failed("read", "the value read back differs from the value written");
    steps.ok("read", "read the test key back");

    steps.begin("delete");
    const deleted = await send(connection, ["DEL", key], deadline);
    if (deleted instanceof RespError) steps.failed("delete", describeReplyError(deleted, "delete"));
    if (deleted !== 1) steps.failed("delete", "the test key could not be deleted (it expires in a minute)");
    steps.ok("delete", "deleted the test key");
    return address;
  } finally {
    connection.close();
  }
}

/** Tests a Redis or Valkey storage from this instance. Never throws. */
export async function testRedisStorage(redis: StoredRedisStorage): Promise<StorageTestResult> {
  const steps = new Steps();
  const deadline = Date.now() + TEST_TIMEOUT_MS;
  let server: string | null = null;
  try {
    server = await runSteps(redis, steps, deadline);
  } catch (error) {
    if (!(error instanceof StepFailed)) {
      steps.list.push({ step: steps.current, ok: false, detail: describeSocketError(error) });
    }
  }
  return { ok: steps.list.length > 0 && steps.list.every((step) => step.ok), complete: steps.complete, server, steps: steps.list };
}
