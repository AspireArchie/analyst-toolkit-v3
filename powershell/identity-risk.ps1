function Read-IdentityRisk($Request, [string]$UserId) {
    $output = @{ rows = @(); riskyUser = $null; riskHistory = @(); riskySignIns = @(); riskSources = @() }
    foreach ($source in @('detections', 'risky-user', 'risk-history', 'risky-signins')) {
        try {
            $values = @()
            switch ($source) {
                'detections' {
                    $filter = "userId eq '$($UserId.Replace("'", "''"))'"
                    $values = @(Read-GraphPages ('https://graph.microsoft.com/v1.0/identityProtection/riskDetections?$top=500&$filter=' + [Uri]::EscapeDataString($filter)) '/v1.0/identityProtection/riskDetections')
                    $output.rows = $values
                }
                'risky-user' {
                    $user = Read-GraphObject ('https://graph.microsoft.com/v1.0/identityProtection/riskyUsers/' + [Uri]::EscapeDataString($UserId)) -AllowMissing
                    if ($null -ne $user) { $values = @($user) }
                    $output.riskyUser = $user
                }
                'risk-history' {
                    $path = '/v1.0/identityProtection/riskyUsers/' + [Uri]::EscapeDataString($UserId) + '/history'
                    $values = @(Read-GraphPages ('https://graph.microsoft.com' + $path) $path -AllowMissing)
                    $output.riskHistory = $values
                }
                'risky-signins' {
                    $all = [Collections.Generic.List[object]]::new()
                    foreach ($kind in @('interactiveUser', 'nonInteractiveUser')) {
                        $filter = "userId eq '$($UserId.Replace("'", "''"))' and signInEventTypes/any(t:t eq '$kind')"
                        if (-not $Request.allRetained) {
                            $start = [DateTimeOffset]::Parse($Request.start).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
                            $end = [DateTimeOffset]::Parse($Request.end).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
                            $filter += " and createdDateTime ge $start and createdDateTime lt $end"
                        }
                        foreach ($row in @(Read-GraphPages ('https://graph.microsoft.com/beta/auditLogs/signIns?$top=500&$filter=' + [Uri]::EscapeDataString($filter)) '/beta/auditLogs/signIns')) { $all.Add($row) }
                    }
                    # Preserve risk indicators, including hidden values, without assuming
                    # missing/hidden details establish that a sign-in is safe or risky.
                    $values = @($all | Where-Object {
                        ($_.riskLevelDuringSignIn -and $_.riskLevelDuringSignIn -ne 'none') -or
                        ($_.riskLevelAggregated -and $_.riskLevelAggregated -ne 'none') -or
                        ($_.riskState -and $_.riskState -ne 'none') -or @($_.riskEventTypes_v2 | Where-Object { $_ -and $_ -ne 'none' }).Count
                    })
                    $output.riskySignIns = $values
                }
            }
            $output.riskSources += @{ source = $source; ok = $true; count = $values.Count; checkedAt = [datetime]::UtcNow.ToString('o') }
        } catch {
            $output.riskSources += @{ source = $source; ok = $false; error = $_.Exception.Message; checkedAt = [datetime]::UtcNow.ToString('o') }
            Write-Host "Identity Protection source unavailable ($source): $($_.Exception.Message)"
        }
    }
    return $output
}
