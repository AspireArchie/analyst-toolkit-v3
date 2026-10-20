# Offline auth and Exchange collection doubles. Never contacts Microsoft.
function Get-Module { param($Name,[switch]$ListAvailable) @{Name=$Name} }
function Import-Module { param($Name,$ErrorAction) }
function Connect-ExchangeOnline { [CmdletBinding()] param([switch]$Device,$ShowBanner) }
function Disconnect-ExchangeOnline { param($Confirm) }
function Get-ConnectionInformation { @{State='Connected';TenantID='11111111-1111-1111-1111-111111111111';UserPrincipalName='exchange@contoso.com'} }
function Connect-MgGraph {
    [CmdletBinding()] param($TenantId,$Scopes,[switch]$UseDeviceAuthentication,$ContextScope,[switch]$NoWelcome)
    if ($script:exchange -and -not $script:deniedOnce) { $script:deniedOnce=$true; throw 'Graph consent denied by tenant' }
    $script:fixtureGraphTenant=$TenantId
}
function Disconnect-MgGraph {}
function Get-MgContext { @{TenantId=$script:fixtureGraphTenant;Account='graph@contoso.com'} }
function Get-Mailbox { [CmdletBinding()] param($Identity) @{UserPrincipalName=$Identity;PrimarySmtpAddress=$Identity;EmailAddresses=@("SMTP:$Identity");ForwardingSmtpAddress='smtp:external@example.net'} }
function Get-TransportRule { [CmdletBinding()] param($ResultSize) }
function Get-InboxRule { [CmdletBinding()] param($Mailbox,[switch]$IncludeHidden) @{Identity='rule-1';Name='Current rule';Enabled=$true;Priority=1;Description='Current configuration only'} }
. "$PSScriptRoot/../powershell/session.ps1"
