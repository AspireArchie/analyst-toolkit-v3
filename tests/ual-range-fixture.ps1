$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../powershell/ual.ps1"
$script:queries = [Collections.Generic.List[object]]::new()
function Write-QueryAudit($Command, $Parameters) { $script:queries.Add($Parameters) }
$script:offsets = @{}
function Search-UnifiedAuditLog {
    param([datetime]$StartDate, [datetime]$EndDate, $UserIds, $ResultSize, $SessionId, $SessionCommand, $ErrorAction)
    $offset = [int]$script:offsets[$SessionId]; $script:offsets[$SessionId] = $offset + 3
    $matches = @(0..8 | Where-Object { $time = [datetime]'2026-01-01T00:00:00Z'; $time = $time.AddSeconds($_); $time -ge $StartDate -and $time -le $EndDate })
    foreach ($index in @($matches | Select-Object -Skip $offset -First 3)) { @{ Identity = "event-$index"; AuditData = "{`"Id`":`"event-$index`"}" } }
}
$stats = @{ pages = 0; windows = 0; splits = 0; highCompleteness = $false }
$rows = @(Read-UalRange ([datetime]'2026-01-01T00:00:00Z') ([datetime]'2026-01-01T00:00:08Z') @{ user = 'user@contoso.com'; operations = @() } $stats 6)
[Console]::WriteLine('TEST_RESULT:' + (@{ ids = @($rows.Identity | Sort-Object -Unique); stats = $stats; queries = $script:queries.ToArray() } | ConvertTo-Json -Depth 10 -Compress))
