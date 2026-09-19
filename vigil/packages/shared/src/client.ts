import { z } from 'zod';
import {
  RegisterRequest, CreateTriggerRequest, WorkflowSchema, CreateVaultRequest,
  CreateVaultItemRequest, CreateRecipientRequest, CreateGrantRequest,
  CheckInRequest, PauseTriggerRequest, WellbeingAnswerRequest,
  StoredIdentitySchema, TriggerStatusSchema,
} from './schemas.js';

/**
 * The typed client the app talks to the server through.
 *
 * Lives in @vigil/shared rather than in the app so that the API's own test
 * suite can drive it against the real routes. A client tested only by
 * typechecking is a client that agrees with the server about types and nothing
 * else — and every interesting disagreement between the two is about status
 * codes, field names and error shapes, none of which a type will catch.
 *
 * `fetchImpl` is injectable for exactly that reason: the contract test points
 * it at the Fastify instance in-process.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the server refused a workflow or grant as unsafe. */
  get isSafetyRefusal(): boolean {
    return this.code === 'unsafe_workflow' || this.code === 'unsafe_grant';
  }
}

const MeResponse = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  identity: StoredIdentitySchema,
  publicKey: z.string(),
});

const TriggerListItem = z.object({
  id: z.string(),
  name: z.string(),
  status: TriggerStatusSchema,
  workflow: WorkflowSchema,
  currentStepId: z.string().nullable(),
  lastCheckInAt: z.string(),
  nextCheckInDueAt: z.string(),
  earliestDeliveryAt: z.string(),
  summary: z.string(),
});

const IssueSchema = z.object({ severity: z.enum(['error', 'warning']), at: z.string(), message: z.string() });

const PreviewResponse = z.object({
  issues: z.array(IssueSchema),
  summary: z.string(),
  timeline: z.array(z.object({
    at: z.number(), atIso: z.string(), kind: z.string(), stepId: z.string(),
    title: z.string(), detail: z.string(), involvesOthers: z.boolean(),
  })),
});

const Created = z.object({ id: z.string() });
const AuthResponse = z.object({ token: z.string(), userId: z.string() });

export interface ClientOptions {
  baseUrl: string;
  /** Injected so tests can drive the real routes in-process. */
  fetchImpl?: typeof fetch;
  /** Called whenever the server hands back a new session token. */
  onToken?: (token: string | null) => void;
  token?: string | null;
}

export class VigilClient {
  private token: string | null;

  constructor(private readonly opts: ClientOptions) {
    this.token = opts.token ?? null;
  }

  setToken(token: string | null) {
    this.token = token;
    this.opts.onToken?.(token);
  }

  get authenticated(): boolean {
    return this.token !== null;
  }

  private async request<T extends z.ZodTypeAny>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    schema: T,
    body?: unknown,
  ): Promise<z.infer<T>> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const res = await doFetch(`${this.opts.baseUrl}${path}`, {
      method,
      headers: {
        // Only declare a JSON body when there is one: a GET carrying
        // content-type with no payload is rejected outright by some servers.
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await res.text();
    const json: unknown = text ? JSON.parse(text) : {};

    if (!res.ok) {
      const e = json as { error?: string; message?: string; issues?: unknown };
      // A 401 means this session is over; drop the token rather than letting
      // the app retry forever with a credential the server has stopped honouring.
      if (res.status === 401) this.setToken(null);
      throw new ApiError(
        res.status,
        e.error ?? 'error',
        e.message ?? e.error ?? `request failed with ${res.status}`,
        e.issues,
      );
    }
    return schema.parse(json);
  }

  /* ------------------------------- identity ------------------------------ */

  async register(input: z.input<typeof RegisterRequest>) {
    const r = await this.request('POST', '/v1/auth/register', AuthResponse, RegisterRequest.parse(input));
    this.setToken(r.token);
    return r;
  }

  /** The wrapped identity blob, for restoring onto a new device. */
  me() {
    return this.request('GET', '/v1/me', MeResponse);
  }

  /* -------------------------------- triggers ----------------------------- */

  previewWorkflow(workflow: z.input<typeof WorkflowSchema>, contactNames: Record<string, string> = {}) {
    return this.request('POST', '/v1/triggers/preview', PreviewResponse, { workflow, contactNames });
  }

  /**
   * Arm a trigger.
   *
   * Throws `ApiError` with `isSafetyRefusal` when the server judges the
   * workflow unsafe — the app should show `issues` rather than a generic
   * failure, because those messages are written for the person reading them.
   */
  async createTrigger(input: z.input<typeof CreateTriggerRequest>) {
    return this.request(
      'POST', '/v1/triggers',
      z.object({ id: z.string(), warnings: z.array(IssueSchema) }),
      CreateTriggerRequest.parse(input),
    );
  }

  triggers() {
    return this.request('GET', '/v1/triggers', z.array(TriggerListItem));
  }

  checkIn(triggerId: string, source: z.input<typeof CheckInRequest>['source'] = 'APP') {
    return this.request(
      'POST', '/v1/check-in',
      z.object({ status: z.string(), nextCheckInDueAt: z.string() }),
      { triggerId, source },
    );
  }

  pause(triggerId: string, untilIso: string | null = null) {
    return this.request(
      'POST', '/v1/triggers/pause', z.object({ status: z.string() }),
      PauseTriggerRequest.parse({ triggerId, untilIso }),
    );
  }

  resume(triggerId: string) {
    return this.request('POST', '/v1/triggers/resume', z.object({ status: z.string() }), { triggerId });
  }

  cancel(triggerId: string) {
    return this.request('DELETE', `/v1/triggers/${triggerId}`, z.object({ status: z.string() }));
  }

  /* --------------------------- vaults & recipients ----------------------- */

  createVault(input: z.input<typeof CreateVaultRequest>) {
    return this.request('POST', '/v1/vaults', Created, CreateVaultRequest.parse(input));
  }

  createVaultItem(vaultId: string, input: z.input<typeof CreateVaultItemRequest>) {
    return this.request('POST', `/v1/vaults/${vaultId}/items`, Created, CreateVaultItemRequest.parse(input));
  }

  createRecipient(input: z.input<typeof CreateRecipientRequest>) {
    return this.request('POST', '/v1/recipients', Created, CreateRecipientRequest.parse(input));
  }

  recipients() {
    return this.request(
      'GET', '/v1/recipients',
      z.array(z.object({ id: z.string(), displayName: z.string(), isVerifier: z.boolean() })),
    );
  }

  createGrant(input: z.input<typeof CreateGrantRequest>) {
    return this.request('POST', '/v1/grants', Created, CreateGrantRequest.parse(input));
  }

  /* ---------------------------- public endpoints -------------------------- */

  /** Unauthenticated: the person answering holds a one-time link, not an account. */
  answerWellbeing(input: z.input<typeof WellbeingAnswerRequest>) {
    return this.request(
      'POST', '/v1/wellbeing',
      z.object({ recorded: z.boolean(), message: z.string() }),
      WellbeingAnswerRequest.parse(input),
    );
  }

  audit() {
    return this.request(
      'GET', '/v1/audit',
      z.array(z.object({ at: z.string(), kind: z.string(), summary: z.string() })),
    );
  }
}
