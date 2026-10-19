export interface SessionState { graph: boolean; exchange: boolean; tenant: string; account: string }
export interface SignInQuery { user: string; start: string; end: string }
export interface SignIn {
  id: string; createdDateTime: string; userPrincipalName: string; appDisplayName: string;
  ipAddress: string; isInteractive: boolean; signInEventTypes?: string[];
  status?: { errorCode?: number; failureReason?: string };
  location?: { city?: string; countryOrRegion?: string };
  conditionalAccessStatus?: string;
  appliedConditionalAccessPolicies?: AppliedPolicy[] | null;
  [key: string]: unknown;
}
export interface AppliedPolicy {
  id?: string; displayName?: string; result?: string;
  enforcedGrantControls?: string[]; enforcedSessionControls?: string[];
  [key: string]: unknown;
}
export interface ConditionalAccessEvent {
  signInId: string; time: string; user: string; application: string; ip: string;
  overallStatus: string; availability: 'returned' | 'empty' | 'unavailable'; policies: AppliedPolicy[];
}
export interface ConditionalAccessReport { tenant: string; collectedAt: string; events: ConditionalAccessEvent[] }
export interface Collection { query: SignInQuery; tenant: string; collectedAt: string; rows: SignIn[] }
export interface DirectoryAudit {
  id: string; activityDateTime: string; activityDisplayName?: string; category?: string;
  result?: string; resultReason?: string; correlationId?: string; loggedByService?: string;
  initiatedBy?: { user?: { id?: string; userPrincipalName?: string; displayName?: string; ipAddress?: string }; app?: { servicePrincipalId?: string; appId?: string; displayName?: string } };
  targetResources?: { id?: string; userPrincipalName?: string; displayName?: string; type?: string; modifiedProperties?: { displayName?: string; oldValue?: string; newValue?: string }[] }[];
  [key: string]: unknown;
}
export type AuditCategory = 'password' | 'mfa' | 'roles' | 'consent' | 'devices' | 'groups' | 'other';
export interface AuditRecord { event: DirectoryAudit; relation: 'actor' | 'target' | 'both'; tags: AuditCategory[] }
export interface AuditCollection { query: SignInQuery; tenant: string; userId: string; collectedAt: string; records: AuditRecord[] }
export interface UalQuery extends SignInQuery { operations: string[] }
export interface UalFilters { search: string; includeIPs: string; excludeIPs: string; ipMode: 'all' | 'known' | 'unknown'; operation: string; workload: string; result: 'all' | 'success' | 'failure' | 'other' }
export interface UalRecord { id: string; time: string; operation: string; user: string; workload: string; recordType: string; clientIP: string; normalizedIPs: string[]; result: string; tone: 'success' | 'failure' | 'neutral'; object: string; parseError?: string; auditData: Record<string, any> | null; raw: Record<string, any> }
export interface UalCollection { query: UalQuery; tenant: string; collectedAt: string; records: UalRecord[]; retrieval: Record<string, any>; auditChecks: Record<string, any>[]; evidenceGaps: string[]; notes: string[] }
export interface UalView { records: UalRecord[]; total: number; matched: number; unknownIPs: number; page: number }
export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };
export type AuthMode = 'browser' | 'device';
export type IdentityKind = 'risk-detections' | 'devices' | 'app-consents';
export interface IdentityQuery extends SignInQuery { allRetained?: boolean }
export interface IdentityRow { key: string; source: 'risk' | 'risk-user' | 'risk-history' | 'risky-signin' | 'device' | 'grant' | 'audit'; values: Record<string, string>; flags: string[]; tone: 'neutral' | 'success' | 'warning' | 'failure'; raw: Record<string, any> }
export interface RiskSource { source: string; ok: boolean; count?: number; error?: string; checkedAt: string }
export interface IdentityResult { userId: string; userPrincipalName?: string; rows: any[]; relatedAudits?: DirectoryAudit[]; riskyUser?: Record<string, any> | null; riskHistory?: Record<string, any>[]; riskySignIns?: SignIn[]; riskSources?: RiskSource[] }
export interface IdentityCollection { kind: IdentityKind; query: IdentityQuery; userId: string; tenant: string; collectedAt: string; columns: string[]; rows: IdentityRow[]; coverage: string; riskSources?: RiskSource[] }
export type WorkspacePage = 'session' | 'sign-ins' | 'audit-logs' | IdentityKind | 'uals' | 'toolkit' | 'kql-library' | 'browser-history' | 'data-tools' | 'notepad' | 'settings';
export type UiAuditEvent =
  | { action: 'table_cell_toggle'; page: WorkspacePage; id: string; field: string; open: boolean }
  | { action: 'navigate'; page: WorkspacePage }
  | { action: 'nav_group_toggle'; group: 'entra' | 'm365'; open: boolean }
  | { action: 'record_view'; id: string }
  | { action: 'audit_record_view'; id: string }
  | { action: 'ual_record_view'; id: string }
  | { action: 'identity_results_view'; kind: IdentityKind; search: string; filter: string; page: number; keys: string[] }
  | { action: 'identity_record_view'; kind: IdentityKind; key: string }
  | { action: 'audit_results_view'; search: string; category: string; relation: string; result: string; page: number; ids: string[] }
  | { action: 'sign_in_selection'; ids: string[] }
  | { action: 'ca_policy_view'; signInId: string; index: number }
  | { action: 'results_view'; search: string; type: string; page: number; ids: string[] }
  | { action: 'details_toggle'; section: 'session-output' | 'record-details' | 'ca-policy-details' | 'audit-record-details' | 'ual-record-details' | `${IdentityKind}-details`; open: boolean }
  | { action: 'range_change'; range: string; start: string; end: string };
export interface BecApi {
  importHistory(browser: HistoryBrowser): Promise<Reply<HistorySource | null>>;
  queryHistory(query: HistoryQuery): Promise<Reply<HistoryResults>>;
  copyHistory(query: HistoryQuery, mode: 'urls' | 'visits', visitId?: string): Promise<Reply<number>>;
  clearHistory(): Promise<Reply<null>>;
  openReport(provider: Provider, indicator: string): Promise<Reply<null>>;
  osint(indicator: string): Promise<Reply<OsintReport>>;
  keyStatus(): Promise<Reply<Record<Provider, boolean>>>;
  saveKeys(changes: Partial<Record<Provider, string>>): Promise<Reply<Record<Provider, boolean>>>;
  audit(event: UiAuditEvent): Promise<Reply<null>>;
  logInfo(): Promise<Reply<{ id: string; file: string }>>;
  state(): Promise<Reply<SessionState>>;
  install(): Promise<Reply<null>>;
  connect(tenant: string, mode: AuthMode): Promise<Reply<SessionState>>;
  conditionalAccess(ids: string[]): Promise<Reply<ConditionalAccessReport>>;
  exchange(mode: AuthMode): Promise<Reply<SessionState>>;
  reset(): Promise<Reply<SessionState>>;
  collect(query: SignInQuery): Promise<Reply<Collection>>;
  collectAudits(query: SignInQuery): Promise<Reply<AuditCollection>>;
  exportAudits(format: 'csv' | 'json'): Promise<Reply<string | null>>;
  collectUal(query: UalQuery): Promise<Reply<UalCollection>>;
  viewUal(filters: UalFilters, page: number): Promise<Reply<UalView>>;
  exportUal(format: 'csv' | 'json', scope: 'all' | 'filtered', filters: UalFilters): Promise<Reply<string | null>>;
  collectIdentity(kind: IdentityKind, query: IdentityQuery): Promise<Reply<IdentityCollection>>;
  exportIdentity(kind: IdentityKind, format: 'csv' | 'json'): Promise<Reply<string | null>>;
  reviewApp(key: string, review: 'Unreviewed' | 'Recognised' | 'Unfamiliar'): Promise<Reply<IdentityRow[]>>;
  export(format: 'csv' | 'json'): Promise<Reply<string | null>>;
  onLog(callback: (message: string) => void): () => void;
}

export type Provider = 'virustotal' | 'abuseipdb' | 'ipdata';
export interface ProviderResult { provider: Provider; status: 'ok' | 'error' | 'skipped'; message?: string; data?: Record<string, any> }
export interface OsintReport { indicator: string; kind: 'ip' | 'md5' | 'sha1' | 'sha256'; queriedAt: string; results: ProviderResult[] }

export type HistoryBrowser = 'auto' | 'chrome' | 'edge' | 'firefox';
export interface HistorySource {
  id: string; file: string; browser: string; importedAt: string; visits: number; pages: number;
  files: { name: string; bytes: number; sha256: string }[];
}
export interface HistoryQuery {
  sourceId: string; search: string; protocol: 'all' | 'http' | 'https' | 'other';
  type: 'all' | 'link' | 'typed' | 'reload' | 'redirect' | 'other'; start: string; end: string; page: number;
}
export interface HistoryVisit {
  id: string; url: string; title: string; domain: string; time: string | null; rawTime: string;
  type: string; rawType: string; urlVisits: number | null; durationSeconds: number | null; referrer: string;
}
export interface HistoryResults { sourceId: string; total: number; pages: number; first: string | null; last: string | null; page: number; rows: HistoryVisit[] }

export interface NoteDocument { id: string; title: string; text: string; revision: number; status: 'unsaved' | 'saved' | 'modified' }
export interface NoteState { notes: NoteDocument[]; saved: { id: string; title: string }[]; detached: boolean; focusId?: string; storageAvailable: boolean; storageError?: string }
export interface NoteEdit { id: string; title: string; text: string; revision: number }
export interface NoteApi {
  state(): Promise<Reply<NoteState>>;
  add(): Promise<Reply<NoteState>>;
  update(edit: NoteEdit): Promise<Reply<NoteState>>;
  save(id: string, revision: number): Promise<Reply<NoteState>>;
  close(id: string, revision: number, discard: boolean): Promise<Reply<NoteState>>;
  openSaved(id: string): Promise<Reply<NoteState>>;
  forgetSaved(id: string): Promise<Reply<NoteState>>;
  popOut(id: string): Promise<Reply<NoteState>>;
  onChange(callback: (state: NoteState) => void): () => void;
}
