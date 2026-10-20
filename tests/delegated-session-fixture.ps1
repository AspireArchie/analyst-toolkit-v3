# Offline fixture distinguishes authentication tenant from managed organization.
function Get-Module { param($Name,[switch]$ListAvailable) @{Name=$Name} }
function Import-Module { param($Name,$ErrorAction) }
function Connect-ExchangeOnline {
    [CmdletBinding()] param([switch]$Device,$ShowBanner,$DelegatedOrganization)
    $script:fixtureDelegatedOrganization=$DelegatedOrganization
}
function Get-ConnectionInformation {
    $delegated=$script:fixtureDelegatedOrganization
    if ($delegated -eq '33333333-3333-3333-3333-333333333333') { $delegated='44444444-4444-4444-4444-444444444444' }
    if ($delegated -eq '00000000-0000-0000-0000-000000000000') { $delegated=$null }
    @{State='Connected';TenantID='22222222-2222-2222-2222-222222222222';UserPrincipalName='analyst@home.example';DelegatedOrganization=$delegated}
}
function Disconnect-ExchangeOnline { param($Confirm) }
function Connect-MgGraph {
    [CmdletBinding()] param($TenantId,$Scopes,[switch]$UseDeviceAuthentication,$ContextScope,[switch]$NoWelcome)
    $script:fixtureGraphTenant=$TenantId
}
function Get-MgContext {
    $tenant=$script:fixtureGraphTenant
    if($tenant -eq '33333333-3333-3333-3333-333333333333') { $tenant='22222222-2222-2222-2222-222222222222' }
    @{TenantId=$tenant;Account='analyst@home.example'}
}
function Disconnect-MgGraph {}
function Get-Mailbox { [CmdletBinding()] param($Identity) @{UserPrincipalName=$Identity;PrimarySmtpAddress=$Identity;EmailAddresses=@("SMTP:$Identity")} }
function Get-TransportRule { [CmdletBinding()] param($ResultSize) }
. "$PSScriptRoot/../powershell/session.ps1"
