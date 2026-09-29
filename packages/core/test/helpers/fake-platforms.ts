/** @module test/helpers/fake-platforms — one `Bun.serve` faking the Telegram Bot API (`/tg`), Discord webhooks (`/api/webhooks`), an ntfy server (`/ntfy`) and a plain webhook receiver (`/hook`) (spec 09 §4). Every request is recorded; failures are scripted per route. */

/** A request the fakes received. */
export interface RecordedRequest {
  readonly platform: 'telegram' | 'discord' | 'ntfy' | 'webhook';
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
}

/** Low-entropy fake credentials (gitleaks scans every commit). */
export const FAKE_TG_TOKEN = `1234:${'a'.repeat(35)}`;
/** Token part of the fake Discord webhook URL. */
export const FAKE_DISCORD_TOKEN = 'b'.repeat(24);

/**
 * The fakes. `start()` binds an ephemeral port; `stop()` releases it (hanging requests included).
 */
export class FakePlatforms {
  readonly requests: RecordedRequest[] = [];
  readonly updates: FakeUpdate[] = [];
  private readonly scripts = new Map<RouteKey, ScriptedAnswer[]>();
  private readonly ntfyMessages = new Map<string, Record<string, unknown>[]>();
  private server: ReturnType<typeof Bun.serve> | undefined;
  private counter = 100;

  /** Starts the server. */
  start(): this {
    this.server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (req) => this.handle(req) });
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
        case 'editMessageCaption':
          return Response.json({
            ok: true,
            result: { message_id: Number(body['message_id']), chat },
          });
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
      const lines = this.ntfyTopic(topic).map((m) => JSON.stringify(m));
      return new Response(lines.join('\n'), {
        headers: { 'content-type': 'application/x-ndjson' },
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
    this.ntfyMessages.set(topic, [...this.ntfyTopic(topic), message]);
  }
}
