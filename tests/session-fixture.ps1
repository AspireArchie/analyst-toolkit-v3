# Offline test doubles: no modules are installed and no Microsoft requests run.
function Get-Module { param($Name, [switch]$ListAvailable) return @{ Name = $Name } }
function Import-Module { param($Name, $ErrorAction) }
function Connect-MgGraph {
    [CmdletBinding()]
    param($TenantId, $Scopes, [switch]$UseDeviceAuthentication, $ContextScope, [switch]$NoWelcome)
    if (-not $UseDeviceAuthentication) { throw 'Device authentication was not enabled' }
    $script:testTenant = $TenantId
    Write-Host ('TEST_SCOPES:' + ($Scopes -join ','))
    # Reproduce the SDK versions that emit instructions on the success stream.
    'To sign in, use a web browser to open https://microsoft.com/devicelogin and enter the code TESTCODE1'
}
function Get-MgContext { @{ TenantId = $script:testTenant; Account = 'analyst@contoso.com' } }
function Connect-ExchangeOnline {
    [CmdletBinding()]
    param([switch]$Device, $ShowBanner)
    Write-Information 'Exchange: open https://microsoft.com/devicelogin and enter code TESTCODE2'
}
function Get-ConnectionInformation { @{ State = 'Connected'; TenantID = 'wrong-tenant' } }
function Disconnect-ExchangeOnline { param($Confirm) }
function Invoke-MgGraphRequest {
    param($Method, $Uri, $OutputType)
    if ($Uri -match '/v1.0/users/') {
        $script:failRiskHistory = $Uri -match 'riskfail'
        if ($Uri -match '/ownedDevices') {
            $script:identityModule = 'devices'
            return @{ value = @(@{ '@odata.type' = '#microsoft.graph.device'; id = 'device-object-1' }); '@odata.nextLink' = $(if ($Uri -notmatch 'device-next') { 'https://graph.microsoft.com/v1.0/users/affected-user-id/ownedDevices?device-next=2' } else { $null }) }
        }
        $script:identityModule = ''
        $script:failAuditPage = $Uri -match 'failaudit'
        return @{ id = 'affected-user-id'; userPrincipalName = 'user@contoso.com' }
    }
    if ($Uri -match '/identityProtection/riskyUsers/') {
        if ($Uri -match '/history') {
            if ($script:failRiskHistory) { throw 'Simulated risk history permission denied' }
            if ($Uri -match 'history-next') { return @{ value = @(@{ id = 'risk-history-2'; userId = 'affected-user-id'; riskLevel = 'none'; riskState = 'dismissed'; riskLastUpdatedDateTime = '2026-01-01T04:00:00Z' }) } }
            return @{ value = @(@{ id = 'risk-history-1'; userId = 'affected-user-id'; riskLevel = 'high'; riskState = 'atRisk'; riskLastUpdatedDateTime = '2026-01-01T03:00:00Z'; initiatedBy = 'admin-id' }); '@odata.nextLink' = 'https://graph.microsoft.com/v1.0/identityProtection/riskyUsers/affected-user-id/history?history-next=2' }
        }
        return @{ id = 'affected-user-id'; riskLevel = 'high'; riskState = 'atRisk'; userPrincipalName = 'user@contoso.com'; riskLastUpdatedDateTime = '2025-01-01T00:00:00Z' }
    }
    if ($Uri -match 'risk-signin-next') { return @{ value = @(@{ id = 'risk-signin-two'; userId = 'affected-user-id'; riskLevelDuringSignIn = 'medium'; createdDateTime = '2026-01-01T02:00:00Z'; riskState = 'remediated' }) } }
    if ($Uri -match '/beta/auditLogs/signIns' -and [Uri]::UnescapeDataString($Uri) -match "userId eq 'affected-user-id'") {
        $kind = if ([Uri]::UnescapeDataString($Uri) -match 'nonInteractiveUser') { 'nonInteractiveUser' } else { 'interactiveUser' }
        return @{ value = @(@{ id = "risk-signin-$kind"; userId = 'affected-user-id'; signInEventTypes = @($kind); riskLevelAggregated = 'high'; createdDateTime = '2026-01-01T01:00:00Z' }, @{ id = 'safe-signin'; riskLevelAggregated = 'none'; riskState = 'none' }); '@odata.nextLink' = 'https://graph.microsoft.com/beta/auditLogs/signIns?risk-signin-next=2' }
    }
    if ($Uri -match '/identityProtection/riskDetections') {
        if ($Uri -match 'risk-next') { return @{ value = @(@{ id = 'risk-2'; userId = 'affected-user-id'; riskEventType = 'leakedCredentials'; riskLevel = 'medium'; detectedDateTime = '2026-01-01T02:00:00Z' }) } }
        return @{ value = @(@{ id = 'risk-1'; userId = 'affected-user-id'; riskEventType = 'unfamiliarFeatures'; riskLevel = 'high'; activityDateTime = '2025-12-31T22:00:00Z'; detectedDateTime = '2026-01-01T01:00:00Z'; requestId = 'sign-in-1' }); '@odata.nextLink' = 'https://graph.microsoft.com/v1.0/identityProtection/riskDetections?risk-next=2' }
    }
    if ($Uri -match '/v1.0/devices/') { return @{ id = 'device-object-1'; deviceId = 'device-guid'; displayName = 'Laptop'; operatingSystem = 'Windows'; trustType = 'AzureAd'; registrationDateTime = '2026-01-01T03:00:00Z'; isCompliant = $false } }
    if ($Uri -match '/oauth2PermissionGrants') {
        $script:identityModule = 'app-consents'
        $decoded = [Uri]::UnescapeDataString($Uri)
        if ($decoded -match 'AllPrincipals') { return @{ value = @(@{ id = 'tenant-grant'; clientId = 'client-sp'; resourceId = 'resource-sp'; consentType = 'AllPrincipals'; scope = 'Mail.ReadWrite Contacts.Read' }) } }
        return @{ value = @(@{ id = 'user-grant'; clientId = 'client-sp'; resourceId = 'resource-sp'; principalId = 'affected-user-id'; consentType = 'Principal'; scope = 'User.Read' }) }
    }
    if ($Uri -match '/servicePrincipals/') { return @{ id = $(if ($Uri -match 'client-sp') { 'client-sp' } else { 'resource-sp' }); appId = 'app-guid'; displayName = $(if ($Uri -match 'client-sp') { 'Example client' } else { 'Microsoft Graph' }) } }
    if ($Uri -match '/v1.0/auditLogs/directoryAudits') {
        if ($script:identityModule) {
            return @{ value = @(@{ id = 'history-event'; activityDateTime = '2026-01-01T04:00:00Z'; activityDisplayName = $(if ($script:identityModule -eq 'devices') { 'Delete device' } else { 'Consent to application' }); initiatedBy = @{ user = @{ id = 'admin-id' } }; targetResources = @(@{ id = 'deleted-device-or-app'; modifiedProperties = @(@{ displayName = 'PrincipalId'; newValue = 'affected-user-id' }) }) }) }
        }
        if ($Uri -match 'audit-next=') {
            if ($script:failAuditPage) { throw 'Simulated audit second-page failure' }
            return @{ value = @(
                @{ id = 'target-only'; activityDateTime = '2026-01-01T02:00:00Z'; activityDisplayName = 'Reset user password'; initiatedBy = @{ app = @{ displayName = 'Automation' } }; targetResources = @(@{ id = 'group-id' }, @{ id = 'affected-user-id' }) },
                @{ id = 'actor-only'; activityDateTime = '2026-01-01T01:00:00Z'; initiatedBy = @{ user = @{ id = 'affected-user-id' } } },
                @{ id = 'end-boundary'; activityDateTime = '2026-01-02T00:00:00Z'; initiatedBy = @{ user = @{ id = 'affected-user-id' } } }
            ) }
        }
        $decoded = [Uri]::UnescapeDataString($Uri)
        if ($decoded -notmatch 'activityDateTime ge 2026-01-01' -or $decoded -notmatch 'activityDateTime le 2026-01-02') { throw 'Missing audit date filter' }
        return @{ value = @(
            @{ id = 'actor-only'; activityDateTime = '2026-01-01T01:00:00Z'; activityDisplayName = 'Add member to group'; initiatedBy = @{ user = @{ id = 'affected-user-id' } } },
            @{ id = 'upn-only'; activityDateTime = '2026-01-01T03:00:00Z'; activityDisplayName = 'Update authentication method'; targetResources = @(@{ userPrincipalName = 'USER@CONTOSO.COM' }) },
            @{ id = 'both'; activityDateTime = '2026-01-01T04:00:00Z'; initiatedBy = @{ user = @{ id = 'affected-user-id' } }; targetResources = @(@{ id = 'affected-user-id' }) },
            @{ id = 'unrelated'; activityDateTime = '2026-01-01T05:00:00Z'; initiatedBy = @{ user = @{ id = 'someone-else' } } }
        ); '@odata.nextLink' = 'https://graph.microsoft.com/v1.0/auditLogs/directoryAudits?audit-next=2' }
    }
    if ($Uri -match 'fail%40contoso.com') { throw 'Simulated Graph permission failure' }
    if ($Uri -match 'next=') {
        $kind = if ($Uri -match 'noninteractive') { 'nonInteractiveUser' } else { 'interactiveUser' }
        return @{ value = @(@{ id = "$kind-2"; signInEventTypes = @($kind); isInteractive = ($kind -eq 'interactiveUser'); createdDateTime = '2026-01-01T02:00:00Z' }) }
    }
    $decoded = [Uri]::UnescapeDataString($Uri)
    if ($decoded -notmatch "userPrincipalName eq 'user@contoso.com'" -or $decoded -notmatch 'createdDateTime ge' -or $decoded -notmatch 'createdDateTime lt') { throw 'Missing user or date filter' }
    $kind = if ($decoded -match "eq 'nonInteractiveUser'") { 'nonInteractiveUser' } else { 'interactiveUser' }
    $next = if ($kind -eq 'nonInteractiveUser') { 'noninteractive' } else { 'interactive' }
    return @{ value = @(@{ id = "$kind-1"; signInEventTypes = @($kind); isInteractive = ($kind -eq 'interactiveUser'); createdDateTime = '2026-01-01T01:00:00Z' }); '@odata.nextLink' = "https://graph.microsoft.com/beta/auditLogs/signIns?next=$next" }
}
. "$PSScriptRoot/../powershell/session.ps1"
