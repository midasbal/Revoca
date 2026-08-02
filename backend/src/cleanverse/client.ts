/**
 * Cleanverse cooperate API client.
 *
 * Stack note: native `fetch` (Node 20+ has it built in, no HTTP library
 * dependency needed).
 *
 * Endpoint paths, field names, and encrypted/plain classification are all
 * transcribed from docs/cleanverse.pdf (cross-checked; see
 * docs/CLEANVERSE_API.md for the full distillation and any gaps).
 *
 * Error model (see errors.ts), three distinct cases, not conflated:
 *   1. Non-2xx HTTP -> CleanverseTransportError.
 *   2. HTTP 200 but `code !== "0000"` -> CleanverseApiError.
 *   3. A legitimate negative business result (e.g. validator/verify's
 *      `valid: false` under code "0000") is NOT an error, returned normally.
 *
 * Mutations are never retried automatically. Reads may retry once, and only
 * on a network-level failure (fetch throwing), never on an HTTP error status
 * or a business-error code.
 */
import { randomUUID } from "node:crypto";
import type { CleanverseConfig } from "./config.js";
import { decryptBody, encryptBody, type IvMode } from "./crypto.js";
import { CleanverseApiError, CleanverseResponseShapeError, CleanverseTransportError } from "./errors.js";
import type {
  AtokenListItem,
  CleanverseEnvelope,
  FaucetData,
  FaucetParams,
  GenerateApassData,
  GenerateApassParams,
  ListMyAtokensData,
  ListMyAtokensParams,
  QueryApassData,
  QueryApassListData,
  QueryApassListParams,
  QueryApassParams,
  UpdateStatusData,
  UpdateStatusParams,
  ValidatorAddRuleData,
  ValidatorAddRuleParams,
  ValidatorGrantData,
  ValidatorGrantParams,
  ValidatorIsPausedData,
  ValidatorIsPausedParams,
  ValidatorIsRegisterData,
  ValidatorIsRegisterParams,
  ValidatorRegisterData,
  ValidatorRegisterParams,
  ValidatorRemoveRuleData,
  ValidatorRemoveRuleParams,
  ValidatorRulesData,
  ValidatorRulesParams,
  ValidatorSetPausedData,
  ValidatorSetPausedParams,
  ValidatorSetRuleData,
  ValidatorSetRuleParams,
  ValidatorVerifyData,
  ValidatorVerifyParams,
} from "./types.js";

type BodyMode = "none" | "plain" | "encrypted";
type HttpMethod = "GET" | "POST";

interface RequestOptions<TParams> {
  path: string;
  method?: HttpMethod;
  bodyMode?: BodyMode;
  body?: TParams;
  /** For GET requests only, serialized as a query string. */
  query?: Record<string, string | number | boolean | undefined>;
  /** Reads may set this true; mutations must never set it. */
  retryOnceOnNetworkError?: boolean;
  ivMode?: IvMode;
}

export class CleanverseClient {
  constructor(private readonly config: CleanverseConfig) {}

  private async request<TData>(opts: RequestOptions<unknown>): Promise<TData> {
    const method = opts.method ?? "POST";
    const bodyMode = opts.bodyMode ?? "plain";
    const requestId = randomUUID();
    const url = this.buildUrl(opts.path, opts.query);

    const headers: Record<string, string> = {
      "api-id": this.config.apiId,
      "X-Request-ID": requestId,
    };

    let payload: string | undefined;
    if (method === "POST" && bodyMode !== "none") {
      headers["Content-Type"] = "application/json";
      if (bodyMode === "encrypted") {
        payload = JSON.stringify({ data: encryptBody(opts.body, this.config.apiKey, opts.ivMode) });
      } else {
        payload = JSON.stringify(opts.body ?? {});
      }
    }

    const doFetch = () =>
      fetch(url, payload !== undefined ? { method, headers, body: payload } : { method, headers });

    let response: Response;
    try {
      response = await doFetch();
    } catch (networkError) {
      if (opts.retryOnceOnNetworkError) {
        response = await doFetch();
      } else {
        throw networkError;
      }
    }

    if (!response.ok) {
      const bodyText = await safeReadText(response);
      throw new CleanverseTransportError(response.status, response.statusText, requestId, bodyText);
    }

    let envelope: CleanverseEnvelope<unknown>;
    try {
      envelope = (await response.json()) as CleanverseEnvelope<unknown>;
    } catch {
      throw new CleanverseResponseShapeError(requestId, "response body was not valid JSON");
    }

    if (typeof envelope?.code !== "string") {
      throw new CleanverseResponseShapeError(requestId, `missing/invalid "code" field in response`);
    }

    if (envelope.code !== "0000") {
      throw new CleanverseApiError(envelope.code, envelope.message ?? "<no message>", requestId);
    }

    if (bodyMode === "encrypted") {
      if (typeof envelope.data !== "string") {
        throw new CleanverseResponseShapeError(
          requestId,
          `expected encrypted "data" to be a base64 string, got ${typeof envelope.data}`,
        );
      }
      return decryptBody<TData>(envelope.data, this.config.apiKey, opts.ivMode);
    }

    return envelope.data as TData;
  }

  private buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(`${this.config.sandboxUrl}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  // ---------------------------------------------------------------------
  // READ endpoints, plain JSON, safe to call, exercised by the live probe.
  // ---------------------------------------------------------------------

  async queryApass(params: QueryApassParams): Promise<QueryApassData> {
    return this.request<QueryApassData>({
      path: "/query_apass",
      body: params,
      retryOnceOnNetworkError: true,
    });
  }

  async queryApassList(params: QueryApassListParams): Promise<QueryApassListData> {
    return this.request<QueryApassListData>({
      path: "/query_apass_list",
      body: params,
      retryOnceOnNetworkError: true,
    });
  }

  async validatorVerify(params: ValidatorVerifyParams): Promise<ValidatorVerifyData> {
    // valid: false under code "0000" is a legitimate result, not an error,
    // the caller decides what a false verify means, this method just relays it.
    return this.request<ValidatorVerifyData>({
      path: "/validator/verify",
      body: params,
      retryOnceOnNetworkError: true,
    });
  }

  async validatorIsRegister(params: ValidatorIsRegisterParams): Promise<ValidatorIsRegisterData> {
    return this.request<ValidatorIsRegisterData>({
      path: "/validator/is_register",
      body: params,
      retryOnceOnNetworkError: true,
    });
  }

  async validatorRules(params: ValidatorRulesParams): Promise<ValidatorRulesData> {
    return this.request<ValidatorRulesData>({
      path: "/validator/rules",
      body: params,
      retryOnceOnNetworkError: true,
    });
  }

  async validatorIsPaused(params: ValidatorIsPausedParams): Promise<ValidatorIsPausedData> {
    return this.request<ValidatorIsPausedData>({
      path: "/validator/is_paused",
      body: params,
      retryOnceOnNetworkError: true,
    });
  }

  /**
   * GET /atoken/list_my_atokens, plain query params, not encrypted, despite
   * the PDF's endpoint index listing it under encrypted endpoints. Its
   * dedicated spec section (p.41-43) shows plain query params and no
   * request body, which a GET can't carry anyway. See docs/CLEANVERSE_API.md.
   */
  async listAtokens(params: ListMyAtokensParams): Promise<ListMyAtokensData> {
    return this.request<ListMyAtokensData>({
      path: "/atoken/list_my_atokens",
      method: "GET",
      bodyMode: "none",
      query: {
        page: params.page,
        page_size: params.page_size,
        chain: params.chain,
        apply_status: params.apply_status,
        flow_type: params.flow_type,
      },
      retryOnceOnNetworkError: true,
    });
  }

  /**
   * POST /faucet, under "Common Queries" per the role table, but the PDF's
   * field-level spec wasn't fully captured (only a rate-limit error
   * fragment was found, see docs/CLEANVERSE_API.md and
   * docs/OPEN_QUESTIONS.md item 5-adjacent gap). Treated as plain JSON since
   * it isn't in the PDF's encrypted-endpoint index. Calling this may dispense
   * real (albeit testnet) funds and consume a rate-limited allowance, do
   * not call speculatively; confirm the exact request fields against the PDF
   * first if this becomes load-bearing.
   */
  async faucet(params: FaucetParams): Promise<FaucetData> {
    return this.request<FaucetData>({
      path: "/faucet",
      body: params,
    });
  }

  // ---------------------------------------------------------------------
  // WRITE endpoints, encrypted, on-chain or A-Pass-management mutations.
  // UNTESTED THIS SESSION: our sandbox role is unconfirmed (see
  // docs/OPEN_QUESTIONS.md item 1). Implemented per the PDF spec but never
  // invoked against the live sandbox. Never retried automatically.
  // ---------------------------------------------------------------------

  /** UNTESTED: requires role confirmation (A-Pass Management). Encrypted body. */
  async generateApass(params: GenerateApassParams): Promise<GenerateApassData> {
    return this.request<GenerateApassData>({
      path: "/generate_apass",
      bodyMode: "encrypted",
      body: params,
    });
  }

  /** UNTESTED: requires role confirmation (A-Pass Management). Encrypted body. */
  async updateStatus(params: UpdateStatusParams): Promise<UpdateStatusData> {
    return this.request<UpdateStatusData>({
      path: "/update_status",
      bodyMode: "encrypted",
      body: params,
    });
  }

  /**
   * UNTESTED: requires role confirmation (Validator Compliance / Issue
   * Member only, per docs/CLEANVERSE_API.md#roles). Encrypted body +
   * owner_signature, build owner_signature via signature.ts's
   * ownerSignature(chain, contract_address, ownerAccount).
   */
  async validatorRegister(params: ValidatorRegisterParams): Promise<ValidatorRegisterData> {
    return this.request<ValidatorRegisterData>({
      path: "/validator/register",
      bodyMode: "encrypted",
      body: params,
    });
  }

  /**
   * UNTESTED: requires role confirmation (Validator Compliance / Issue
   * Member only). Encrypted body + owner_signature, build via
   * ownerSignature(chain, address, ownerAccount).
   */
  async validatorGrant(params: ValidatorGrantParams): Promise<ValidatorGrantData> {
    return this.request<ValidatorGrantData>({
      path: "/validator/grant",
      bodyMode: "encrypted",
      body: params,
    });
  }

  /** UNTESTED: requires role confirmation (Validator Compliance / Issue Member only). Encrypted body. */
  async validatorSetRule(params: ValidatorSetRuleParams): Promise<ValidatorSetRuleData> {
    return this.request<ValidatorSetRuleData>({
      path: "/validator/set_rule",
      bodyMode: "encrypted",
      body: params,
    });
  }

  /** UNTESTED: requires role confirmation (Validator Compliance / Issue Member only). Encrypted body. */
  async validatorAddRule(params: ValidatorAddRuleParams): Promise<ValidatorAddRuleData> {
    return this.request<ValidatorAddRuleData>({
      path: "/validator/add_rule",
      bodyMode: "encrypted",
      body: params,
    });
  }

  /** UNTESTED: requires role confirmation (Validator Compliance / Issue Member only). Encrypted body. */
  async validatorRemoveRule(params: ValidatorRemoveRuleParams): Promise<ValidatorRemoveRuleData> {
    return this.request<ValidatorRemoveRuleData>({
      path: "/validator/remove_rule",
      bodyMode: "encrypted",
      body: params,
    });
  }

  /** UNTESTED: requires role confirmation (Validator Compliance / Issue Member only). Encrypted body. */
  async validatorSetPaused(params: ValidatorSetPausedParams): Promise<ValidatorSetPausedData> {
    return this.request<ValidatorSetPausedData>({
      path: "/validator/set_paused",
      bodyMode: "encrypted",
      body: params,
    });
  }
}

// Re-exported so callers building dashboards/keepers can type atoken rows
// without reaching into ./types directly for this one item type.
export type { AtokenListItem };

async function safeReadText(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}
