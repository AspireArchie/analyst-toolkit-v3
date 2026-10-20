function Get-UalKey($Row) {
    if ($Row.Identity) { return [string]$Row.Identity }
    $text = if ($Row.AuditData -is [string]) { $Row.AuditData } else { $Row | ConvertTo-Json -Depth 100 -Compress }
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($text)))
}

function Read-UalRange([datetime]$Start, [datetime]$End, $Request, $Stats, [int]$Limit = 50000) {
    $sessionId = [guid]::NewGuid().ToString()
    $rows = [Collections.Generic.List[object]]::new()
    $seen = [Collections.Generic.HashSet[string]]::new()
    $Stats.windows++
    while ($true) {
        $parameters = @{ StartDate = $Start; EndDate = $End; UserIds = @($Request.user); ResultSize = 5000; SessionId = $sessionId; SessionCommand = 'ReturnLargeSet'; ErrorAction = 'Stop' }
        if ($Request.omitUserFilter) { $parameters.Remove('UserIds') }
        if (@($Request.operations).Count) { $parameters.Operations = @($Request.operations) }
        if ($Stats.highCompleteness) { $parameters.HighCompleteness = $true }
        Write-QueryAudit 'Search-UnifiedAuditLog' $parameters
        $page = @(Search-UnifiedAuditLog @parameters)
        $Stats.pages++
        $events = @($page | Where-Object { $null -ne $_.AuditData -or $_.Identity -or $_.CreationDate -or $_.Operations })
        $more = @($page | Where-Object { $_.AuditSearchRequestMetadata.moreRecordsAvailable -eq $true }).Count -gt 0
        if (-not $events.Count) {
            if ($more) { throw 'UAL reported more records but returned an empty page. Collection incomplete; retry the search.' }
            break
        }
        $added = 0
        foreach ($row in $events) {
            $rows.Add($row)
            if ($seen.Add((Get-UalKey $row))) { $added++ }
        }
        Write-Host "UAL: $($rows.Count) records fetched in current window..."
        if ($rows.Count -ge $Limit) {
            if (($End - $Start).TotalSeconds -le 1) { throw 'UAL search saturated a one-second window. Narrow the operations or account scope; complete results cannot be guaranteed.' }
            $middle = $Start.AddTicks([long](($End.Ticks - $Start.Ticks) / 2))
            $Stats.splits++
            Write-Host 'UAL result cap reached; splitting the time window and recollecting.'
            Read-UalRange $Start $middle $Request $Stats $Limit
            Read-UalRange $middle $End $Request $Stats $Limit
            return
        }
        if (-not $added) { throw 'UAL pagination repeated a page without progress. Collection incomplete; retry with a narrower window.' }
    }
    foreach ($row in $rows) { Write-Output $row }
}

function Read-UalCollection($Request) {
    if (-not $script:exchange) { throw 'Connect Exchange in Session before collecting unified audit logs.' }
    Write-QueryAudit 'Get-Command' @{ Name = 'Search-UnifiedAuditLog' }
    $command = Get-Command Search-UnifiedAuditLog -ErrorAction SilentlyContinue
    if (-not $command) {
        throw "Audit history unavailable: Search-UnifiedAuditLog is not exposed by the Exchange session for customer tenant '$($script:tenant)' and account '$($script:exchangeAccount)'. Ask the tenant administrator to verify the View-Only Audit Logs or Audit Logs role for this account, including the active access-package/delegated assignment and Exchange audit-cmdlet permissions. After access is activated or changed, use New / disconnect and reconnect Exchange. Current mailbox rules can still be collected; audit history has not been searched."
    }
    $stats = @{ pages = 0; windows = 0; splits = 0; serviceRecordLimit = 50000; highCompleteness = $command.Parameters.ContainsKey('HighCompleteness') }
    $start = [datetime]::Parse($Request.start).ToUniversalTime()
    $end = [datetime]::Parse($Request.end).ToUniversalTime()
    $all = [Collections.Generic.List[object]]::new()
    $seen = [Collections.Generic.HashSet[string]]::new()
    while ($start -lt $end) {
        $next = $start.AddDays(1); if ($next -gt $end) { $next = $end }
        foreach ($row in @(Read-UalRange $start $next $Request $stats)) {
            if ($seen.Add((Get-UalKey $row))) { $all.Add($row) }
        }
        $start = $next
    }
    $checks = [Collections.Generic.List[object]]::new()
    if (-not $all.Count) {
        foreach ($name in @('organization', 'ingestion', 'mailbox', 'bypass')) {
            try {
                switch ($name) {
                    'organization' { Write-QueryAudit 'Get-OrganizationConfig'; $value = Get-OrganizationConfig -ErrorAction Stop | Select-Object AuditDisabled }
                    'ingestion' { Write-QueryAudit 'Get-AdminAuditLogConfig'; $value = Get-AdminAuditLogConfig -ErrorAction Stop | Select-Object UnifiedAuditLogIngestionEnabled }
                    'mailbox' { Write-QueryAudit 'Get-Mailbox' @{ Identity = $Request.user }; $value = Get-Mailbox -Identity $Request.user -ErrorAction Stop | Select-Object AuditEnabled, DefaultAuditSet, AuditOwner, AuditDelegate, AuditAdmin }
                    'bypass' { Write-QueryAudit 'Get-MailboxAuditBypassAssociation' @{ Identity = $Request.user }; $value = Get-MailboxAuditBypassAssociation -Identity $Request.user -ErrorAction Stop | Select-Object AuditBypassEnabled }
                }
                if ($null -eq $value) { throw 'No configuration was returned.' }
                $checks.Add(@{ check = $name; ok = $true; data = $value; checkedAt = [datetime]::UtcNow.ToString('o') })
            } catch { $checks.Add(@{ check = $name; ok = $false; error = $_.Exception.Message; checkedAt = [datetime]::UtcNow.ToString('o') }) }
        }
    }
    return @{ rows = @($all.ToArray()); retrieval = $stats; auditChecks = @($checks.ToArray()) }
}
