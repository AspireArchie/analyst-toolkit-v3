function Invoke-M365Read([string]$Name, $Parameters = @{}) {
    Write-QueryAudit $Name $Parameters
    & $Name @Parameters -ErrorAction Stop
}

function Read-TraceRange($Request, [datetime]$Start, [datetime]$End, [int]$Limit = 5000) {
    $parameters = @{ StartDate = $Start; EndDate = $End; ResultSize = 5000 }
    if ($Request.messageTraceId) { $parameters.MessageTraceId = $Request.messageTraceId }
    if ($Request.kind -eq 'trace-outbound') {
        $parameters.SenderAddress = @($Request.aliases)
        if ($Request.party) { $parameters.RecipientAddress = @($Request.party) }
    } else {
        $parameters.RecipientAddress = @($Request.aliases)
        if ($Request.party) { $parameters.SenderAddress = @($Request.party) }
    }
    $rows = @(Invoke-M365Read 'Get-MessageTraceV2' $parameters)
    if ($rows.Count -ge $Limit) {
        if (($End - $Start).TotalSeconds -le 1) { throw 'Message trace saturated a one-second window. Narrow the counterparty/timeframe; a complete export cannot be guaranteed.' }
        $middle = $Start.AddTicks([long](($End.Ticks - $Start.Ticks) / 2))
        Read-TraceRange $Request $Start $middle $Limit
        Read-TraceRange $Request $middle $End $Limit
    } else { foreach ($row in $rows) { $row } }
}

function Read-M365Trace($Request) {
    $start = [datetime]::Parse($Request.start).ToUniversalTime(); $end = [datetime]::Parse($Request.end).ToUniversalTime()
    while ($start -lt $end) {
        $next = $start.AddDays(10); if ($next -gt $end) { $next = $end }
        $initial = @(Read-TraceRange $Request $start $next)
        foreach ($row in $initial) { $row }
        # The service requires MessageTraceId to expand messages with very large
        # recipient sets. Requery those observed at the 1,000-recipient boundary.
        if (-not $Request.messageTraceId) {
            foreach ($group in @($initial | Group-Object MessageTraceId | Where-Object { $_.Name -and @($_.Group.RecipientAddress | Sort-Object -Unique).Count -ge 1000 })) {
                $expanded = @{} + $Request
                $expanded.messageTraceId = $group.Name
                Read-TraceRange $expanded $start $next
            }
        }
        $start = $next
    }
}

function Read-M365Quarantine($Request) {
    $seen = [Collections.Generic.HashSet[string]]::new()
    for ($number = 1; $number -le 10000; $number++) {
        $page = @(Invoke-M365Read 'Get-QuarantineMessage' @{ RecipientAddress = @($Request.aliases); StartReceivedDate = [datetime]::Parse($Request.start).ToUniversalTime(); EndReceivedDate = [datetime]::Parse($Request.end).ToUniversalTime(); Page = $number; PageSize = 1000 })
        $added = 0
        foreach ($row in $page) {
            $key = if ($row.Identity) { [string]$row.Identity } else { $row | ConvertTo-Json -Depth 30 -Compress }
            if ($seen.Add($key)) { $row; $added++ }
        }
        if ($page.Count -lt 1000) { return }
        if (-not $added) { throw 'Quarantine pagination repeated without progress. No partial collection accepted.' }
    }
    throw 'Quarantine exceeded the collection page guard. Narrow the time range.'
}

function Invoke-M365Hunting([string]$Query, $Request) {
    $body = @{ Query = $Query; Timespan = "$($Request.start)/$($Request.end)" }
    $uri = 'https://graph.microsoft.com/v1.0/security/runHuntingQuery'
    Write-QueryAudit 'Invoke-MgGraphRequest' @{ Method = 'POST'; Uri = $uri; Body = $body; purpose = 'Read-only Defender email/URL metadata hunting' }
    $response = Invoke-MgGraphRequest -Method POST -Uri $uri -Body ($body | ConvertTo-Json -Compress) -ContentType 'application/json; charset=utf-8' -OutputType PSObject
    if ($response.error -or $response.'@odata.nextLink' -or $null -eq $response.results) { throw 'Defender returned an error, unexpected pagination or no results array.' }
    @($response.results)
}

function Read-HuntingRange([string]$Table, $Request, [datetime]$Start, [datetime]$End, [int]$Limit = 30000) {
    $addresses = (@($Request.aliases) | ForEach-Object { ConvertTo-Json -InputObject ([string]$_) -Compress }) -join ', '
    $range = "Timestamp >= datetime($($Start.ToString('o'))) and Timestamp < datetime($($End.ToString('o')))"
    $scope = if ($Table -eq 'UrlClickEvents') { "AccountUpn in~ ($addresses)" } else { "RecipientEmailAddress in~ ($addresses)" }
    if ($Table -eq 'EmailUrlInfo') {
        $messages = "EmailEvents | where Timestamp >= datetime($($Request.start)) and Timestamp < datetime($($Request.end)) | where RecipientEmailAddress in~ ($addresses) | distinct NetworkMessageId"
        $scope = "NetworkMessageId in ($messages)"
    }
    $base = "$Table | where $range | where $scope"
    $countRows = @(Invoke-M365Hunting "$base | summarize ExpectedCount=count()" $Request)
    if ($countRows.Count -ne 1 -or $null -eq $countRows[0].ExpectedCount) { throw 'Defender did not return a verifiable result count.' }
    $expected = [long]$countRows[0].ExpectedCount
    if ($expected -eq 0) { return }
    $rows = @()
    if ($expected -lt $Limit) { $rows = @(Invoke-M365Hunting "$base | take $Limit" $Request) }
    if ($expected -ge $Limit -or $rows.Count -ne $expected) {
        if (($End - $Start).TotalSeconds -le 1) { throw 'Defender results exceeded the safe collection limit or changed during retrieval. Narrow the timeframe and retry.' }
        $middle = $Start.AddTicks([long](($End.Ticks - $Start.Ticks) / 2))
        Read-HuntingRange $Table $Request $Start $middle $Limit
        Read-HuntingRange $Table $Request $middle $End $Limit
    } else { foreach ($row in $rows) { $row } }
}

function Read-M365Collection($Request) {
    $Request = @{ kind = $Request.kind; user = $Request.user; start = $Request.start; end = $Request.end; party = $Request.party }
    $names = switch ($Request.kind) {
        'inbox-rules' { @('mailbox', 'inbox-rules', 'rule-history') }
        'trace-outbound' { @('mailbox', 'trace', 'accepted-domains') }
        'trace-inbound' { @('mailbox', 'trace', 'inbox-rules') }
        'defender-review' { @('mailbox', 'quarantine', 'EmailEvents', 'EmailUrlInfo', 'UrlClickEvents', 'EmailPostDeliveryEvents') }
        'forwarding' { @('mailbox', 'transport-rules') }
        default { throw 'Unknown Microsoft 365 module.' }
    }
    $Request.aliases = @($Request.user)
    $sources = [Collections.Generic.List[object]]::new()
    foreach ($name in $names) {
        try {
            $rows = @(); $metadata = @{}
            if ($name -in @('EmailEvents', 'EmailUrlInfo', 'UrlClickEvents', 'EmailPostDeliveryEvents')) {
                if (-not $script:graph) { throw 'Graph connection unavailable.' }
                $rows = @(Read-HuntingRange $name $Request ([datetime]::Parse($Request.start).ToUniversalTime()) ([datetime]::Parse($Request.end).ToUniversalTime()))
            } else {
                if (-not $script:exchange -and -not ($name -eq 'mailbox' -and $Request.kind -eq 'defender-review' -and $script:graph)) { throw 'Exchange connection unavailable.' }
                switch ($name) {
                    'mailbox' {
                        if ($script:exchange) {
                            $rows = @(Invoke-M365Read 'Get-Mailbox' @{ Identity = $Request.user } | Select-Object Identity, UserPrincipalName, PrimarySmtpAddress, EmailAddresses, ForwardingSmtpAddress, ForwardingAddress, DeliverToMailboxAndForward, WhenCreated, WhenChanged)
                        } else {
                            $user = Read-GraphObject ('https://graph.microsoft.com/v1.0/users/' + [Uri]::EscapeDataString($Request.user) + '?$select=id,userPrincipalName,mail,proxyAddresses')
                            $rows = @($user)
                        }
                        if (-not $rows.Count) { throw 'Mailbox/account identity was not returned.' }
                        $addresses = @($Request.user; $rows[0].PrimarySmtpAddress; $rows[0].mail; $rows[0].EmailAddresses; $rows[0].proxyAddresses) | ForEach-Object { ([string]$_) -replace '^(?i)smtp:', '' } | Where-Object { $_ -match '^[^\s@:]+@[^\s@]+\.[^\s@]+$' } | Sort-Object -Unique
                        $Request.aliases = @($addresses)
                        $metadata.identity = $rows[0]
                    }
                    'inbox-rules' {
                        $rows = @(Invoke-M365Read 'Get-InboxRule' @{ Mailbox = $Request.user; IncludeHidden = $true } | Select-Object Identity, RuleIdentity, Name, Enabled, Priority, Description, WhenCreated, WhenChanged, IsValid, InError, From, SentTo, SentToMe, SubjectContainsWords, SubjectOrBodyContainsWords, BodyContainsWords, HeaderContainsWords, RecipientAddressContainsWords, SenderAddressContainsWords, FromAddressContainsWords, 'ExceptIf*', ForwardTo, ForwardAsAttachmentTo, RedirectTo, DeleteMessage, MoveToFolder, CopyToFolder, MarkAsRead, StopProcessingRules)
                    }
                    'rule-history' {
                        # Tenant operation search includes administrators/delegates. Only
                        # matching mailbox/actor events are attributed in the app.
                        $audit = Read-UalCollection @{ user = $Request.user; start = $Request.start; end = $Request.end; omitUserFilter = $true; operations = @('New-InboxRule', 'Set-InboxRule', 'Remove-InboxRule', 'UpdateInboxRules') }
                        $rows = @($audit.rows); $metadata = @{ retrieval = $audit.retrieval; auditChecks = $audit.auditChecks; actorFilter = 'omitted; tenant operation search, mailbox matching in application' }
                    }
                    'trace' { $rows = @(Read-M365Trace $Request) }
                    'accepted-domains' { $rows = @(Invoke-M365Read 'Get-AcceptedDomain' | Select-Object DomainName, DomainType); $metadata.domains = @($rows) }
                    'quarantine' { $rows = @(Read-M365Quarantine $Request) }
                    'transport-rules' { $rows = @(Invoke-M365Read 'Get-TransportRule' @{ ResultSize = 'Unlimited' } | Where-Object { $_.RedirectMessageTo -or $_.BlindCopyTo -or $_.CopyTo -or $_.AddToRecipients } | Select-Object Identity, Guid, Name, State, Mode, Priority, Description, WhenChanged, RedirectMessageTo, BlindCopyTo, CopyTo, AddToRecipients, From, SentTo, FromScope, SentToScope, 'ExceptIf*') }
                }
            }
            $sources.Add(@{ name = $name; ok = $true; rows = @($rows); metadata = $metadata; checkedAt = [datetime]::UtcNow.ToString('o') })
        } catch {
            $sources.Add(@{ name = $name; ok = $false; rows = @(); error = $_.Exception.Message; checkedAt = [datetime]::UtcNow.ToString('o') })
            Write-Host "Microsoft 365 source unavailable ($name): $($_.Exception.Message)"
        }
    }
    return @{ sources = @($sources.ToArray()); aliases = @($Request.aliases) }
}
