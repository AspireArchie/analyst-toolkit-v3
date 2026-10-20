$ErrorActionPreference='Stop'
. "$PSScriptRoot/../powershell/m365.ps1"
$script:calls=0
function Invoke-M365Read($Name,$Parameters) {
    $script:calls++
    if($Name-eq'Get-QuarantineMessage') {
        if($Parameters.Page-eq1){0..999|ForEach-Object{@{Identity="q-$_"}}}elseif($Parameters.Page-eq2){@{Identity='q-1000'}}
        return
    }
    if($script:bulkMode){$last=if($Parameters.MessageTraceId){1000}else{999};foreach($i in 0..$last){@{MessageTraceId='bulk';RecipientAddress="r$i@example.net";Received=$Parameters.StartDate.ToString('o')}};return}
    foreach($i in 0..8){$time=([datetime]'2026-01-01T00:00:00Z').AddSeconds($i);if($time-ge$Parameters.StartDate -and $time-le$Parameters.EndDate){@{MessageTraceId="trace-$i";Received=$time.ToString('o');RecipientAddress='r@example.net'}}}
}
function Invoke-M365Hunting($Query,$Request) {
    $script:calls++
    if($Query-notmatch 'Timestamp >= datetime\(([^)]+)\) and Timestamp < datetime\(([^)]+)\)'){throw 'Missing time bounds'}
    $from=[datetime]::Parse($Matches[1]);$to=[datetime]::Parse($Matches[2])
    $rows=@(0..8|ForEach-Object{$time=([datetime]'2026-01-01T00:00:00Z').AddSeconds($_);if($time-ge$from -and $time-lt$to){@{Id="hunt-$_";Timestamp=$time.ToString('o')}}})
    if($Query-match'summarize ExpectedCount'){@{ExpectedCount=$rows.Count}}else{$rows}
}
$request=@{kind='trace-outbound';user='u@example.net';aliases=@('u@example.net');party='';start='2026-01-01T00:00:00Z';end='2026-01-01T00:00:09Z'}
$trace=@(Read-TraceRange $request ([datetime]$request.start) ([datetime]$request.end) 6)
$hunt=@(Read-HuntingRange 'EmailEvents' $request ([datetime]$request.start) ([datetime]$request.end) 6)
$quarantine=@(Read-M365Quarantine $request)
$script:bulkMode=$true
$bulk=@(Read-M365Trace $request)
[Console]::WriteLine('TEST_RESULT:'+(@{traceIds=@($trace.MessageTraceId|Sort-Object -Unique);huntIds=@($hunt.Id|Sort-Object -Unique);quarantine=$quarantine.Count;bulkRecipients=@($bulk.RecipientAddress|Sort-Object -Unique).Count;calls=$script:calls}|ConvertTo-Json -Compress))
