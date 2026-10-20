# Offline Microsoft 365 cmdlets and Graph responses. No external connections.
function Get-Module { param($Name,[switch]$ListAvailable) @{Name=$Name} }
function Import-Module { param($Name,$ErrorAction) }
function Connect-MgGraph { [CmdletBinding()] param($TenantId,$Scopes,[switch]$UseDeviceAuthentication,$ContextScope,[switch]$NoWelcome) $script:tenantFixture=$TenantId }
function Get-MgContext { @{TenantId=$script:tenantFixture;Account='analyst@contoso.com'} }
function Connect-ExchangeOnline { [CmdletBinding()] param([switch]$Device,$ShowBanner) }
function Get-ConnectionInformation { @{State='Connected';TenantID=$script:tenantFixture} }
function Get-Mailbox { [CmdletBinding()] param($Identity) @{UserPrincipalName=$Identity;PrimarySmtpAddress='mail@contoso.com';EmailAddresses=@('SMTP:mail@contoso.com','smtp:alias@contoso.com');ForwardingSmtpAddress='smtp:outside@example.net';DeliverToMailboxAndForward=$true} }
function Get-InboxRule { [CmdletBinding()] param($Mailbox,[switch]$IncludeHidden) if(-not $IncludeHidden){throw 'Hidden rules omitted'};@{Identity='rule-1';Name='Hide replies';Enabled=$true;From=@('fraud@example.net');DeleteMessage=$true;Description='Deletes matching replies'} }
function Get-TransportRule { [CmdletBinding()] param($ResultSize) if($ResultSize -ne 'Unlimited'){throw 'Missing unlimited rule inventory'};@{Name='Blind copy';State='Enabled';Mode='Enforce';BlindCopyTo=@('external@example.net');Description='Tenant-wide rule'} }
function Get-AcceptedDomain { [CmdletBinding()] param() @{DomainName='contoso.com'} }
function Get-MessageTraceV2 { [CmdletBinding()] param([datetime]$StartDate,[datetime]$EndDate,$ResultSize,$SenderAddress,$RecipientAddress) if($ResultSize-ne5000){throw 'Missing trace result limit'};if($SenderAddress -notcontains 'mail@contoso.com' -and $RecipientAddress -notcontains 'mail@contoso.com'){throw 'Resolved mailbox address not queried'};@{MessageTraceId='trace-1';MessageId='msg-1';Received=$StartDate.ToString('o');SenderAddress=$(if($SenderAddress){$SenderAddress[0]}else{'fraud@example.net'});RecipientAddress=$(if($RecipientAddress){$RecipientAddress[0]}else{'external@example.net'});Subject='Invoice payment';Status='Delivered'} }
function Get-QuarantineMessage { [CmdletBinding()] param($RecipientAddress,$StartReceivedDate,$EndReceivedDate,$Page,$PageSize) if($Page-eq1){@{Identity='q-1';ReceivedTime=$StartReceivedDate;Subject='Lure';SenderAddress='trusted@example.net';Type='Phish'}} }
function Search-UnifiedAuditLog { [CmdletBinding()] param($StartDate,$EndDate,$UserIds,$ResultSize,$SessionId,$SessionCommand,$Operations,[switch]$HighCompleteness)
    if($UserIds){throw 'Historical rules must include other actors'}
    if($script:ualSeen -ne $SessionId){$script:ualSeen=$SessionId;@{Identity='rule-change';AuditData=(@{Id='rule-change';CreationTime=$StartDate.ToString('o');Operation='New-InboxRule';UserId='admin@contoso.com';ObjectId='user@contoso.com/Hide replies';ClientIP='203.0.113.8';Parameters=@(@{Name='DeleteMessage';Value='True'})}|ConvertTo-Json -Depth 10 -Compress)}}
}
function Invoke-MgGraphRequest { param($Method,$Uri,$Body,$ContentType,$OutputType)
    if($Uri -notmatch '/security/runHuntingQuery'){throw 'Unexpected Graph URL'}
    $request=$Body|ConvertFrom-Json
    if($request.Query -match '^EmailUrlInfo'){throw 'Simulated unavailable licensed table'}
    if($request.Query -notmatch 'mail@contoso.com'){throw 'Hunting alias scope missing'}
    if($request.Query -match 'summarize ExpectedCount'){return @{results=@(@{ExpectedCount=1})}}
    @{results=@(@{Timestamp=[datetime]::UtcNow.AddHours(-1).ToString('o');Subject='AiTM lure';RecipientEmailAddress='mail@contoso.com';SenderFromAddress='trusted@example.net';ThreatTypes='Phish';DetectionMethods='URL detonation';NetworkMessageId='network-1'})}
}
. "$PSScriptRoot/../powershell/session.ps1"
