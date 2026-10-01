$ErrorActionPreference = "Stop"
$env:NODE_NO_WARNINGS = "1"
$PSNativeCommandArgumentPassing = "Standard"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("gsb-cli-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$points = Join-Path $tmp "points.json"
'[{"id":"a","x":0,"y":0},{"id":"b","x":4,"y":0},{"id":"c","x":4,"y":4},{"id":"d","x":0,"y":4}]' | Set-Content -Encoding UTF8 $points
$more = Join-Path $tmp "more.json"
'[{"id":"e","x":2,"y":2}]' | Set-Content -Encoding UTF8 $more
$bounds = Join-Path $tmp "bounds.json"
'{"xmin":-1,"ymin":-1,"xmax":5,"ymax":5}' | Set-Content -Encoding UTF8 $bounds
$badBounds = Join-Path $tmp "bad.json"
'{"xmin":0,"ymin":0,"xmax":0,"ymax":5}' | Set-Content -Encoding UTF8 $badBounds
$db = Join-Path $tmp "app.db"
$env:GSB_DB = $db
$cli = "dist/src/cli.js"
function Invoke-Cli {
  param([string[]] $CliArgs)
  $output = & node $cli @CliArgs 2>$null
  return ($output -join "`n")
}

Write-Host "--- create ---"
$created = (Invoke-Cli -CliArgs @("point-set","create","--name","demo","--points","@$points")) | ConvertFrom-Json
Write-Host "pointSetId=$($created.id)"
Write-Host "--- first triangulate ---"
$r1 = (Invoke-Cli -CliArgs @("triangulate","--id","$($created.id)","--bounds","@$bounds")) | ConvertFrom-Json
Write-Host "resultId=$($r1.resultId) created=$($r1.created) triangles=$($r1.result.triangulation.triangles.Count)"
Write-Host "--- idempotent repeat ---"
$r2 = (Invoke-Cli -CliArgs @("triangulate","--id","$($created.id)","--bounds","@$bounds")) | ConvertFrom-Json
Write-Host "created=$($r2.created) sameResultId=$($r1.resultId -eq $r2.resultId)"
Write-Host "--- add point ---"
Invoke-Cli -CliArgs @("point-set","add-points","--id","$($created.id)","--points","@$more") | Out-Null
$r3 = (Invoke-Cli -CliArgs @("triangulate","--id","$($created.id)","--bounds","@$bounds")) | ConvertFrom-Json
Write-Host "newResultId=$($r3.resultId) trianglesAfterInsert=$($r3.result.triangulation.triangles.Count)"
Write-Host "--- old result frozen ---"
$old = (Invoke-Cli -CliArgs @("result","get","--result","$($r1.resultId)")) | ConvertFrom-Json
Write-Host "oldTriangles=$($old.payload.triangulation.triangles.Count)"
Write-Host "--- neighborhood comparison ---"
Invoke-Cli -CliArgs @("result","compare","--before","$($r1.resultId)","--after","$($r3.resultId)")
Write-Host "--- cell query by source id ---"
Invoke-Cli -CliArgs @("result","cell","--result","$($r3.resultId)","--source-id","e")
Write-Host "--- csv export ---"
Invoke-Cli -CliArgs @("result","export","--result","$($r3.resultId)","--format","csv","--out",(Join-Path $tmp "out")) | Out-Null
Get-ChildItem $tmp -Filter "out.*.csv" | ForEach-Object { Write-Host "exported $($_.Name)" }
Write-Host "--- invalid rejection ---"
Invoke-Cli -CliArgs @("triangulate","--id","$($created.id)","--bounds","@$badBounds") | Out-Null; Write-Host "exitCode=$LASTEXITCODE"
Remove-Item -Recurse -Force $tmp
