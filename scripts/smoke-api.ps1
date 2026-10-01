$ErrorActionPreference = "Stop"
$port = if ($env:PORT) { $env:PORT } else { "3219" }
$env:DATA_DIR = Join-Path (Get-Location) "data"
$env:PORT = $port
$proc = Start-Process node -ArgumentList "dist/src/server.js" -PassThru -WindowStyle Hidden
try {
  Start-Sleep -Seconds 2
  $health = Invoke-RestMethod "http://localhost:$port/health"
  $body = @{ name = "demo"; points = @(
    @{ id = "a"; x = 0; y = 0 },
    @{ id = "b"; x = 4; y = 0 },
    @{ id = "c"; x = 4; y = 4 },
    @{ id = "d"; x = 0; y = 4 }
  ) } | ConvertTo-Json -Depth 5
  $ps = Invoke-RestMethod -Method Post -Uri "http://localhost:$port/point-sets" -ContentType "application/json" -Body $body
  $tBody = @{ bounds = @{ xmin = -1; ymin = -1; xmax = 5; ymax = 5 } } | ConvertTo-Json
  $r1 = Invoke-RestMethod -Method Post -Uri "http://localhost:$port/point-sets/$($ps.id)/triangulate" -ContentType "application/json" -Body $tBody
  $r2 = Invoke-RestMethod -Method Post -Uri "http://localhost:$port/point-sets/$($ps.id)/triangulate" -ContentType "application/json" -Body $tBody
  $ver = Invoke-RestMethod "http://localhost:$port/results/$($r1.resultId)/verify"
  $cell = Invoke-RestMethod "http://localhost:$port/results/$($r1.resultId)/cell?sourceId=a"
  $badBody = @{ points = @(@{ id = "x"; x = 1; y = 0 }); bounds = @{ xmin = 0; ymin = 0; xmax = 0; ymax = 5 } } | ConvertTo-Json
  $rejected = $null
  try { Invoke-WebRequest -Method Post -Uri "http://localhost:$port/compute" -ContentType "application/json" -Body $badBody -UseBasicParsing | Out-Null }
  catch {
    $code = $_.Exception.Response.StatusCode.value__
    $msg = $_.ErrorDetails.Message
    $rejected = "HTTP $code $msg"
  }
  Write-Host "health=$($health.ok) psId=$($ps.id) created=$($r1.created)/$($r2.created) sameId=$($r1.resultId -eq $r2.resultId)"
  Write-Host "tri.ok=$($ver.triangulation.ok) vor.ok=$($ver.voronoi.ok) cellArea=$($cell.cell.area) empty=$($cell.cell.empty)"
  Write-Host "rejected=$rejected"
} finally {
  Stop-Process -Id $proc.Id -Force
}
