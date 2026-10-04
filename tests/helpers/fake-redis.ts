/**
 * A tiny RESP2 server for testing the certificate storage connection test
 * (ee/high-availability/redis-check.ts): enough of Redis, Redis Cluster and
 * Sentinel for AUTH, SELECT, SET, GET, DEL, PING, CLUSTER INFO and
 * SENTINEL get-master-addr-by-name. `extra` answers anything else (the
 * leader lease tests emulate their scripts with it).
 */
import net from 'node:net';

export type FakeRedisOptions = {
  /** requirepass; commands other than AUTH answer NOAUTH until signed in. */
  password?: string;
  /** ACL user that goes with the password. */
  username?: string;
  /** Answer CLUSTER INFO with cluster_state:ok. */
  cluster?: boolean;
  /** Answer the first SET with MOVED to this host:port. */
  movedTo?: string;
  /** Act as a Sentinel that knows this master. */
  sentinel?: { masterName: string; master: [string, string] };
  /** Error line to answer a command with, by upper-case command name. */
  errors?: Record<string, string>;
  /** Bytes to answer every request with instead (a server that is not Redis). */
  raw?: string;
  /**
   * Answers commands the fake does not know itself (EVAL, HSET, ...): the raw
   * RESP reply, or undefined for an unknown-command error.
   */
  extra?: (args: string[], store: Map<string, string>) => string | undefined;
};

export type FakeRedis = {
  address: string;
  port: number;
  commands: string[][];
  store: Map<string, string>;
  close: () => Promise<void>;
};

const bulk = (value: string) => `$${Buffer.byteLength(value)}\r\n${value}\r\n`;

/** Parses the complete commands (arrays of bulk strings) at the start of `buffer`. */
function parseCommands(buffer: Buffer): { commands: string[][]; rest: Buffer } {
  const commands: string[][] = [];
  let offset = 0;
  outer: while (offset < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd < 0 || buffer[offset] !== 0x2a) break;
    const count = Number(buffer.toString('utf8', offset + 1, lineEnd));
    let next = lineEnd + 2;
    const args: string[] = [];
    for (let index = 0; index < count; index++) {
      const headerEnd = buffer.indexOf('\r\n', next);
      if (headerEnd < 0) break outer;
      const length = Number(buffer.toString('utf8', next + 1, headerEnd));
      const start = headerEnd + 2;
      if (buffer.length < start + length + 2) break outer;
      args.push(buffer.toString('utf8', start, start + length));
      next = start + length + 2;
    }
    commands.push(args);
    offset = next;
  }
  return { commands, rest: buffer.subarray(offset) };
}

export async function startFakeRedis(options: FakeRedisOptions = {}): Promise<FakeRedis> {
  const commands: string[][] = [];
  const store = new Map<string, string>();
  let moved = false;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer: Buffer = Buffer.alloc(0);
    let signedIn = options.password === undefined;
    socket.on('data', (chunk: Buffer) => {
      if (options.raw !== undefined) {
        socket.write(options.raw);
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = parseCommands(buffer);
      buffer = parsed.rest;
      for (const args of parsed.commands) {
        commands.push(args);
        const name = args[0]?.toUpperCase() ?? '';
        const error = options.errors?.[name];
        if (error) {
          socket.write(`-${error}\r\n`);
          continue;
        }
        if (name === 'AUTH') {
          const [user, pass] = args.length === 3 ? [args[1], args[2]] : ['default', args[1]];
          if (options.password === undefined) {
            socket.write('-ERR AUTH <password> called without any password configured for the default user.\r\n');
          } else if (pass === options.password && (options.username ?? 'default') === user) {
            signedIn = true;
            socket.write('+OK\r\n');
          } else {
            socket.write('-WRONGPASS invalid username-password pair or user is disabled.\r\n');
          }
          continue;
        }
        if (!signedIn) {
          socket.write('-NOAUTH Authentication required.\r\n');
          continue;
        }
        switch (name) {
          case 'PING':
            socket.write('+PONG\r\n');
            break;
          case 'SELECT':
            socket.write('+OK\r\n');
            break;
          case 'CLUSTER':
            socket.write(options.cluster ? bulk('cluster_state:ok\r\ncluster_slots_assigned:16384\r\n') : '-ERR This instance has cluster support disabled\r\n');
            break;
          case 'SENTINEL': {
            const known = options.sentinel && args[1]?.toLowerCase() === 'get-master-addr-by-name' && args[2] === options.sentinel.masterName;
            socket.write(known ? `*2\r\n${bulk(options.sentinel!.master[0])}${bulk(options.sentinel!.master[1])}` : '*-1\r\n');
            break;
          }
          case 'SET':
            if (options.movedTo && !moved) {
              moved = true;
              socket.write(`-MOVED 1234 ${options.movedTo}\r\n`);
              break;
            }
            store.set(args[1], args[2]);
            socket.write('+OK\r\n');
            break;
          case 'GET':
            socket.write(store.has(args[1]) ? bulk(store.get(args[1])!) : '$-1\r\n');
            break;
          case 'DEL':
            socket.write(`:${store.delete(args[1]) ? 1 : 0}\r\n`);
            break;
          default:
            socket.write(options.extra?.(args, store) ?? `-ERR unknown command '${args[0]}'\r\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    address: `127.0.0.1:${port}`,
    port,
    commands,
    store,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
