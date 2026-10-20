# BEC Bot

A local Electron + TypeScript workspace for business email compromise investigations.

For first-time installation, daily startup and updates, follow the [Windows installation SOP](docs/INSTALLATION-SOP.md).

## Run

Requires Node.js 22.12 or later. In PowerShell in this folder:

```powershell
npm install
npm start
```

After installing dependencies, you can also double-click **Start BEC Bot.bat**.
Installation needs internet access; the interface runs locally.

## Sign-in investigation walkthrough

The app opens on the **Session** tab. Module installation, tenant selection, authentication, connection output and investigation reset all live there. Its Graph/Exchange connections are shared across the BEC compromise modules. Toolkit modules work independently of these connections. Use the fixed sidebar **Session** tab or the **Session** button in the header from any compromise table; the header also shows both connection states. Switching tabs preserves connections, collected evidence, filters and selected sign-ins.

The compromise tools are grouped under collapsible **Entra ID / Azure** and **Microsoft 365** menus. Entra contains Sign in Exports, Audit Logs, Risk Detections, Devices and App Consents. Microsoft 365 contains **UALs**, **Inbox Rules**, **Outbound Trace**, **Inbound Trace**, **Quarantine / Threat Explorer** and **Forwarding**. Session remains outside the groups because its connections are shared. Expanding/collapsing groups and navigation are recorded in the investigation transcript.

Connection cards and header badges show confirmed connections in green, failed connection attempts in red, pending authentication in yellow and disconnected sessions in grey. Graph and Exchange statuses are independent. Sign-in result badges use green for error code `0`, yellow for recognised MFA/enrolment or challenge interruption codes (`50072`, `50074`, `50076`, `50079`, `50125`, `50140`, `50158`), red for other nonzero errors and grey when no error code is returned. A successful sign-in that used MFA stays green; a failed MFA challenge (for example `500121`) stays red. Raw codes and failure reasons remain visible. This is a display classification based on [Microsoft's error-code reference](https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes); exported evidence is unchanged.

1. Install PowerShell 7 (`pwsh.exe`) and ensure it is on PATH. Windows PowerShell 5.1 is not supported for this workflow.
2. Start BEC Bot and choose **Install modules** once. This installs `Microsoft.Graph.Authentication` and `ExchangeOnlineManagement` from PSGallery for the current Windows user; no administrator rights are normally needed. You may instead install these yourself in PowerShell 7 using `Install-Module <name> -Scope CurrentUser`.
3. Enter the target Microsoft Entra **tenant ID** (GUID). Choose **Connect Graph** for Entra investigations or **Connect Exchange** for Exchange-only investigations; either service can connect first. The default sign-in method opens Microsoft's device-login page automatically when the code arrives. **Session output** expands and shows the code to enter in the browser. Use an account with access to that tenant's logs. For another device, select **Device code (open browser manually)** instead. Neither mode uses an embedded login popup.
4. Connect the other service only when needed and complete its separate device sign-in. Each service has its own connection status and account. Both must match the selected investigation tenant. Graph authentication failures leave an existing Exchange connection usable. Exchange supports UALs, inbox rules, message traces, forwarding and quarantine metadata without Graph; Entra tools and Defender advanced hunting require Graph.
5. In **Sign in Exports**, enter the compromised user's full UPN and select 24h, 48h, 72h, one week, or a custom start/end. Custom dates use the device's local timezone; requests and results use UTC, with an exclusive end time.
6. Choose **Collect sign-ins**. The app queries interactive and non-interactive user sign-ins separately, follows every result page, deduplicates event IDs, then presents the completed result set. A failed query does not expose a partial collection as complete.
7. Search or filter event types, page through results, and choose **View** to inspect a complete raw record. **Export CSV** and **Export raw JSON** save the entire collection, regardless of current view filters. CSV includes a raw JSON column and provenance; JSON preserves the unmodified records with collection metadata. CSV cells that could be interpreted as formulas are prefixed with an apostrophe.
8. **New / disconnect** cancels pending work, terminates the app's PowerShell session, and clears evidence from memory. Export anything needed first. Closing the app also terminates its session. Browser login cookies are not cleared.

## Customer tenant access

For access-package, guest or delegated accounts, choose **Guest / delegated access** under **Exchange account access** and enter the **customer tenant ID**, not your home tenant. This is the default UI option. Exchange passes that GUID as `DelegatedOrganization` and verifies the returned managed organization. Its sign-in tenant may be your home tenant; hover the connection card to see sign-in and target tenant IDs. Use **Account in the target tenant** for native customer accounts, which verifies the returned tenant ID directly.

Graph already uses `Connect-MgGraph -TenantId <customer GUID> -ContextScope Process`. Signing in through your home identity provider does not change the requested resource tenant. If the returned Graph context belongs to another tenant, the connection is closed and both tenant IDs are shown. The target tenant must have active guest access, required roles and Graph consent; the application does not assign or activate access packages. Graph and Exchange remain independently connectable.

Microsoft references: [customer / guest Exchange connections](https://learn.microsoft.com/en-us/powershell/exchange/connect-to-exchange-online-powershell#connect-to-exchange-online-powershell-in-customer-organizations), [Exchange connection metadata](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/get-connectioninformation), [Graph tenant-scoped authentication](https://learn.microsoft.com/en-us/powershell/module/microsoft.graph.authentication/connect-mggraph).

## Permissions and coverage

Graph authentication automatically requests `AuditLog.Read.All`, `Policy.Read.ConditionalAccess`, `User.ReadBasic.All`, `Directory.Read.All`, `IdentityRiskEvent.Read.All`, `IdentityRiskyUser.Read.All` and `ThreatHunting.Read.All` using process-scoped authentication. Directory read supports device ownership, application metadata and delegated-grant lookup; the risk scope reads Identity Protection detections. Permissions, licensing and module setup are prerequisites managed through the investigation SOP.

## Conditional Access for selected sign-ins

Select suspicious entries using the checkboxes in **Sign in Exports**, or **Select this page**. Selection persists across searches, event-type filters, pages and navigation. Choose **View Conditional Access** to inspect `appliedConditionalAccessPolicies` from those captured sign-in JSON records. This performs no additional Microsoft query and does not fetch current policy definitions. Changing the selection clears the previous CA view; a new collection or investigation clears all selections.

Each selected sign-in has its own policy table containing policy name, ID, raw outcome, grant controls and session controls. The same policy can succeed for one sign-in and fail for another; these evaluations are kept separate. Raw outcomes such as `success`, `failure`, `notApplied`, `notEnabled`, `reportOnlySuccess`, `reportOnlyFailure`, `reportOnlyNotApplied`, `reportOnlyInterrupted` and unknown future values are preserved. The overall event `conditionalAccessStatus` is shown independently from per-policy outcomes. **View evaluation** opens the full captured evaluation JSON. Existing CSV/JSON exports retain policy detail in the raw records.

An omitted/null policy property is reported as unavailable; an explicitly empty array is reported as an empty policy list. Neither is interpreted as a policy's `notApplied` result. Existing evidence is not silently modified or re-queried. Selection changes, CA views and raw policy expansions are written to the investigation log before display.

References: [Sign-in Conditional Access permissions](https://learn.microsoft.com/en-us/graph/api/signin-get?view=graph-rest-1.0), [Applied policy outcomes](https://learn.microsoft.com/en-us/graph/api/resources/appliedconditionalaccesspolicy?view=graph-rest-beta).

The collector uses the Graph **beta** sign-in endpoint because it explicitly documents querying both `interactiveUser` and `nonInteractiveUser`. Beta schemas can change. It targets the global Microsoft cloud; sovereign clouds are not configured. Retention, ingestion delays, tenant permissions, Conditional Access device-flow restrictions and Microsoft service throttling affect availability. A successful empty collection means no matching retained records were returned, not proof no compromise occurred.

Official references: [List signIns (beta)](https://learn.microsoft.com/en-us/graph/api/signin-list?view=graph-rest-beta), [Graph PowerShell authentication](https://learn.microsoft.com/en-us/powershell/microsoftgraph/authentication-commands), [Connect-ExchangeOnline](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/connect-exchangeonline).

If an old session is waiting without instructions, choose **New / disconnect**, then reconnect. The app now forwards Graph success-stream and information-stream authentication messages immediately instead of discarding them. If automatic browser launch fails, open `https://microsoft.com/devicelogin` manually and enter the displayed code. If no code appears, check Session output for module, network or tenant errors and cancel/retry as needed.

## Entra Audit Logs

Open **Audit Logs** after connecting Graph. Enter the affected UPN and choose 24h, 48h, 72h, one week or a custom range. Custom dates are entered in local time; requests/results use UTC and the end time is exclusive.

The collector resolves the current account's object ID, reads every page of Entra directory audit events in the selected window, and retains events where the user is an initiator or target by object ID/UPN. A time-window scan avoids depending on nested actor/target filter support and can take longer in busy tenants. It includes actions performed by administrators or applications against the affected account. Duplicate event IDs are removed. Deleted/unresolvable accounts currently require investigation outside this UPN-based workflow; a failed identity lookup is reported rather than silently returning incomplete matches.

Filter the collected events by password changes, MFA/authentication methods, roles, app consents, devices, groups or other activities. These labels are derived from event/category/property names; they can overlap, and **All activities** preserves every matched event. Search also covers nested raw fields. Account-involvement filters distinguish events performed by, targeting, or involving the account in both roles.

**View** displays the full raw event, including targets, old/new modified properties and correlation IDs. Result badges distinguish success/failure/timeout/unknown. **Export CSV** and **Export raw JSON** save the entire collection regardless of view filters. CSV includes actor, targets, modified properties, provenance and raw JSON with spreadsheet formula protection. Export paths and SHA-256 hashes, queries, viewed pages and expanded records are recorded in the investigation transcript.

Audit and sign-in evidence persist independently when switching tabs; collecting in one module does not replace evidence in the other. A failed audit collection clears the previous audit evidence, and **New / disconnect** clears all investigation modules. Only a completed collection can be exported. This module retrieves **Entra directory audits**, not Exchange mailbox or Purview unified audit events. Empty results describe retained matching events and cannot prove that no activity occurred.

## Risk Detections, Devices and App Consents

All three tabs use the shared Graph session and collect evidence for one affected UPN at a time. Each retains its own result set across navigation, with search, filters, 100-row pages, raw-record inspection and complete CSV/JSON exports. View filters do not restrict exports. A failed collection clears that tab's previous evidence; resetting the investigation clears every tab. Queries, viewed pages, expanded records/cells, exports and export hashes are written to the session transcript.

**Risk Detections** collects four sources for the resolved account: detections (`/v1.0/identityProtection/riskDetections`), current user risk (`/v1.0/identityProtection/riskyUsers/{id}`), user risk history (`/v1.0/identityProtection/riskyUsers/{id}/history`) and interactive/non-interactive sign-ins with risk indicators (`/beta/auditLogs/signIns`). The current risky-user record is always included, even when detections are empty or its last-update date predates the selected window. **All retained risk evidence** requests available retained records; custom/preset windows filter detections by activity OR detection time, history by risk-update time, and sign-ins by creation time. Sources have independent retention and available sign-in history is limited by the service.

Use the source selector for current user risk, history, detections or sign-in risk indicators, plus high/medium/low filters and raw-data search. Each returned raw record is preserved, including risk detail, history actor/activity, processing/deletion flags, sign-in risk levels during/after sign-in and event types. Hidden risk fields are labelled as unavailable detail and do not establish a safe/risky verdict. Current state and historical snapshots have separate source labels; neither is presented as a new detection event. Captured sign-in references link only to matching evidence already collected in the Sign in Exports tab.

Each source reports its returned count or an explicit error. A failed source does not discard successfully collected sources; coverage is marked incomplete in yellow and included in JSON/CSV. Risk CSV exports also write a `.metadata.json` companion so source errors are preserved even when no rows are returned. Queries, source status, views and exports are logged. This module uses read-only requests and does not dismiss risk or confirm accounts/sign-ins safe or compromised.

New Graph connections request `IdentityRiskyUser.Read.All` in addition to the existing scopes. Reconnect/start a new investigation to obtain the updated session scopes. Identity Protection APIs and details remain subject to tenant licensing, Graph permissions and retention. See [risky-user API](https://learn.microsoft.com/en-us/graph/api/riskyuser-get?view=graph-rest-1.0), [user risk history](https://learn.microsoft.com/en-us/graph/api/riskyuser-list-history?view=graph-rest-1.0), and [sign-in risk fields](https://learn.microsoft.com/en-us/graph/api/resources/signin?view=graph-rest-beta).

**Devices** retrieves current owned device objects, including registration time, device ID, name, OS, join type and current compliance. It preserves older devices and unknown registration/compliance values. Devices registered during the incident window and currently non-compliant devices receive review flags. It also scans retained directory audit events in the incident window for device activity referencing the affected user or currently owned device IDs, including references in modified properties. Audit rows are explicitly historical and do not fabricate device registration times. Use the **Current state**, **Incident-window audit history** and **Registered during incident window** filters. Current inventory and retained events cannot prove no deleted rogue device ever existed; current compliance is not its historical compliance.

**App Consents** retrieves both user-specific delegated grants (`Principal`) and applicable tenant-wide grants (`AllPrincipals`), follows pagination and resolves application/resource service-principal metadata with a per-collection cache. Deleted application references are retained and flagged; other lookup failures fail the collection. Sensitive scope names such as `Mail.Read`, `Mail.ReadWrite` and `Contacts.Read` are flagged for review. Exact scopes and API identifiers are preserved; a flag is not a malicious-app verdict. The table omits Flags and Review controls. Its UPN column uses the Graph-returned account identity for user-specific grants and explicitly labels tenant-wide grants as All users. Missing UPNs are left unavailable; query input is not presented as a returned identity. Audit-history UPNs come from the matching user actor or target in that event.

App Consents also scans incident-window consent/grant audit activity referencing the affected account or the captured client/grant objects. Related-application events can involve other principals, so inspect the actor, targets and modified properties before attributing them to the affected user. Current grants have no creation timestamp and are not date-filtered as though they were created in the incident window. History can include consent changes whose grant has since been removed when the retained event still identifies the affected account. Application permissions/app-role inventory and current full policy definitions are separate from these delegated grants.

References: [Risk detections](https://learn.microsoft.com/en-us/graph/api/riskdetection-list?view=graph-rest-1.0), [Owned devices](https://learn.microsoft.com/en-us/graph/api/user-list-owneddevices?view=graph-rest-1.0), [Device properties](https://learn.microsoft.com/en-us/graph/api/resources/device?view=graph-rest-1.0), [Delegated grants](https://learn.microsoft.com/en-us/graph/api/oauth2permissiongrant-list?view=graph-rest-1.0).

Reference: [Microsoft Graph directory audits](https://learn.microsoft.com/en-us/graph/api/directoryaudit-list?view=graph-rest-1.0).

## Current features

Every app launch starts an investigation transcript in **`session_logs`** next to the project (or next to the executable when packaged). The active investigation ID and absolute log path appear in the connection panel. **New / disconnect** ends the current transcript and creates a separate `.txt` for the next investigation. Normal application shutdown writes a final `SESSION_END`; an interrupted/crashed session can be identified by its missing end marker. Existing logs are never overwritten or automatically deleted.

Each UTF-8 text entry contains a UTC timestamp, sequence number, event name and JSON details. This records connection attempts and identities, module installation, exact PowerShell commands and parameters, every Graph request including pagination, query ranges and users, result counts and IDs, navigation, searches, type filters, result pages, expanded raw records, panel expansion/collapse, export attempts/cancellation/failure, output paths, export sizes/SHA-256 hashes and session termination. Export logging covers the full collection, independently of view filters.

Entries are appended and flushed to disk before protected actions execute. The PowerShell worker waits for an acknowledgement for each logged query. If writing fails, the query or data-view action is blocked and an error is shown. Query logging is app-wide in the main process rather than tied to an individual tab. The files contain investigation data, including user identities, searches and expanded records; authentication tokens and device codes are redacted. These local transcripts are not tamper-proof or a substitute for Microsoft server-side audit logs.

- Minimal monochrome desktop interface.
- Clickable **Sign in Exports** and **Audit Logs** navigation.
- Operational sign-in collection, searchable results, raw record inspection and CSV/JSON export.
- Entra audit collection, actor/target matching, activity filters, raw event inspection and CSV/JSON exports.
- App-wide Graph and Exchange sessions.

## Learn the code

- `src/main.ts`: creates the Electron window in the main process.
- `src/renderer.ts`: navigation and page content. The `Page` type limits page names; `PageContent` describes the fields every page needs.
- `ui/index.html`: interface structure.
- `ui/styles.css`: colours, spacing, typography and layout.
- `tsconfig.json`: strict TypeScript compiler settings.

`npm run build` compiles TypeScript to JavaScript in `dist/`. `npm run check` checks types without generating files. Restart after changes.

The renderer uses a sandbox, context isolation, no Node integration and a restrictive content security policy. `src/preload.ts` exposes a small typed API; `src/main.ts` validates IPC requests and owns exported evidence. `src/powershell.ts` runs one persistent PowerShell process; `powershell/session.ps1` implements an allowlist of operations. User input is passed as JSON data, never evaluated as PowerShell source. Tokens stay in the PowerShell process and are not sent to the renderer.

## Verification

`npm test` checks validation, CSV handling and the real PowerShell collector against offline Microsoft command doubles (requires PowerShell 7). `npm run test:smoke` launches Electron briefly and checks navigation, connection and collection UI using mocked IPC responses. These checks do not authenticate to Microsoft or validate a real tenant's permissions. Live end-to-end collection must be verified with your authorized tenant account.

## BAU OSINT Toolkit

The sidebar separates **BEC Bot · Compromises** (Session, Sign in Exports and Audit Logs) from **Toolkit · BAU investigations**. Toolkit requires no Graph or Exchange connection. Open **Settings** to add, replace or remove VirusTotal, AbuseIPDB and IPData API keys. Blank fields retain saved keys. Keys persist in `api-keys.enc` under Electron's user-data directory, encrypted with Electron safeStorage for the Windows account; they are not returned to the renderer or written to investigation transcripts.

Enter one IPv4, IPv6, MD5, SHA-1 or SHA-256 indicator in **OSINT Toolkit**. IP lookups query all configured providers concurrently, displaying each provider's ownership/ISP, ASN and location where returned, plus threat information. VirusTotal supplies engine counts and individual detections; AbuseIPDB supplies confidence and reports over the last 90 days; IPData supplies threat flags and network/location information. Missing fields are shown as not provided (AbuseIPDB does not normally return ASN). Provider responses remain individually inspectable, including raw fields. No cross-provider location agreement is assumed.

MD5, SHA-1 and SHA-256 lookups retrieve an existing VirusTotal file report, including file metadata, signature verification, signer, signature details and engine detections. This does not upload a file or trigger a rescan. Missing signature data means unknown, not unsigned. ISP/ASN/geolocation are properties of IP addresses and do not apply to a file hash.

Requests have a 20-second timeout and no automatic retries. Missing keys, absent reports, authentication failures, quotas and network failures are shown separately for each provider. A report without detections does not establish that an indicator is safe. Provider API plans determine data availability. Live requests send the entered indicator to the configured providers.

API references: [VirusTotal IP reports](https://docs.virustotal.com/reference/ip-info), [VirusTotal file signatures](https://docs.virustotal.com/reference/file-object-signature-info), [AbuseIPDB v2](https://docs.abuseipdb.com/), [IPData](https://docs.ipdata.co/docs/getting-started).

OSINT verification is included in `npm test` (mocked provider requests) and `npm run test:smoke` (Electron Settings/Toolkit flow). These tests do not spend provider quotas or validate live API credentials.

OSINT results use a bright green status bar above location/network details when every applicable provider returns clear detection/report fields, red when any provider returns detections, abuse reports, positive abuse confidence or blocklist entries, and grey when checks are incomplete. AbuseIPDB displays the three newest returned report snippets, with all returned comments expandable; the provider Report link remains available for history beyond API limits.

Paste common defanged IPs directly: mixed `[.]`, `(.)`, `{.}`, `[dot]`/`(dot)`/`{dot}`, ` dot `, escaped dots, spaced separators, Unicode full stops, and bracketed/defanged IPv6 colons are restored before strict IP validation. The normalized IP appears in results and is used for provider queries and report links.

File hashes are detected by hexadecimal length: MD5 (32), SHA-1 (40), SHA-256 (64). These are the file identifiers supported by the [VirusTotal file report endpoint](https://docs.virustotal.com/reference/file-info). All sidebar tabs share the same blue selected style.

## KQL Library

Open **Toolkit → KQL Library**. Choose **Add query**, enter a name and paste your template. Placeholders use `{Name}` syntax, for example `{User}`, `{IP}`, `{Lookback}` or `{PH2}`; names start with a letter/underscore and may contain numbers. Use **Insert placeholder** to add one at the cursor, or type placeholders directly. Each unique name creates a parameter text box; repeated placeholders share a value. The final query updates as you type. **Copy query** becomes available when all parameters are filled. Values are substituted literally, so put quotes in the template when required by your query.

**Save query** stores names and templates in the app's local browser storage across restarts. Parameter values stay in memory and are not saved. Unsaved drafts remain available while switching queries or tabs within the current window; save them before closing. Search the library, edit saved templates, or delete a query using its inline confirmation. KQL is generated for copying; the app does not execute queries. This library is independent of the Microsoft investigation session.

## Browser History Viewer

Open **Toolkit → Browser History** and choose **Import history**. Select a copied native Chrome/Edge `History` database or Firefox `places.sqlite`. Close the source browser before acquiring the copy; keep its matching `-wal` file alongside the database if present. Auto detection identifies Firefox or Chromium; Chrome and Edge share a schema, so choose the browser explicitly when you need that label.

The viewer shows one row per recorded visit, including UTC visit time, page title, full URL, domain, visit type, stored URL visit count and duration when available. **Details** includes the referrer, exact original timestamp and transition/type, source path, import time, sizes and SHA-256 hashes of the imported database/WAL. URL visit counts are the browser's stored counts, independent of viewer filters; a missing duration is shown as unavailable.

Search URL/title, filter protocol and visit type, or set a start/end range (entered in local time, end exclusive). Results are paginated at 100 visits; filters apply to the full imported database. Copy one URL/visit or all filtered URLs/visits. URL copies are deduplicated; visit copies are tab-separated with headers for pasting into a spreadsheet. Copying more than 10,000 results is blocked with a request to narrow filters. Details preserve the original fields; spreadsheet-oriented visit copies neutralize leading formula characters and normalize tabs/newlines.

Import and SQL queries run in a background worker against temporary copies. No URLs are visited or sent to OSINT providers. Sources are not modified; matching WAL data is included and changes detected during copying are rejected. A failed or cancelled import keeps the previous collection. **Clear**, replacement import and normal shutdown remove the temporary copy. Imported history is not persisted in the UI across app restarts; a crash can leave a temporary `bec-history-*` directory in the operating system's temp directory. Source imports and filter/copy actions are recorded in the local investigation transcript. There is no recovery of deleted or private-mode history. Files over 2 GB and operations exceeding 60 seconds are rejected explicitly.

History checks use real SQLite fixtures for Chromium, Edge and Firefox, including WAL data, exact timestamp conversion, filters, pagination, copy limits, source preservation, invalid files and clipboard/UI behaviour. Existing compromise, OSINT and KQL checks remain in the full verification suites.

Schema references: [Chromium visits](https://chromium.googlesource.com/chromium/+/HEAD/chrome/browser/history/visit_database.cc), [Firefox visit queries](https://support.mozilla.org/en-US/questions/937585), [Node SQLite](https://nodejs.org/download/release/latest-jod/docs/api/sqlite.html).


## Data Tools

Open **Toolkit → Data Tools**. Paste input, choose an operation and copy the output. Defang/refang accepts multiline IPs/URLs, mixed dot/colon wrappers, Unicode dots and `hxxp`/`hxxps` schemes. Defanging uses `[.]`, `[:]` and `hxxp(s)` throughout the supplied text, including URL paths and queries. **Use as input** lets you chain operations; **Clear** clears both fields.

Base64 supports UTF-8 and UTF-16LE text. Decoding accepts standard and URL-safe alphabets, whitespace and omitted padding; invalid Base64 or invalid text for the selected encoding is reported without retaining stale output. JSON beautification supports two/four spaces or tabs and preserves original numeric/string tokens and duplicate keys. Input is limited to 2,097,152 characters; JSON formatting additionally limits nesting to 100 levels and formatted output to 8,388,608 characters.

All conversions run in the renderer. Input/output stays in memory when switching tabs and is not saved or included in the investigation transcript. Only navigation is logged. No Microsoft session or provider key is required.

## Unified Audit Logs

Connect Exchange in **Session**, then open **Microsoft 365 → UALs**. Graph is not required. Enter one account UPN, select 24/48/72 hours, one week or a custom range. Custom dates are entered in local time and converted to UTC; the end is exclusive. Leave operations blank for all activity or use **BEC operations** to populate the suggested investigation set. Operation names can be edited before collection.

Search and filter the captured records by IP/CIDR inclusion or exclusion, IP availability, operation, workload and result. **Apply filters** applies text/IP changes; dropdown changes apply immediately. IP exclusions take priority. An IP include filter excludes records with no parseable IP; exclusions alone retain them. IP matching uses the captured actor/client IP fields, normalizes IPv4 ports and bracketed IPv6, and does not infer location or resolve names. View a record to inspect parsed AuditData and the original returned record. Unknown result codes remain unclassified.

Export CSV or JSON for the complete collection or every matching record across all pages. CSV has a `.metadata.json` companion containing provenance, query, filters, counts, coverage notes and auditing checks, including zero-event searches. A completed collection remains available when changing tabs; a new collection attempt replaces that tab's evidence and a failure leaves no exportable partial collection. New investigation clears it. Query execution, views, raw-event expansions and exports with SHA-256 hashes are recorded in `session_logs`.

Collection uses `Search-UnifiedAuditLog`, 5,000-record pages and stable ReturnLargeSet sessions, initially in daily windows. Saturated 50,000-record windows are split and recollected; overlapping boundaries are deduplicated. Repeated pages, inconsistent empty pages, saturated one-second windows and query failures reject collection rather than silently accept partial evidence. HighCompleteness is enabled when the connected command exposes it. UAL has a 60-minute timeout; New investigation cancels the session.

If `Search-UnifiedAuditLog` is unavailable in the connected session, the app reports the target tenant/account and audit-role prerequisites. A tenant administrator must verify the account's **View-Only Audit Logs** or **Audit Logs** role and Exchange audit-cmdlet permissions, including active access-package/delegated assignments. Reconnect after access changes. Inbox Rules retains successful current-rule results while marking rule history unavailable; unavailable history is never represented as zero changes. See [Microsoft's audit permissions guidance](https://learn.microsoft.com/en-us/purview/audit-get-started#step-2-assign-permissions-to-search-the-audit-log).

Empty source searches trigger read-only checks of organization mailbox auditing, audit ingestion, mailbox settings and audit bypass. Disabled settings and failed checks are evidence gaps; the GUI and exports retain the details. These checks describe current configuration, not its historical state. A search with no events does not establish that no activity occurred: retention, ingestion delay, audited operations and scope affect coverage.

UserIds scopes the audited actor. Actions by other administrators or delegates targeting the mailbox may require their own searches. IP filters preserve the captured source collection. This module retrieves audit metadata only; it does not run Content Search, eDiscovery or retrieve message bodies. Those activities remain subject to the client's explicit written authorisation and IR Lead escalation in the investigation SOP.

References: [Search-UnifiedAuditLog](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/search-unifiedauditlog?view=exchange-ps), [Mailbox auditing](https://learn.microsoft.com/en-us/purview/audit-mailboxes). Tests use offline fixtures and mocked Electron sessions; live tenant collection still needs validation against your environment.

Investigation tables (sign-ins, conditional access, directory audits, risk detections, devices, consents, UALs and browser history) shorten long text to 60 characters. Each long value has an **Expand / Collapse** control that reveals the complete text within the same column width. Expansions are recorded in the session transcript. Search, raw-record details and exports continue to use the complete captured values.

## Microsoft 365 investigation modules

All five new tabs use the investigation's Graph/Exchange connections, one affected UPN and an incident/review window. Dates are local inputs converted to UTC, end exclusive. Counterparty email filters are optional on trace tabs (recipient for outbound; sender for inbound). Search covers all captured fields, including raw metadata; filter by source or review candidates. Tables paginate at 100 records, with 60-character expandable previews. Source errors are shown explicitly; successful sources remain available with incomplete coverage clearly labelled. Current configuration is always collected independently of historical date filters.

**Inbox Rules** collects `Get-InboxRule -IncludeHidden` and historical UAL operations `New-InboxRule`, `Set-InboxRule`, `Remove-InboxRule` and `UpdateInboxRules` (the UAL operation names corresponding to rule creation/modification/deletion). History searches omit the actor filter so administrator/delegate actions can be found, then attribute events using mailbox references or the queried actor. Unattributable records are counted as a coverage limitation and excluded from the user's collection. Current rule name, enabled state, priority, description, conditions/exceptions and forwarding/redirect/delete/move actions are retained. Missing current creation time/source IP are unavailable, never invented; historical event timestamps/IPs appear where returned.

**Outbound Trace** uses `Get-MessageTraceV2` against the mailbox's resolved SMTP aliases. It captures each message-recipient result with subject, status, addresses, IPs and trace/message IDs. Bulk-recipient candidates, payment-related subject terms and accepted-domain internal recipients are review hints, not maliciousness verdicts. Unexpected recipients require analyst judgement. Scope is limited to 90 days; requests split into at most ten-day windows, with smaller ranges used when result limits are reached. Very large recipient sets observed at the 1,000-recipient boundary are re-queried with MessageTraceId. Saturated one-second searches fail explicitly rather than produce a purported complete export. Trace does not retrieve message bodies or establish payment-diversion language beyond subject metadata.

**Inbound Trace** collects recipient-scoped message traces and current mailbox rules. Potential hiding/forwarding rules appear as candidates beside trace records and as separately inspectable supporting rows, including raw conditions, exceptions, priority and actions. This does not prove that a particular response was hidden or that current rules were enabled during the incident. If fresh rule collection fails, a same-account/same-tenant Inbox Rules snapshot can be referenced, explicitly labelled with its collection time. Export that snapshot as supporting evidence.

**Quarantine / Threat Explorer** collects paginated quarantine metadata via Exchange and licensed Defender advanced hunting through Graph: `EmailEvents`, `EmailUrlInfo`, `UrlClickEvents` and `EmailPostDeliveryEvents`. Email/URL queries are scoped to the resolved account aliases (URL rows join to the user's email metadata); Safe Links clicks use AccountUpn. Each table is collected independently so licensing/role/table failures are distinct from zero results. Hunting result counts are verified; large or changing results are split into smaller time ranges. Source retention still applies. Choose 14/28 days or a custom earlier window to investigate pre-incident lures. Sender authentication, threat detection methods and click-chain fields remain in raw records for review; trusted or previously compromised senders are not treated as safe merely because delivery succeeded.

The **URL detonation evidence** form records an analyst-observed URL verdict, observation time, report reference/evidence filename, notes and capturing analyst. It preserves existing report observations; it does not visit URLs, submit them to a sandbox or claim to retrieve full detonation reports/chains automatically. Open the fixed Defender Threat Explorer/Quarantine portal links to review the report manually. Manual captures are clearly labelled and included in exports; attach referenced report files to the incident ticket separately.

**Forwarding** captures current mailbox `ForwardingSmtpAddress`, `ForwardingAddress` and `DeliverToMailboxAndForward`, plus a tenant-wide transport-rule inventory containing redirect/BCC/copy/add-recipient actions. Rule state, mode, priority, description, conditions and exceptions are retained, including disabled or test-mode candidates. Tenant-wide candidates must be checked for actual applicability and legitimate purpose; collection does not establish attacker creation.

CSV and JSON exports can include all captured records or all matching filtered records across pages. Each CSV has a `.metadata.json` companion with query, aliases, tenant, counts, source errors and coverage notes, including empty collections. Every remote command/hunting query, view, cell/raw inspection, capture and export is recorded in `session_logs`; exported files have SHA-256 hashes in the transcript. New/disconnect clears all five collections. Replacing a collection removes that tab's prior result; worker failures leave no stale exportable collection. Long Microsoft 365 collections have a 60-minute timeout and can be cancelled by New/disconnect.

New Graph sessions request `ThreatHunting.Read.All`; reconnect/start a new investigation to obtain the updated scope. Exchange module version, roles, Defender licensing and retention are SOP prerequisites. Collection is read-only audit/mail metadata: no Content Search, eDiscovery, message preview/download, quarantine release, rule modification or forwarding changes are executed. Client written authorisation and IR Lead escalation requirements for content searches remain unchanged.

References: [Get-InboxRule](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/get-inboxrule?view=exchange-ps), [Message Trace V2](https://learn.microsoft.com/en-us/powershell/module/exchange/get-messagetracev2?view=exchange-ps), [quarantine metadata](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/get-quarantinemessage?view=exchange-ps), [Graph hunting](https://learn.microsoft.com/en-us/graph/api/security-security-runhuntingquery?view=graph-rest-1.0), [Threat Explorer](https://learn.microsoft.com/en-us/defender-office-365/threat-explorer-real-time-detections-about), [transport rules](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/get-transportrule?view=exchange-ps).

Tests use offline PowerShell fixtures, range saturation/pagination fixtures and Electron IPC/UI mocks. These verify scope, evidence handling and application behaviour; live tenant permissions and service responses still require environment validation.
