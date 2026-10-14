# Teste manual do scraping do Spotify no resolver.
# Uso:  powershell -File scripts/test-spotify.ps1
$ErrorActionPreference = "Stop"
$body = @{ url = "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M" } | ConvertTo-Json
try {
$r = Invoke-RestMethod -Uri "http://127.0.0.1:8788/resolve" -Method Post -ContentType "application/json" -Body $body
Write-Host "provider : $($r.provider)"
Write-Host "name     : $($r.name)"
Write-Host "truncated: $($r.truncated)"
Write-Host "faixas   : $($r.tracks.Count)"
Write-Host "--- primeiras 5 ---"
$r.tracks | Select-Object -First 5 | ForEach-Object { Write-Host "$($_.artist) - $($_.title)  [$($_.duration)s]" }
} catch {
  Write-Host "HTTP $($_.Exception.Response.StatusCode.value__)"
  $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
  Write-Host $reader.ReadToEnd()
}

