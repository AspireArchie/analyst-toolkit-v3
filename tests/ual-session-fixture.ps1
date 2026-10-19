function Get-Module { param($Name, [switch]$ListAvailable) @{ Name = $Name } }
function Import-Module { param($Name, $ErrorAction) }
function Connect-MgGraph { [CmdletBinding()] param($TenantId, $Scopes, [switch]$UseDeviceAuthentication, $ContextScope, [switch]$NoWelcome) $script:testTenant = $TenantId }
function Get-MgContext { @{ TenantId = $script:testTenant; Account = 'analyst@contoso.com' } }
function Connect-ExchangeOnline { [CmdletBinding()] param([switch]$Device, $ShowBanner) }
function Get-ConnectionInformation { @{ State = 'Connected'; TenantID = $script:testTenant } }
function Disconnect-ExchangeOnline { param($Confirm) }
$script:pages = @{}
function Search-UnifiedAuditLog {
    [CmdletBinding()]
    param([datetime]$StartDate, [datetime]$EndDate, $UserIds, $ResultSize, $SessionId, $SessionCommand, $Operations, [switch]$HighCompleteness)
    if ($SessionCommand -ne 'ReturnLargeSet' -or $ResultSize -ne 5000) { throw 'Wrong paging parameters' }
    if (-not $HighCompleteness) { throw 'High completeness was not enabled' }
    if ($Operations.Count -and $Operations[0] -ne 'Send') { throw 'Operations were not passed correctly' }
    if ($UserIds[0] -eq 'error@contoso.com') { throw 'Simulated page failure' }
    if ($UserIds[0] -eq 'empty@contoso.com') { return }
    if ($UserIds[0] -eq 'incomplete@contoso.com') { return @{ AuditSearchRequestMetadata = @{ moreRecordsAvailable = $true } } }
    $number = [int]$script:pages[$SessionId]; $script:pages[$SessionId] = $number + 1
    if ($UserIds[0] -eq 'malformed@contoso.com') {
        if ($number -eq 0) { return @{ Identity = 'missing-data'; CreationDate = $StartDate.ToString('o') } }
        return
    }
    if ($UserIds[0] -eq 'repeated@contoso.com') { $number = 0 }
    if ($number -eq 0) {
        for ($i = 0; $i -lt 5000; $i++) {
            @{ Identity = "event-$i"; AuditData = (@{ Id = "event-$i"; CreationTime = $StartDate.ToString('o'); Operation = 'Send'; UserId = $UserIds[0]; ClientIP = '203.0.113.8:5000' } | ConvertTo-Json -Compress) }
        }
    } elseif ($number -eq 1) {
        @{ Identity = 'event-0'; AuditData = '{"Id":"event-0"}' }
        @{ Identity = 'last-event'; AuditData = '{"Id":"last-event","Operation":"Send"}' }
    }
}
function Get-OrganizationConfig { [CmdletBinding()] param() @{ AuditDisabled = $true } }
function Get-AdminAuditLogConfig { [CmdletBinding()] param() @{ UnifiedAuditLogIngestionEnabled = $false } }
function Get-Mailbox { [CmdletBinding()] param($Identity) @{ AuditEnabled = $false; AuditOwner = @('Send') } }
function Get-MailboxAuditBypassAssociation { [CmdletBinding()] param($Identity) throw 'Simulated config access denied' }
. "$PSScriptRoot/../powershell/session.ps1"
