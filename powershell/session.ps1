$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'Continue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$script:graph = $false
$script:exchange = $false
$script:tenant = ''
$script:account = ''
$script:graphAccount = ''
$script:exchangeAccount = ''
$script:exchangeAccess = 'direct'
$script:exchangeAuthTenant = ''

function Get-State {
    @{ graph = $script:graph; exchange = $script:exchange; tenant = $script:tenant; account = $script:account; graphAccount = $script:graphAccount; exchangeAccount = $script:exchangeAccount; exchangeAccess = $script:exchangeAccess; exchangeAuthTenant = $script:exchangeAuthTenant }
}

function Write-QueryAudit([string]$Command, $Parameters = @{}) {
    [Console]::WriteLine('BEC_AUDIT:' + (@{ command = $Command; parameters = $Parameters } | ConvertTo-Json -Depth 20 -Compress))
    [Console]::Out.Flush()
    if ([Console]::ReadLine() -ne 'BEC_AUDIT_OK') { throw 'Durable query logging was not acknowledged. Query blocked.' }
}

function Require-Module([string]$Name) {
    Write-QueryAudit 'Get-Module' @{ ListAvailable = $true; Name = $Name }
    if (-not (Get-Module -ListAvailable -Name $Name)) {
        throw "Missing $Name. Use Install modules first, then connect again."
    }
    Write-QueryAudit 'Import-Module' @{ Name = $Name }
    Import-Module $Name -ErrorAction Stop
}

function Write-AuthOutput {
    process {
        # Some Graph versions write the device instructions to the success stream.
        # Forward immediately instead of discarding or buffering until login finishes.
        [Console]::WriteLine([string]$_)
        [Console]::Out.Flush()
    }
}

function Read-GraphObject([string]$Uri, [switch]$AllowMissing) {
    $parsed = [Uri]$Uri
    if ($parsed.Scheme -ne 'https' -or $parsed.Host -ne 'graph.microsoft.com') { throw 'Unexpected Graph object URL.' }
    Write-QueryAudit 'Invoke-MgGraphRequest' @{ Method = 'GET'; Uri = $Uri }
    try { Invoke-MgGraphRequest -Method GET -Uri $Uri -OutputType PSObject }
    catch {
        $code = $_.Exception.ResponseStatusCode
        if (-not $code) { $code = $_.Exception.Response.StatusCode }
        if ($AllowMissing -and ([int]$code -eq 404 -or $_.Exception.Message -match 'Request_ResourceNotFound')) {
            Write-Host "Referenced object was not found: $Uri"
            return $null
        }
        throw
    }
}

function Read-GraphPages([string]$Uri, [string]$AllowedPath, [switch]$AllowMissing) {
    $visited = [System.Collections.Generic.HashSet[string]]::new()
    do {
        $parsed = [Uri]$Uri
        if ($parsed.Scheme -ne 'https' -or $parsed.Host -ne 'graph.microsoft.com' -or $parsed.AbsolutePath -ne $AllowedPath) { throw 'Unexpected Graph pagination URL.' }
        if (-not $visited.Add($Uri)) { throw 'Graph returned a repeated pagination URL.' }
        $page = Read-GraphObject $Uri -AllowMissing:($AllowMissing -and $visited.Count -eq 1)
        if ($null -eq $page) { return }
        foreach ($item in $page.value) { $item }
        Write-Host "Fetched page from $AllowedPath"
        $Uri = $page.'@odata.nextLink'
    } while ($Uri)
}

function Read-RelatedAuditEvents($Request, [string]$UserId, [string[]]$RelatedIds, [string]$Kind) {
    $start = [DateTimeOffset]::Parse($Request.start).ToUniversalTime()
    $end = [DateTimeOffset]::Parse($Request.end).ToUniversalTime()
    $filter = 'activityDateTime ge ' + $start.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') + ' and activityDateTime le ' + $end.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $uri = 'https://graph.microsoft.com/v1.0/auditLogs/directoryAudits?$top=1000&$filter=' + [Uri]::EscapeDataString($filter)
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    Read-GraphPages $uri '/v1.0/auditLogs/directoryAudits' | ForEach-Object {
        $event = $_
        $time = [DateTimeOffset]::Parse($event.activityDateTime)
        $activity = [string]$event.activityDisplayName + ' ' + [string]$event.category
        $relevantActivity = if ($Kind -eq 'devices') { $activity -match 'device' } else { $activity -match 'consent|permission.?grant|delegated.?permission|app.?role.?assignment|oauth' }
        if ($time -ge $start -and $time -lt $end -and $relevantActivity) {
            $json = $event | ConvertTo-Json -Depth 100 -Compress
            $accountReference = $json.IndexOf($UserId, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $json.IndexOf($Request.user, [StringComparison]::OrdinalIgnoreCase) -ge 0
            $objectReference = @($event.targetResources | Where-Object { $_.id -and $RelatedIds -contains $_.id }).Count -gt 0
            if (($accountReference -or $objectReference) -and $seen.Add([string]$event.id)) { $event }
        }
    }
}

. "$PSScriptRoot/ual.ps1"
. "$PSScriptRoot/identity-risk.ps1"
. "$PSScriptRoot/m365.ps1"
while ($null -ne ($line = [Console]::ReadLine())) {
    try {
        $request = $line | ConvertFrom-Json
        $data = $null
        switch ($request.action) {
            'install' {
                foreach ($name in @('Microsoft.Graph.Authentication', 'ExchangeOnlineManagement')) {
                    Write-Host "Installing $name for the current Windows user..."
                    Write-QueryAudit 'Install-Module' @{ Name = $name; Repository = 'PSGallery'; Scope = 'CurrentUser'; Force = $true; AllowClobber = $true; AcceptLicense = $true; Confirm = $false }
                    Install-Module -Name $name -Repository PSGallery -Scope CurrentUser -Force -AllowClobber -AcceptLicense -Confirm:$false
                }
            }
            'connect' {
                if ($script:graph) { throw 'Reset the current investigation before changing tenant.' }
                if ($script:exchange -and $request.tenant -ne $script:tenant) { throw 'Graph must use the connected investigation tenant. Reset to change tenant.' }
                Require-Module 'Microsoft.Graph.Authentication'
                $parameters = @{ TenantId = $request.tenant; Scopes = @('AuditLog.Read.All', 'Policy.Read.ConditionalAccess', 'User.ReadBasic.All', 'Directory.Read.All', 'IdentityRiskEvent.Read.All', 'IdentityRiskyUser.Read.All', 'ThreatHunting.Read.All'); ContextScope = 'Process'; NoWelcome = $true }
                Write-Host 'Requesting a Microsoft device code. Enter the code shown below on the Microsoft sign-in page.'
                # Device flow works without a WAM parent window or a custom app registration.
                # The Electron main process opens the browser when instructions arrive.
                $parameters.UseDeviceAuthentication = $true
                Write-QueryAudit 'Connect-MgGraph' $parameters
                Connect-MgGraph @parameters 6>&1 | Write-AuthOutput
                Write-QueryAudit 'Get-MgContext'
                $context = Get-MgContext
                if ($context.TenantId -ne $request.tenant) {
                    Write-QueryAudit 'Disconnect-MgGraph'
                    Disconnect-MgGraph | Out-Null
                    throw "Graph returned tenant '$($context.TenantId)' instead of requested tenant '$($request.tenant)'. The connection was closed. Confirm the access package is active for the customer tenant and that your signed-in account has the required Graph access there."
                }
                $script:graph = $true
                $script:tenant = $context.TenantId
                $script:account = $context.Account
                $script:graphAccount = $context.Account
                $data = Get-State
            }
            'exchange' {
                if ($script:exchange) { throw 'Exchange is already connected.' }
                $targetTenant = if ($request.tenant) { [string]$request.tenant } else { $script:tenant }
                if ($targetTenant -notmatch '^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$') { throw 'Enter the investigation tenant ID as a GUID.' }
                if ($script:graph -and $targetTenant -ne $script:tenant) { throw 'Exchange must use the connected investigation tenant. Reset to change tenant.' }
                $access = if ($request.access) { [string]$request.access } else { 'direct' }
                if ($access -notin @('direct','delegated')) { throw 'Choose direct or guest / delegated Exchange access.' }
                Require-Module 'ExchangeOnlineManagement'
                $parameters = @{ Device = $true; ShowBanner = $false }
                if ($access -eq 'delegated') { $parameters.DelegatedOrganization = $targetTenant }
                Write-Host "Requesting an Exchange device code for target tenant $targetTenant ($access access). Enter the code shown below on the Microsoft sign-in page."
                Write-QueryAudit 'Connect-ExchangeOnline' $parameters
                Connect-ExchangeOnline @parameters 6>&1 | Write-AuthOutput
                Write-QueryAudit 'Get-ConnectionInformation'
                $connections = @(Get-ConnectionInformation | Where-Object { $_.State -eq 'Connected' })
                # Delegated connections can authenticate in the analyst's home
                # tenant. Validate the mapped customer organization, not that
                # authentication tenant. The app always supplies a GUID target.
                $wrongTarget = @($connections | Where-Object {
                    if ($access -eq 'delegated') { [string]$_.DelegatedOrganization -ne $targetTenant }
                    else { $_.TenantID -ne $targetTenant -or ($_.DelegatedOrganization -and $_.DelegatedOrganization -ne $targetTenant) }
                })
                if ($connections.Count -eq 0 -or $wrongTarget.Count -gt 0) {
                    $observed = ($connections | ForEach-Object { "sign-in tenant=$($_.TenantID), delegated organization=$($_.DelegatedOrganization)" }) -join '; '
                    Write-QueryAudit 'Disconnect-ExchangeOnline' @{ Confirm = $false }
                    Disconnect-ExchangeOnline -Confirm:$false | Out-Null
                    throw "Exchange target verification failed for requested tenant '$targetTenant' ($access access). Returned: $observed. Connection closed. For access-package or guest accounts, select Guest / delegated access and confirm access is active in the customer tenant."
                }
                $script:exchange = $true
                $script:tenant = $targetTenant
                $script:exchangeAccount = [string]$connections[0].UserPrincipalName
                $script:exchangeAccess = $access
                $script:exchangeAuthTenant = [string]$connections[0].TenantID
                Write-Host "Exchange target verified: $targetTenant. Signed in as $($script:exchangeAccount) (sign-in tenant $($script:exchangeAuthTenant))."
                if (-not $script:graph) { $script:account = $script:exchangeAccount }
                $data = Get-State
            }
            'collect-identity' {
                if (-not $script:graph) { throw 'Connect Microsoft Graph first.' }
                if ($request.kind -notin @('risk-detections', 'devices', 'app-consents')) { throw 'Unknown identity module.' }
                $identity = Read-GraphObject ('https://graph.microsoft.com/v1.0/users/' + [Uri]::EscapeDataString($request.user) + '?$select=id,userPrincipalName')
                if (-not $identity.id) { throw 'Could not resolve the affected account.' }
                $userId = [string]$identity.id
                $rows = @()
                $history = @()
                $risk = @{}
                if ($request.kind -eq 'risk-detections') {
                    # Query every retained detection for this account; filter activity OR detection
                    # time locally so offline detections are not lost at the window boundary.
                    $risk = Read-IdentityRisk $request $userId
                    $rows = $risk.rows
                } elseif ($request.kind -eq 'devices') {
                    $devicePath = '/v1.0/users/' + [Uri]::EscapeDataString($userId) + '/ownedDevices'
                    $owned = @(Read-GraphPages ('https://graph.microsoft.com' + $devicePath) $devicePath)
                    $rows = @($owned | Where-Object { $_.'@odata.type' -eq '#microsoft.graph.device' -or $_.deviceId })
                    # Fetch full current device objects, including registrationDateTime and
                    # compliance, rather than relying on limited relationship projections.
                    $rows = @($rows | ForEach-Object {
                        Read-GraphObject ('https://graph.microsoft.com/v1.0/devices/' + [Uri]::EscapeDataString($_.id))
                    })
                    $related = @($rows | ForEach-Object { $_.id; $_.deviceId })
                    $history = @(Read-RelatedAuditEvents $request $userId $related 'devices')
                } else {
                    $grants = [System.Collections.Generic.List[object]]::new()
                    foreach ($filter in @("principalId eq '$($userId.Replace("'", "''"))'", "consentType eq 'AllPrincipals'")) {
                        $uri = 'https://graph.microsoft.com/v1.0/oauth2PermissionGrants?$filter=' + [Uri]::EscapeDataString($filter)
                        foreach ($grant in @(Read-GraphPages $uri '/v1.0/oauth2PermissionGrants')) { $grants.Add($grant) }
                    }
                    $applications = @{}
                    $rows = @($grants | ForEach-Object {
                        $grant = $_
                        foreach ($spId in @($grant.clientId, $grant.resourceId)) {
                            if (-not $spId) { throw 'Permission grant contains no application reference.' }
                            if (-not $applications.ContainsKey($spId)) {
                                $applications[$spId] = Read-GraphObject ('https://graph.microsoft.com/v1.0/servicePrincipals/' + [Uri]::EscapeDataString($spId) + '?$select=id,appId,displayName,appOwnerOrganizationId,verifiedPublisher') -AllowMissing
                            }
                        }
                        @{ grant = $grant; client = $applications[$grant.clientId]; resource = $applications[$grant.resourceId] }
                    })
                    $related = @($grants | ForEach-Object { $_.clientId; $_.id })
                    $history = @(Read-RelatedAuditEvents $request $userId $related 'app-consents')
                }
                $data = @{ userId = $userId; userPrincipalName = $identity.userPrincipalName; rows = @($rows); relatedAudits = @($history) }
                if ($request.kind -eq 'risk-detections') {
                    foreach ($key in @('riskyUser', 'riskHistory', 'riskySignIns', 'riskSources')) { $data[$key] = $risk[$key] }
                }
            }
            'collect-audits' {
                if (-not $script:graph) { throw 'Connect Microsoft Graph first.' }
                $startTime = [DateTimeOffset]::Parse($request.start).ToUniversalTime()
                $endTime = [DateTimeOffset]::Parse($request.end).ToUniversalTime()
                $start = $startTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
                $end = $endTime.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
                $userUri = 'https://graph.microsoft.com/v1.0/users/' + [Uri]::EscapeDataString($request.user) + '?$select=id,userPrincipalName'
                Write-QueryAudit 'Invoke-MgGraphRequest' @{ Method = 'GET'; Uri = $userUri; purpose = 'Resolve affected account object ID' }
                $identity = Invoke-MgGraphRequest -Method GET -Uri $userUri -OutputType PSObject
                if (-not $identity.id) { throw 'Could not resolve the affected account object ID.' }
                $filter = "activityDateTime ge $start and activityDateTime le $end"
                $uri = 'https://graph.microsoft.com/v1.0/auditLogs/directoryAudits?$top=1000&$filter=' + [Uri]::EscapeDataString($filter)
                $matched = [System.Collections.Generic.List[object]]::new()
                $seen = [System.Collections.Generic.HashSet[string]]::new()
                $scanned = 0
                do {
                    $parsed = [Uri]$uri
                    if ($parsed.Scheme -ne 'https' -or $parsed.Host -ne 'graph.microsoft.com' -or $parsed.AbsolutePath -ne '/v1.0/auditLogs/directoryAudits') {
                        throw 'Unexpected Graph audit pagination URL.'
                    }
                    Write-QueryAudit 'Invoke-MgGraphRequest' @{ Method = 'GET'; Uri = $uri; user = $request.user; userId = $identity.id; scope = 'Time-window scan; match actor or target by ID/UPN' }
                    $page = Invoke-MgGraphRequest -Method GET -Uri $uri -OutputType PSObject
                    foreach ($row in $page.value) {
                        $scanned++
                        $eventTime = [DateTimeOffset]::Parse($row.activityDateTime)
                        if ($eventTime -lt $startTime -or $eventTime -ge $endTime) { continue }
                        $actor = $row.initiatedBy.user
                        $isActor = ($actor.id -eq $identity.id -or $actor.userPrincipalName -eq $request.user)
                        $isTarget = @($row.targetResources | Where-Object { $_.id -eq $identity.id -or $_.userPrincipalName -eq $request.user }).Count -gt 0
                        if (($isActor -or $isTarget) -and $seen.Add([string]$row.id)) { $matched.Add($row) }
                    }
                    Write-Host "Scanned $scanned directory audit events; $($matched.Count) match the affected account..."
                    $uri = $page.'@odata.nextLink'
                } while ($uri)
                $data = @{ userId = [string]$identity.id; rows = @($matched | Sort-Object activityDateTime -Descending) }
            }
            'collect' {
                if (-not $script:graph) { throw 'Connect Microsoft Graph first.' }
                $start = [DateTimeOffset]::Parse($request.start).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
                $end = [DateTimeOffset]::Parse($request.end).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
                $user = $request.user.Replace("'", "''")
                $all = [System.Collections.Generic.List[object]]::new()
                $seen = [System.Collections.Generic.HashSet[string]]::new()
                foreach ($kind in @('interactiveUser', 'nonInteractiveUser')) {
                    $filter = "createdDateTime ge $start and createdDateTime lt $end and userPrincipalName eq '$user' and signInEventTypes/any(t:t eq '$kind')"
                    # Beta explicitly supports both user sign-in event categories.
                    $uri = 'https://graph.microsoft.com/beta/auditLogs/signIns?$top=1000&$filter=' + [Uri]::EscapeDataString($filter)
                    do {
                        $parsed = [Uri]$uri
                        if ($parsed.Scheme -ne 'https' -or $parsed.Host -ne 'graph.microsoft.com' -or $parsed.AbsolutePath -ne '/beta/auditLogs/signIns') {
                            throw 'Unexpected Graph pagination URL.'
                        }
                        Write-QueryAudit 'Invoke-MgGraphRequest' @{ Method = 'GET'; Uri = $uri; OutputType = 'PSObject'; eventType = $kind; user = $request.user; start = $start; end = $end }
                        $page = Invoke-MgGraphRequest -Method GET -Uri $uri -OutputType PSObject
                        foreach ($row in $page.value) {
                            if ($seen.Add([string]$row.id)) { $all.Add($row) }
                        }
                        Write-Host "Fetched $($all.Count) sign-ins ($kind)..."
                        $uri = $page.'@odata.nextLink'
                    } while ($uri)
                }
                $data = @{ rows = @($all | Sort-Object createdDateTime -Descending) }
            }
            'collect-m365' { $data = Read-M365Collection $request }
            'collect-ual' { $data = Read-UalCollection $request }
            default { throw 'Unsupported session operation.' }
        }
        $reply = @{ ok = $true; data = $data }
    } catch {
        $reply = @{ ok = $false; error = $_.Exception.Message }
    }
    [Console]::WriteLine('BEC_RESULT:' + ($reply | ConvertTo-Json -Depth 100 -Compress))
}
