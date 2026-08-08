/**
 * Request/response types for the Cleanverse cooperate API, per
 * docs/CLEANVERSE_API.md (cross-checked against docs/cleanverse.pdf, v5.6).
 *
 * Field names and shapes here are transcribed from the PDF, not invented.
 * Where the PDF's response schema wasn't fully captured (e.g. generate_apass
 * beyond customerId/cvRecordId), the type is deliberately narrow rather than
 * padded with guessed fields, see docs/CLEANVERSE_API.md for the specific
 * gaps.
 */

/** Chain slugs accepted by generate_apass's wallet.chain field (PDF p.8-14). */
export type CleanverseChain =
  | "solana"
  | "base"
  | "avalanche"
  | "arbitrum"
  | "ethereum"
  | "polygon"
  | "bsc"
  | "monad"
  | "hashkey"
  | "platon";

/** Every Cleanverse response envelope shares this shape. */
export interface CleanverseEnvelope<TData> {
  code: string;
  message: string;
  data: TData;
}

/** 1 = active, 2 = frozen, used by query_apass/query_apass_list `status` and update_status's request. */
export type ApassStatusCode = 1 | 2;

// ---------------------------------------------------------------------------
// query_apass
// ---------------------------------------------------------------------------

export interface QueryApassParams {
  chain: string;
  address: string;
}

export interface QueryApassData {
  cvRecordId: string;
  subTier: number;
  tier: string;
  /**
   * Documented as always 1|2, but docs/TIER_DISTRIBUTION.md found real
   * `query_apass_list` records with `status: null` in the sandbox (92.3% of
   * 142 records), not yet confirmed absent from the singular `query_apass`
   * endpoint too (only 5 addresses sampled so far, see
   * docs/OPEN_QUESTIONS.md item 7). Widened defensively rather than
   * assumed well-formed; callers must treat non-1/2 values (including
   * null) as unknown, not active.
   */
  status: ApassStatusCode | null;
  expirationTime: number | null;
  subGroup: string;
  currentKycHash: string;
  group: string;
  countries: string[];
}

// ---------------------------------------------------------------------------
// query_apass_list
// ---------------------------------------------------------------------------

export interface QueryApassListParams {
  customerId?: string;
  chain?: string;
  walletAddress?: string;
  status?: ApassStatusCode;
  page?: number;
  pageSize?: number;
  createdFrom?: string; // YYYY-MM-DD
  createdTo?: string; // YYYY-MM-DD, inclusive
}

export interface ApassListItem {
  cvRecordId: string;
  customerId: string;
  chain: string;
  walletAddress: string;
  /** Solana-only on-chain A-Pass PDA address; empty/omitted on EVM chains. */
  apassAddress?: string;
  status: ApassStatusCode;
  tier: string;
  subTier: number;
  group: string;
  subGroup: string;
  countries: string[];
  expirationTime: number;
  txHash: string;
  registeredAt: string; // YYYY-MM-DDTHH:mm:ss
}

export interface QueryApassListData {
  total: number;
  page: number;
  pageSize: number;
  items: ApassListItem[];
}

// ---------------------------------------------------------------------------
// validator/verify, is_register, rules, is_paused
// ---------------------------------------------------------------------------

export interface ValidatorVerifyParams {
  chain: string;
  contract_address: string;
  user_address: string;
}

export interface ValidatorVerifyData {
  chain: string;
  contract_address: string;
  user_address: string;
  valid: boolean;
}

export interface ValidatorIsRegisterParams {
  chain: string;
  contract_address: string;
}

export interface ValidatorIsRegisterData {
  chain: string;
  contract_address: string;
  registered: boolean;
}

/** Compliance rule object used by register/set_rule/add_rule and returned by rules. */
export interface ComplianceRule {
  allowed_group: string;
  allowed_sub_group: string;
  min_tier: number;
  min_sub_tier: number;
  is_black_list?: boolean;
  countries?: string[];
}

export interface ValidatorRulesParams {
  chain: string;
  contract_address: string;
}

export interface ValidatorRulesData {
  chain: string;
  contract_address: string;
  rules: ComplianceRule[];
}

export interface ValidatorIsPausedParams {
  chain: string;
  contract_address: string;
}

export interface ValidatorIsPausedData {
  chain: string;
  contract_address: string;
  paused: boolean;
}

// ---------------------------------------------------------------------------
// validator/register, grant, set_rule, add_rule, remove_rule, set_paused (encrypted)
// ---------------------------------------------------------------------------

export interface ValidatorRegisterParams {
  chain: string;
  contract_address: string;
  rule: ComplianceRule;
  /** EIP-191 sig over chain + contract_address, see signature.ts. */
  owner_signature: `0x${string}`;
}

export interface ValidatorRegisterData {
  chain: string;
  contract_address: string;
  tx_hash: string;
}

export interface ValidatorGrantParams {
  chain: string;
  address: string;
  /** EIP-191 sig over chain + address, see signature.ts. */
  owner_signature: `0x${string}`;
}

export interface ValidatorGrantData {
  chain: string;
  address: string;
  tx_hash: string;
}

export interface ValidatorSetRuleParams {
  chain: string;
  contract_address: string;
  rule: ComplianceRule;
}

export interface ValidatorSetRuleData {
  chain: string;
  contract_address: string;
  rule: ComplianceRule;
  tx_hash: string;
}

export interface ValidatorAddRuleParams {
  chain: string;
  contract_address: string;
  rule: ComplianceRule;
}

export interface ValidatorAddRuleData {
  chain: string;
  contract_address: string;
  rule: ComplianceRule;
  tx_hash: string;
}

export interface ValidatorRemoveRuleParams {
  chain: string;
  contract_address: string;
  index: number;
}

export interface ValidatorRemoveRuleData {
  chain: string;
  contract_address: string;
  index: number;
  tx_hash: string;
}

export interface ValidatorSetPausedParams {
  chain: string;
  contract_address: string;
  paused: boolean;
}

export interface ValidatorSetPausedData {
  chain: string;
  contract_address: string;
  paused: boolean;
  tx_hash: string;
}

// ---------------------------------------------------------------------------
// update_status (encrypted)
// ---------------------------------------------------------------------------

export interface UpdateStatusWallet {
  chain: string;
  address: string;
}

export interface UpdateStatusParams {
  customerId?: string;
  cvRecordId?: string;
  /** "1" = activate/unfreeze, "2" = freeze. */
  status: "1" | "2";
  blacklistReason?: string;
  wallet: UpdateStatusWallet;
}

export interface UpdateStatusData {
  txHash: string;
}

// ---------------------------------------------------------------------------
// generate_apass (encrypted), response schema only partially captured, see docs/CLEANVERSE_API.md
// ---------------------------------------------------------------------------

export interface GenerateApassWallet {
  address: string;
  chain: CleanverseChain;
}

export interface GenerateApassIdentityData {
  idType: "ID_CARD" | "PASSPORT" | "DRIVER_LICENSE" | "HK_MACAO_TAIWAN_PASS" | "RESIDENCE_PERMIT";
  fullName: string;
  idNumber?: string;
  validUntil?: string; // yyyy-MM-dd
  issuingCountryISO2: string;
}

export interface GenerateApassBankAccount {
  bankCountry: string;
  bankName: string;
  bankAccount?: string;
  bankAccountType?: "C" | "D" | "A";
  balance?: number;
  currency?: string;
}

export interface GenerateApassParams {
  customerId: string; // >= 12 chars, [A-Za-z0-9] only
  kycSource?: string;
  kycId?: string;
  /**
   * Documented in docs/cleanverse.pdf as an integer 1-99, but CONFIRMED
   * (Telegram, a Cleanverse team member, and re-confirmed empirically this
   * session, see docs/DESIGN_A_SPIKE.md/docs/OPEN_QUESTIONS.md) that the
   * live sandbox requires this as a STRING. Passing a number returns
   * `code: "0000"` (a real transaction hash) but SILENTLY IGNORES subTier,
   * the resulting A-Pass gets no subTier or a default one. Always pass a
   * numeric string here (e.g. "80", not 80), and verify it actually took
   * via query_apass (singular) afterward, never trust this call's success
   * response alone.
   */
  subTier?: string; // 1-99, as a STRING, see above
  subGroup?: string; // 2 letters, case-sensitive
  override?: boolean; // default false
  expirationTime: number; // unix seconds
  wallet: GenerateApassWallet;
  identityDataList?: GenerateApassIdentityData[];
  bankAccountList?: GenerateApassBankAccount[];
}

/**
 * Only customerId/cvRecordId are confirmed from the PDF extraction, see
 * docs/CLEANVERSE_API.md's generate_apass section for the gap. Do not add
 * fields here until they're confirmed against the PDF directly.
 */
export interface GenerateApassData {
  customerId: string;
  cvRecordId: string;
}

// ---------------------------------------------------------------------------
// atoken/list_my_atokens (plain, GET query params)
// ---------------------------------------------------------------------------

export type AtokenApplyStatus =
  | "PENDING"
  | "APPROVED"
  | "ISSUING"
  | "ISSUED"
  | "REJECTED"
  | "ISSUE_FAILED";

export type AtokenFlowType = "LAUNCH" | "LAUNCH_WRAPPED" | "REGISTER_ATOKEN" | "REGISTER_WRAPPED";

export interface ListMyAtokensParams {
  page?: number;
  page_size?: number;
  chain?: string;
  apply_status?: AtokenApplyStatus;
  flow_type?: AtokenFlowType;
}

export interface AtokenListItem {
  flowType: AtokenFlowType;
  requestId: string;
  applyStatus: AtokenApplyStatus;
  chain: string;
  atokenAddress: string;
  originTokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  txHash: string;
  issuedAt: string;
  createTime: string;
}

export interface ListMyAtokensData {
  total: number;
  page: number;
  pageSize: number;
  items: AtokenListItem[];
}

// ---------------------------------------------------------------------------
// faucet, NOT fully specified in the PDF extraction (only a rate-limit
// error fragment was found, no field-level request/response spec). Do not
// invent fields here: params is a caller-supplied bag, passed through
// as-is, and the response shape is intentionally unknown. Re-check the
// PDF's faucet section (Common Queries) directly before treating this as
// more than a smoke-test call. See docs/CLEANVERSE_API.md and
// docs/OPEN_QUESTIONS.md.
// ---------------------------------------------------------------------------

export type FaucetParams = Record<string, unknown>;

export type FaucetData = unknown;
