/** @module test/helpers/fake-platforms — one `Bun.serve` faking the Telegram Bot API (`/tg`, including Rich Messages, `getUpdates` with callback queries and `answerCallbackQuery`), Discord webhooks (`/api/webhooks`), the Discord bot REST API and a gateway subset (`/discord`), an ntfy server with streaming subscriptions (`/ntfy`) and a plain webhook receiver (`/hook`) (spec 09 §4). Every request is recorded; failures are scripted per route. */

/** A request the fakes received. */
export interface RecordedRequest {
  readonly platform: 'telegram' | 'discord' | 'discord-bot' | 'ntfy' | 'webhook';
  readonly method: string;
  /** Path without the platform prefix (Telegram: the method name). */
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  /** JSON body, or the parsed `payload_json` of a multipart body. */
  readonly json: unknown;
  /** Text fields of a multipart body. */
  readonly form: Readonly<Record<string, string>> | null;
  readonly files: readonly {
    readonly field: string;
    readonly name: string;
    readonly type: string;
    readonly size: number;
  }[];
  /** Size of a raw (binary) body. */
  readonly bytes: number;
  /** The raw text body (JSON requests). */
  readonly raw: string;
}

/** A scripted answer for the next call of a route. */
export type ScriptedAnswer =
  | {
      readonly status: number;
      readonly body?: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | { readonly hang: true };

/** Route keys for scripts: `telegram:<method>`, `discord:<METHOD>`, `ntfy:<METHOD>`, `webhook`. */
export type RouteKey = string;

/** A Telegram update the fake returns from `getUpdates`. */
export interface FakeUpdate {
  readonly update_id: number;
  readonly message?: Record<string, unknown>;
  readonly callback_query?: Record<string, unknown>;
}

/** A gateway payload the fake received from a client (`op`, and `d` for Identify/Resume). */
export interface GatewayFrame {
  readonly op: number;
  readonly d: unknown;
}

/** One gateway client connection of the fake. */
interface GatewayClient {
  readonly ws: { send(data: string): void; close(code?: number, reason?: string): void };
  seq: number;
}

/** Low-entropy fake credentials (gitleaks scans every commit). */
export const FAKE_TG_TOKEN = `1234:${'a'.repeat(35)}`;
/** Token part of the fake Discord webhook URL. */
export const FAKE_DISCORD_TOKEN = 'b'.repeat(24);
/** Low-entropy fake Discord bot token. */
export const FAKE_DISCORD_BOT_TOKEN = 'c'.repeat(40);
/** Ids the Discord bot fake answers with. */
export const FAKE_DISCORD = {
  applicationId: '100000000000000001',
  botId: '100000000000000001',
  guildId: '200000000000000002',
  channelId: '300000000000000003',
  categoryId: '300000000000000009',
  userId: '400000000000000004',
} as const;

/**
 * The fakes. `start()` binds an ephemeral port; `stop()` releases it (hanging requests included).
 */
export class FakePlatforms {
  readonly requests: RecordedRequest[] = [];
  readonly updates: FakeUpdate[] = [];
  private readonly scripts = new Map<RouteKey, ScriptedAnswer[]>();
  private readonly ntfyMessages = new Map<string, Record<string, unknown>[]>();
  private readonly ntfySubscribers = new Map<string, Set<(line: string) => void>>();
  private server: ReturnType<typeof Bun.serve<{ gateway: true }, never>> | undefined;
  private counter = 100;
  /** Frames gateway clients sent (heartbeats, Identify, Resume). */
  readonly gatewayFrames: GatewayFrame[] = [];
  private readonly gatewayClients = new Set<GatewayClient>();
  /** Heartbeat interval the fake gateway announces in Hello. */
  gatewayHeartbeatMs = 45_000;
  /** When false, the fake gateway stops acknowledging heartbeats (a zombie connection). */
  gatewayAcks = true;
  /** Connections the fake gateway accepted. */
  gatewayConnections = 0;

  /** Starts the server. */
  start(): this {
    this.server = Bun.serve<{ gateway: true }, never>({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req, server) => {
        if (new URL(req.url).pathname.startsWith('/discord/gateway')) {
          if (server.upgrade(req, { data: { gateway: true } })) return undefined;
          return new Response('upgrade failed', { status: 400 });
        }
        return this.handle(req);
      },
      websocket: {
        open: (ws) => this.gatewayOpen(ws),
        message: (ws, message) => this.gatewayMessage(ws, String(message)),
        close: (ws) => {
          for (const c of this.gatewayClients) if (c.ws === ws) this.gatewayClients.delete(c);
        },
      },
    });
    return this;
  }

  /** Stops the server. */
  async stop(): Promise<void> {
    await this.server?.stop(true);
  }

  /** `http://127.0.0.1:<port>`. */
  get url(): string {
    return `http://127.0.0.1:${this.server?.port ?? 0}`;
  }

  /** Bot API base for `createTelegramChannel({ apiBase })`. */
  get telegramBase(): string {
    return `${this.url}/tg`;
  }

  /** A webhook URL on the Discord fake. */
  get discordWebhook(): string {
    return `${this.url}/api/webhooks/1/${FAKE_DISCORD_TOKEN}`;
  }

  /** Base of the ntfy fake (`target.server`). */
  get ntfyServer(): string {
    return `${this.url}/ntfy`;
  }

  /** A receiver URL for the generic webhook. */
  get webhookUrl(): string {
    return `${this.url}/hook/bh`;
  }

  /** Bot REST base for the Discord bot fake (`apiBase`). */
  get discordApi(): string {
    return `${this.url}/discord/api/v10`;
  }

  /** Clients connected to the fake gateway. */
  get gatewayClientCount(): number {
    return this.gatewayClients.size;
  }

  /** Sends a dispatch (`op 0`) to every gateway client. */
  gatewayDispatch(t: string, d: unknown): void {
    for (const c of this.gatewayClients) {
      c.seq += 1;
      c.ws.send(JSON.stringify({ op: 0, t, s: c.seq, d }));
    }
  }

  /** Sends a raw payload to every gateway client (Reconnect, Invalid Session). */
  gatewaySend(payload: Record<string, unknown>): void {
    for (const c of this.gatewayClients) c.ws.send(JSON.stringify(payload));
  }

  /** Drops every gateway connection with `code`. */
  gatewayDrop(code = 4000): void {
    for (const c of this.gatewayClients) c.ws.close(code, 'dropped');
    this.gatewayClients.clear();
  }

  /**
   * A button press: sends `INTERACTION_CREATE` for a message component with `custom_id`.
   *
   * @returns The interaction id (its callback lands on `/interactions/<id>/<token>/callback`).
   */
  discordPress(customId: string, options: { userId?: string; channelId?: string } = {}): string {
    const id = String(this.next());
    this.gatewayDispatch('INTERACTION_CREATE', {
      id,
      application_id: FAKE_DISCORD.applicationId,
      type: 3,
      token: `itoken${id}`,
      channel_id: options.channelId ?? FAKE_DISCORD.channelId,
      guild_id: FAKE_DISCORD.guildId,
      member: {
        user: {
          id: options.userId ?? FAKE_DISCORD.userId,
          username: 'operator',
          global_name: 'Op Erator',
        },
      },
      data: { custom_id: customId, component_type: 2 },
    });
    return id;
  }

  /** Publishes to an ntfy topic as a phone's `http` action does (`POST /<topic>`, text body). */
  ntfyPost(topic: string, text: string): Record<string, unknown> {
    const message = {
      id: `m${this.next()}`,
      time: Math.floor(Date.now() / 1000),
      event: 'message',
      topic,
      message: text,
    };
    this.push(topic, message);
    return message;
  }

  private gatewayOpen(ws: GatewayClient['ws']): void {
    this.gatewayConnections += 1;
    const client: GatewayClient = { ws, seq: 0 };
    this.gatewayClients.add(client);
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: this.gatewayHeartbeatMs } }));
  }

  private gatewayMessage(ws: GatewayClient['ws'], text: string): void {
    const frame = JSON.parse(text) as GatewayFrame;
    this.gatewayFrames.push(frame);
    const client = [...this.gatewayClients].find((c) => c.ws === ws);
    if (client === undefined) return;
    if (frame.op === 1 && this.gatewayAcks) ws.send(JSON.stringify({ op: 11 }));
    if (frame.op === 2) {
      client.seq += 1;
      ws.send(
        JSON.stringify({
          op: 0,
          t: 'READY',
          s: client.seq,
          d: {
            session_id: `session${this.gatewayConnections}`,
            resume_gateway_url: `ws://127.0.0.1:${this.server?.port ?? 0}/discord/gateway`,
            user: { id: FAKE_DISCORD.botId, username: 'bh_bot' },
          },
        }),
      );
    }
    if (frame.op === 6) {
      client.seq = Number((frame.d as { seq?: number }).seq ?? 0) + 1;
      ws.send(JSON.stringify({ op: 0, t: 'RESUMED', s: client.seq, d: {} }));
    }
  }

  /** Queues answers for the next calls of `route` (after them, the default success). */
  script(route: RouteKey, ...answers: ScriptedAnswer[]): void {
    this.scripts.set(route, [...(this.scripts.get(route) ?? []), ...answers]);
  }

  /** Requests to one platform. */
  of(platform: RecordedRequest['platform']): RecordedRequest[] {
    return this.requests.filter((r) => r.platform === platform);
  }

  /** Messages the ntfy fake holds for a topic (what `GET /<topic>/json?poll=1` returns). */
  ntfyTopic(topic: string): readonly Record<string, unknown>[] {
    return this.ntfyMessages.get(topic) ?? [];
  }

  private next(): number {
    this.counter += 1;
    return this.counter;
  }

  private async record(
    req: Request,
    platform: RecordedRequest['platform'],
    path: string,
  ): Promise<RecordedRequest> {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const type = req.headers.get('content-type') ?? '';
    let json: unknown = null;
    let form: Record<string, string> | null = null;
    const files: { field: string; name: string; type: string; size: number }[] = [];
    let bytes = 0;
    let raw = '';
    if (type.includes('multipart/form-data')) {
      const data = await req.formData();
      form = {};
      for (const [field, value] of data.entries()) {
        const entry: unknown = value;
        if (typeof entry === 'string') form[field] = entry;
        else if (entry instanceof File) {
          files.push({ field, name: entry.name, type: entry.type, size: entry.size });
        }
      }
      if (form['payload_json'] !== undefined) json = JSON.parse(form['payload_json']);
    } else if (type.includes('application/json')) {
      raw = await req.text();
      json = raw === '' ? null : JSON.parse(raw);
    } else if (req.method !== 'GET' && req.method !== 'DELETE') {
      bytes = (await req.arrayBuffer()).byteLength;
    }
    const recorded: RecordedRequest = {
      platform,
      method: req.method,
      path,
      query: Object.fromEntries(url.searchParams),
      headers,
      json,
      form,
      files,
      bytes,
      raw,
    };
    this.requests.push(recorded);
    return recorded;
  }

  private scripted(route: RouteKey): ScriptedAnswer | undefined {
    const queue = this.scripts.get(route);
    return queue?.shift();
  }

  private async answer(
    route: RouteKey,
    fallback: () => Response | Promise<Response>,
  ): Promise<Response> {
    const script = this.scripted(route);
    if (script === undefined) return fallback();
    if ('hang' in script) return new Promise<Response>(() => undefined);
    return Response.json(script.body ?? {}, {
      status: script.status,
      ...(script.headers !== undefined && { headers: script.headers }),
    });
  }

  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path.startsWith('/tg/bot')) return this.telegram(req, path);
    if (path.startsWith('/api/webhooks/')) return this.discord(req, path);
    if (path.startsWith('/discord/api/v10/')) {
      return this.discordBot(req, path.slice('/discord/api/v10'.length));
    }
    if (path.startsWith('/ntfy')) return this.ntfy(req, path.slice('/ntfy'.length) || '/');
    if (path.startsWith('/hook')) {
      await this.record(req, 'webhook', path);
      return this.answer('webhook', () => new Response(null, { status: 204 }));
    }
    return new Response('not found', { status: 404 });
  }

  private async telegram(req: Request, path: string): Promise<Response> {
    const method = path.split('/').pop() ?? '';
    const recorded = await this.record(req, 'telegram', method);
    const body = (recorded.json ?? recorded.form ?? {}) as Record<string, unknown>;
    return this.answer(`telegram:${method}`, () => {
      const chat = { id: Number(body['chat_id'] ?? 0) || String(body['chat_id']), type: 'private' };
      switch (method) {
        case 'getMe':
          return Response.json({
            ok: true,
            result: { id: 1234, is_bot: true, username: 'bh_test_bot' },
          });
        case 'getUpdates': {
          const offset = Number(body['offset'] ?? 0);
          const pending = this.updates.filter((u) => u.update_id >= offset);
          if (pending.length > 0) return Response.json({ ok: true, result: pending });
          return new Promise<Response>((resolve) =>
            setTimeout(() => resolve(Response.json({ ok: true, result: [] })), 30),
          );
        }
        case 'sendMessage':
          return Response.json({
            ok: true,
            result: { message_id: this.next(), chat, text: body['text'] },
          });
        case 'sendRichMessage': {
          const rich = parseRich(body['rich_message']);
          return Response.json({
            ok: true,
            result: {
              message_id: this.next(),
              chat,
              rich_message: {
                blocks: rich?.media === undefined ? [] : [{ type: 'photo', photo: RICH_PHOTOS }],
              },
            },
          });
        }
        case 'answerCallbackQuery':
          return Response.json({ ok: true, result: true });
        case 'sendPhoto':
          return Response.json({
            ok: true,
            result: {
              message_id: this.next(),
              chat,
              photo: [{ file_id: 'p1', width: 1280, height: 720 }],
            },
          });
        case 'editMessageText':
        case 'editMessageCaption': {
          const rich = parseRich(body['rich_message']);
          return Response.json({
            ok: true,
            result: {
              message_id: Number(body['message_id']),
              chat,
              ...(rich !== null && {
                rich_message: {
                  blocks: rich.media === undefined ? [] : [{ type: 'photo', photo: RICH_PHOTOS }],
                },
              }),
            },
          });
        }
        case 'deleteMessage':
          return Response.json({ ok: true, result: true });
        default:
          return Response.json(
            { ok: false, error_code: 404, description: 'Not Found' },
            { status: 404 },
          );
      }
    });
  }

  private async discord(req: Request, path: string): Promise<Response> {
    const parts = path.split('/');
    // /api/webhooks/<id>/<token>[/messages/<mid>]
    const messageId = parts[6];
    const recorded = await this.record(req, 'discord', parts.slice(5).join('/'));
    return this.answer(`discord:${req.method}`, () => {
      if (req.method === 'DELETE') return new Response(null, { status: 204 });
      const id = messageId ?? String(this.next());
      const attachments = recorded.files.map((f, i) => ({ id: `90${i}${id}`, filename: f.name }));
      const kept =
        (recorded.json as { attachments?: { id: string | number }[] } | null)?.attachments ?? [];
      return Response.json({
        id,
        channel_id: '42',
        attachments: [
          ...kept
            .filter((a) => typeof a.id === 'string')
            .map((a) => ({ id: a.id, filename: 'screenshot.jpg' })),
          ...attachments,
        ],
      });
    });
  }

  private async ntfy(req: Request, path: string): Promise<Response> {
    const recorded = await this.record(req, 'ntfy', path);
    const segments = path.split('/').filter(Boolean);
    if (req.method === 'GET') {
      const topic = segments[0] ?? '';
      const since = recorded.query['since'];
      const all = this.ntfyTopic(topic);
      const index = since === undefined ? -1 : all.findIndex((m) => m['id'] === since);
      const cached =
        since === undefined
          ? all
          : index >= 0
            ? all.slice(index + 1)
            : all.filter((m) => Number(m['time'] ?? 0) >= Number(since));
      const lines = cached.map((m) => JSON.stringify(m));
      if (recorded.query['poll'] === '1') {
        return new Response(lines.join('\n'), {
          headers: { 'content-type': 'application/x-ndjson' },
        });
      }
      return this.answer('ntfy:SUBSCRIBE', () => {
        const encoder = new TextEncoder();
        let push: ((line: string) => void) | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start: (controller) => {
            const open = JSON.stringify({ id: `o${this.next()}`, event: 'open', topic });
            controller.enqueue(encoder.encode(`${open}\n`));
            for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`));
            push = (line) => {
              try {
                controller.enqueue(encoder.encode(`${line}\n`));
              } catch {
                // closed
              }
            };
            const set = this.ntfySubscribers.get(topic) ?? new Set();
            set.add(push);
            this.ntfySubscribers.set(topic, set);
          },
          cancel: () => {
            if (push !== undefined) this.ntfySubscribers.get(topic)?.delete(push);
          },
        });
        return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } });
      });
    }
    return this.answer(`ntfy:${req.method}`, () => {
      if (req.method === 'DELETE') {
        const [topic = '', sequence = ''] = segments;
        this.push(topic, {
          id: `d${this.next()}`,
          event: 'message_delete',
          topic,
          sequence_id: sequence,
        });
        return Response.json({ id: `d${this.counter}`, event: 'message_delete' });
      }
      const body = (recorded.json ?? {}) as Record<string, unknown>;
      const topic = String(req.method === 'PUT' ? (segments[0] ?? '') : (body['topic'] ?? ''));
      const sequence =
        req.method === 'PUT'
          ? (segments[1] ?? recorded.headers['x-sequence-id'])
          : body['sequence_id'];
      const message: Record<string, unknown> = {
        id: `m${this.next()}`,
        event: 'message',
        topic,
        ...(sequence !== undefined && { sequence_id: sequence }),
        ...(req.method === 'PUT'
          ? {
              title: recorded.query['title'],
              message: recorded.query['message'],
              attachment: { name: recorded.query['filename'] ?? 'file', size: recorded.bytes },
            }
          : { title: body['title'], message: body['message'] }),
      };
      this.push(topic, message);
      return Response.json(message);
    });
  }

  private push(topic: string, message: Record<string, unknown>): void {
    const stamped = { time: Math.floor(Date.now() / 1000), ...message };
    this.ntfyMessages.set(topic, [...this.ntfyTopic(topic), stamped]);
    for (const push of this.ntfySubscribers.get(topic) ?? []) push(JSON.stringify(stamped));
  }

  /** Drops every open ntfy subscription (a lost connection). */
  ntfyDrop(): void {
    this.ntfySubscribers.clear();
  }

  private async discordBot(req: Request, path: string): Promise<Response> {
    const recorded = await this.record(req, 'discord-bot', path);
    const segments = path.split('/').filter(Boolean);
    return this.answer(`discord-bot:${req.method} ${segments[0] ?? ''}`, () => {
      const ids = FAKE_DISCORD;
      if (path === '/gateway/bot') {
        return Response.json({
          url: `ws://127.0.0.1:${this.server?.port ?? 0}/discord/gateway`,
          shards: 1,
        });
      }
      if (path === '/users/@me') return Response.json({ id: ids.botId, username: 'bh_bot' });
      if (path === '/applications/@me') return Response.json({ id: ids.applicationId });
      if (path === '/users/@me/guilds') return Response.json([{ id: ids.guildId, name: 'Home' }]);
      if (segments[0] === 'guilds' && segments[2] === 'channels') {
        return Response.json([
          { id: ids.categoryId, type: 4, name: 'Alerts', position: 1 },
          {
            id: ids.channelId,
            type: 0,
            name: 'browserhive',
            parent_id: ids.categoryId,
            position: 2,
          },
          { id: '300000000000000005', type: 2, name: 'Voice', position: 3 },
          { id: '300000000000000006', type: 5, name: 'news', position: 0 },
        ]);
      }
      if (segments[0] === 'interactions') return new Response(null, { status: 204 });
      if (segments[0] === 'webhooks') return Response.json({ id: 'followup' });
      if (segments[0] === 'channels' && segments[2] === 'messages') {
        if (req.method === 'DELETE') return new Response(null, { status: 204 });
        const id = segments[3] ?? String(this.next());
        const attachments = recorded.files.map((f, i) => ({ id: `90${i}${id}`, filename: f.name }));
        const kept =
          (recorded.json as { attachments?: { id: string | number }[] } | null)?.attachments ?? [];
        return Response.json({
          id,
          channel_id: segments[1],
          attachments: [
            ...kept
              .filter((a) => typeof a.id === 'string')
              .map((a) => ({ id: a.id, filename: 'screenshot.jpg' })),
            ...attachments,
          ],
        });
      }
      return Response.json({ message: 'Unknown', code: 0 }, { status: 404 });
    });
  }
}

/** Photo sizes a sent Rich Message reports (the largest `file_id` is re-used by edits). */
const RICH_PHOTOS = [
  { file_id: 'rp-small', width: 320, height: 180 },
  { file_id: 'rp-large', width: 1280, height: 720 },
];

/** `rich_message` of a JSON body, or of a multipart field (a JSON string). */
function parseRich(value: unknown): { html?: string; media?: unknown } | null {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as { html?: string; media?: unknown };
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === 'object' ? (value as { html?: string }) : null;
}
