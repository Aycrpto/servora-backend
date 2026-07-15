# Servora dev server — static frontend + REST API bridge (PowerShell).
#
# Implements the SAME API contract as backend/server.js (Node + Express)
# against the SAME storage file (backend/data/db.json), so the frontend
# runs on real dynamic data even before Node.js is installed.
# Once Node is available:  cd backend && npm install && npm start
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File serve.ps1
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:8321/")
$listener.Start()
Write-Host "Servora dev server (frontend + API bridge) on http://localhost:8321/"

$root   = $PSScriptRoot
$dbPath = Join-Path $root 'backend\data\db.json'
$svcPath = Join-Path $root 'backend\src\data\services.json'
$mime = @{ ".html"="text/html; charset=utf-8"; ".css"="text/css"; ".js"="text/javascript"; ".svg"="image/svg+xml"; ".png"="image/png"; ".jpg"="image/jpeg"; ".jpeg"="image/jpeg"; ".webp"="image/webp"; ".ico"="image/x-icon"; ".json"="application/json" }
$palette = @('#0e7a4a','#b0731a','#4655c4','#c2452f','#7a3fa0','#12876f','#2f6ec2')
$tierRank = @{ elite = 0; pro = 1; starter = 2 }

# db.json is runtime state (git-ignored). On first run it is created from
# db.seed.json, so a fresh clone boots with a populated marketplace.
# Delete db.json to reset back to the seed.
$seedPath = Join-Path $root 'backend\data\db.seed.json'
function Read-Db {
  if (-not (Test-Path $dbPath) -and (Test-Path $seedPath)) { Copy-Item $seedPath $dbPath }
  Get-Content $dbPath -Raw -Encoding UTF8 | ConvertFrom-Json
}
function Save-Db($db) { $db | ConvertTo-Json -Depth 10 | Set-Content $dbPath -Encoding UTF8 }

function Send-Json($ctx, $code, $obj) {
  $json  = $obj | ConvertTo-Json -Depth 10
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $ctx.Response.StatusCode = $code
  $ctx.Response.ContentType = 'application/json; charset=utf-8'
  $ctx.Response.ContentLength64 = $bytes.Length
  $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $ctx.Response.Close()
}

function Read-Body($ctx) {
  $reader = New-Object System.IO.StreamReader($ctx.Request.InputStream, [System.Text.Encoding]::UTF8)
  $raw = $reader.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  return $raw | ConvertFrom-Json
}

# ---- portfolio image storage (mirrors backend/src/store/uploads.js) ----
# Client sends downscaled data URLs; we decode them to real files under
# /uploads (already inside the static-served root) and store only the URL.
$uploadDir = Join-Path $PSScriptRoot 'uploads'

function Write-DataUrl([string]$dataUrl) {
  if ([string]::IsNullOrWhiteSpace($dataUrl)) { return $null }
  $m = [regex]::Match($dataUrl.Trim(), '^data:image/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$')
  if (-not $m.Success) { return $null }
  try { $bytes = [Convert]::FromBase64String($m.Groups[2].Value) } catch { return $null }
  if ($bytes.Length -eq 0 -or $bytes.Length -gt (8 * 1024 * 1024)) { return $null }
  if (-not (Test-Path $uploadDir)) { New-Item -ItemType Directory -Force $uploadDir | Out-Null }
  $ext = switch ($m.Groups[1].Value) { 'png' { 'png' } 'webp' { 'webp' } default { 'jpg' } }
  $name = "$([guid]::NewGuid().ToString()).$ext"
  [System.IO.File]::WriteAllBytes((Join-Path $uploadDir $name), $bytes)
  return "/uploads/$name"
}

function Remove-Stored([string]$url) {
  if (-not $url -or -not $url.StartsWith('/uploads/')) { return }
  $file = Join-Path $uploadDir ([System.IO.Path]::GetFileName($url))
  # guard against traversal via a crafted URL
  if ([System.IO.Path]::GetDirectoryName($file) -ne $uploadDir) { return }
  try { if (Test-Path $file) { Remove-Item $file -Force } } catch { }
}

# Normalise a submitted portfolio array to stored URLs (max 5):
# data URLs are written to disk, existing /uploads URLs pass through.
function Save-Portfolio($list) {
  $out = @()
  if ($null -eq $list) { return ,$out }
  foreach ($item in @($list | Select-Object -First 5)) {
    $v = if ($item -is [string]) { $item } elseif ($item.url) { [string]$item.url } elseif ($item.dataUrl) { [string]$item.dataUrl } else { $null }
    if ($v -and $v.StartsWith('/uploads/')) { $out += $v }
    elseif ($v) { $u = Write-DataUrl $v; if ($u) { $out += $u } }
  }
  return ,$out
}

# Compare phone numbers by their last 10 digits (0803... === +234803...).
function Get-NormPhone([string]$s) {
  $d = [string]$s -replace '\D', ''
  if ($d.Length -gt 10) { return $d.Substring($d.Length - 10) }
  return $d
}

# Title-case free-text places ("ikeja" -> "Ikeja"), preserving short acronyms (GRA, VI).
function ConvertTo-NiceTitle([string]$s) {
  if ([string]::IsNullOrWhiteSpace($s)) { return $null }
  $ti = (Get-Culture).TextInfo
  return (($s.Trim() -split '\s+' | ForEach-Object {
    if ($_ -cmatch '^[A-Z0-9]{2,4}$') { $_ } else { $ti.ToTitleCase($_.ToLower()) }
  }) -join ' ')
}

while ($listener.IsListening) {
  try {
    $ctx    = $listener.GetContext()
    $method = $ctx.Request.HttpMethod
    $path   = $ctx.Request.Url.AbsolutePath

    # ---------------- API (mirror of backend/server.js) ----------------
    if ($path -eq '/api/health') {
      Send-Json $ctx 200 @{ ok = $true; name = 'servora-dev-bridge'; version = '1.0.0' }
    }
    elseif ($path -eq '/api/pros' -and $method -eq 'GET') {
      # GET /api/pros?category=&state=&sort=  → { pros, stateCovered }
      $q = $ctx.Request.QueryString
      $category = $q['category']; $state = $q['state']; $sort = $q['sort']
      $pros = @((Read-Db).professionals | Where-Object { $_.status -eq 'verified' })
      if ($category) { $pros = @($pros | Where-Object { $_.category -eq $category }) }
      $inState = @($pros | Where-Object { $_.state -eq $state })
      $stateCovered = [bool]($state -and $inState.Count -gt 0)
      if ($stateCovered) { $pros = $inState }
      # sort key first, then subscription tier (Elite > Pro > Starter)
      switch ($sort) {
        'resp'  { $pros = @($pros | Sort-Object @{e={ if ($null -eq $_.responseMins) { 999 } else { $_.responseMins } }}, @{e={ $tierRank[[string]$_.tier] }}) }
        'price' { $pros = @($pros | Sort-Object @{e={ if ($null -eq $_.priceFrom) { [double]::MaxValue } else { $_.priceFrom } }}, @{e={ $tierRank[[string]$_.tier] }}) }
        'jobs'  { $pros = @($pros | Sort-Object @{e={ if ($null -eq $_.jobsDone) { 0 } else { $_.jobsDone } }; Descending=$true}, @{e={ $tierRank[[string]$_.tier] }}) }
        default { $pros = @($pros | Sort-Object @{e={ if ($null -eq $_.rating) { 0 } else { $_.rating } }; Descending=$true}, @{e={ $tierRank[[string]$_.tier] }}) }
      }
      # public listing shape - never expose credentials or private contact data
      $pros = @($pros | Select-Object * -ExcludeProperty password, phone, email, idDocument)
      Send-Json $ctx 200 @{ pros = @($pros); stateCovered = $stateCovered }
    }
    elseif ($path -eq '/api/pros/featured' -and $method -eq 'GET') {
      # Paid placement: Elite first, then Pro, by rating
      $pros = @((Read-Db).professionals |
        Where-Object { $_.status -eq 'verified' -and $_.tier -ne 'starter' } |
        Sort-Object @{e={ $tierRank[[string]$_.tier] }}, @{e={ -1 * $(if ($null -eq $_.rating) { 0 } else { $_.rating }) }} |
        Select-Object -First 8 |
        Select-Object * -ExcludeProperty password, phone, email, idDocument)
      Send-Json $ctx 200 @{ pros = @($pros) }
    }
    elseif ($path -eq '/api/auth/login' -and $method -eq 'POST') {
      # Demo sign-in: WhatsApp number or email + password.
      # Pros without a stored password use the shared demo password.
      $body = Read-Body $ctx
      $identifier = if ($body) { [string]$body.identifier } else { '' }
      $password = if ($body) { [string]$body.password } else { '' }
      if ([string]::IsNullOrWhiteSpace($identifier) -or [string]::IsNullOrWhiteSpace($password)) {
        Send-Json $ctx 400 @{ ok = $false; error = 'Enter your WhatsApp number (or email) and password.' }
      } else {
        $idPhone = Get-NormPhone $identifier
        $idText = $identifier.Trim().ToLower()
        $pro = (Read-Db).professionals | Where-Object {
          $_.status -eq 'verified' -and (
            ($idPhone.Length -eq 10 -and (Get-NormPhone ([string]$_.phone)) -eq $idPhone) -or
            ($_.email -and ([string]$_.email).ToLower() -eq $idText)
          )
        } | Select-Object -First 1
        if (-not $pro) {
          Send-Json $ctx 401 @{ ok = $false; error = 'No verified professional found with that number or email.' }
        } else {
          $expected = if ($pro.password) { [string]$pro.password } else { 'servora123' }
          if ($password -cne $expected) {
            Send-Json $ctx 401 @{ ok = $false; error = 'Incorrect password. (Accounts without a password use the demo password.)' }
          } else {
            Send-Json $ctx 200 @{ ok = $true; token = 'demo-' + $pro.id; pro = @{ id = $pro.id; name = $pro.name; category = $pro.category; state = $pro.state; avatarColor = $pro.avatarColor; tier = $pro.tier; rating = $pro.rating; jobsDone = $pro.jobsDone; bio = $pro.bio; responseMins = $pro.responseMins; priceFrom = $pro.priceFrom; priceLabel = $pro.priceLabel; portfolio = @($pro.portfolio) } }
          }
        }
      }
    }
    elseif ($path -eq '/api/pros/register' -and $method -eq 'POST') {
      $body = Read-Body $ctx
      $missing = @()
      foreach ($f in 'name','phone','trade','state') {
        if (-not $body -or [string]::IsNullOrWhiteSpace([string]$body.$f)) { $missing += $f }
      }
      $db = Read-Db
      $emailClean = if ($body.email) { ([string]$body.email).Trim().ToLower() } else { $null }
      # One account per phone / email — server-side, it owns the data.
      $phoneTaken = @($db.professionals | Where-Object { (Get-NormPhone ([string]$_.phone)) -eq (Get-NormPhone ([string]$body.phone)) }).Count -gt 0
      $emailTaken = $emailClean -and @($db.professionals | Where-Object { $_.email -and ([string]$_.email).ToLower() -eq $emailClean }).Count -gt 0
      if ($missing.Count) {
        Send-Json $ctx 400 @{ ok = $false; error = "Missing required fields: $($missing -join ', ')" }
      } elseif ($phoneTaken) {
        Send-Json $ctx 409 @{ ok = $false; field = 'phone'; error = 'This phone number is already registered. Try signing in instead.' }
      } elseif ($emailTaken) {
        Send-Json $ctx 409 @{ ok = $false; field = 'email'; error = 'This email is already in use. Try signing in instead.' }
      } else {
        # lga holds the title-cased LGA, city holds the state — UI shows "LGA, State"
        $lga = ConvertTo-NiceTitle $body.lga
        $plan = if ($body.plan) { ([string]$body.plan).ToLower() } else { 'starter' }
        $pro = [ordered]@{
          id = [guid]::NewGuid().ToString()
          name = ([string]$body.name).Trim()
          phone = ([string]$body.phone).Trim()
          email = $emailClean
          category = [string]$body.trade
          state = [string]$body.state
          lga = $lga
          area = if ($lga) { $lga } else { [string]$body.state }
          city = [string]$body.state
          rating = $null
          jobsDone = 0
          priceFrom = $null
          priceLabel = 'Quote on request'
          responseMins = 20
          avatarColor = $palette[(Get-Random -Maximum $palette.Count)]
          badges = @('v')
          tier = $plan
          # DEMO ONLY: plain-text password (null -> shared demo password on login)
          password = if ($body.password) { ([string]$body.password).Trim() } else { $null }
          bio = "New on Servora - ID-verified professional serving $(if ($lga) { "$lga, " })$($body.state)."
          review = $null
          skills = $null
          status = 'verified'   # demo mode auto-verify (Node backend: AUTO_VERIFY)
          idDocument = if ($body.idFileName) { @{ fileName = [string]$body.idFileName; sizeKB = $body.idFileSizeKB; note = 'simulated upload - metadata only' } } else { $null }
          # past-work photos written to /uploads, stored as URLs
          portfolio = Save-Portfolio $body.portfolio
          createdAt = (Get-Date).ToUniversalTime().ToString('o')
        }
        $db.professionals = @($db.professionals) + @([pscustomobject]$pro)
        Save-Db $db
        $public = $pro | Select-Object * -ExcludeProperty password, phone, email, idDocument
        Send-Json $ctx 201 @{ ok = $true; status = 'verified'; pro = $public; message = 'Auto-verified (demo mode) - your profile is live in listings now.' }
      }
    }
    elseif ($path -match '^/api/pros/([^/]+)/leads$' -and $method -eq 'GET') {
      # GET /api/pros/:id/leads — direct contacts + job posts matching trade & state.
      # No auth yet: frontend uses a demo profile picker (real auth later).
      $proId = [System.Uri]::UnescapeDataString($Matches[1])
      $db = Read-Db
      $pro = $db.professionals | Where-Object { [string]$_.id -eq $proId } | Select-Object -First 1
      if (-not $pro) {
        Send-Json $ctx 404 @{ ok = $false; error = 'Professional not found' }
      } else {
        $leads = @($db.leads | Where-Object {
          ($_.proId -and ([string]$_.proId -eq [string]$pro.id)) -or
          ($_.type -ne 'direct_contact' -and
            (-not $_.service -or $_.service -eq $pro.category) -and
            (-not $_.state -or $_.state -eq $pro.state))
        } | Sort-Object @{e={ [datetime]$_.createdAt }; Descending=$true})
        Send-Json $ctx 200 @{ pro = @{ id = $pro.id; name = $pro.name; category = $pro.category; state = $pro.state }; leads = @($leads) }
      }
    }
    elseif ($path -match '^/api/pros/([^/]+)$' -and $method -eq 'PATCH') {
      # PATCH /api/pros/:id — pro edits their own bio / responseMins / priceFrom.
      # Demo auth: bearer token 'demo-<id>' must match the target id.
      $proId = [System.Uri]::UnescapeDataString($Matches[1])
      $auth = ([string]$ctx.Request.Headers['Authorization']) -replace '^Bearer\s+', ''
      if ($auth -ne ('demo-' + $proId)) {
        Send-Json $ctx 403 @{ ok = $false; error = 'Not authorised to edit this profile.' }
      } else {
        $db = Read-Db
        $pro = $db.professionals | Where-Object { [string]$_.id -eq $proId } | Select-Object -First 1
        if (-not $pro) {
          Send-Json $ctx 404 @{ ok = $false; error = 'Professional not found' }
        } else {
          $body = Read-Body $ctx
          # portfolio array IS the desired final state; files dropped from
          # it are deleted so removed photos don't linger on the server
          if ($null -ne $body.portfolio) {
            $next = Save-Portfolio $body.portfolio
            foreach ($old in @($pro.portfolio)) {
              $oldUrl = if ($old -is [string]) { $old } elseif ($old.url) { [string]$old.url } else { $null }
              if ($oldUrl -and ($next -notcontains $oldUrl)) { Remove-Stored $oldUrl }
            }
            if ($pro.PSObject.Properties.Name -contains 'portfolio') { $pro.portfolio = $next }
            else { $pro | Add-Member -NotePropertyName portfolio -NotePropertyValue $next -Force }
          }
          if ($null -ne $body.bio -and [string]$body.bio) { $pro.bio = ([string]$body.bio).Trim() }
          if ($null -ne $body.responseMins) {
            $n = 0; if ([int]::TryParse([string]$body.responseMins, [ref]$n) -and $n -ge 1 -and $n -le 720) { $pro.responseMins = $n }
          }
          if ($null -ne $body.priceFrom) {
            $n = 0; if ([int]::TryParse([string]$body.priceFrom, [ref]$n) -and $n -ge 0) {
              $pro.priceFrom = $n
              $pro.priceLabel = if ($n -gt 0) { ([char]0x20A6) + $n.ToString('N0') } else { 'Quote on request' }
            }
          }
          Save-Db $db
          $public = $pro | Select-Object * -ExcludeProperty password, phone, email, idDocument
          Send-Json $ctx 200 @{ ok = $true; pro = $public }
        }
      }
    }
    elseif ($path -eq '/api/leads' -and $method -eq 'POST') {
      $body = Read-Body $ctx
      $lead = [ordered]@{
        id = [guid]::NewGuid().ToString()
        type = if ($body.type) { [string]$body.type } else { 'job_post' }
        proId = $body.proId
        service = $body.service
        description = $body.description
        area = $body.area
        state = $body.state
        name = $body.name
        phone = $body.phone
        when = $body.when
        status = 'open'
        createdAt = (Get-Date).ToUniversalTime().ToString('o')
      }
      $db = Read-Db
      $db.leads = @($db.leads) + @([pscustomobject]$lead)
      Save-Db $db
      Send-Json $ctx 201 @{ ok = $true; id = $lead.id; message = 'Lead captured - matching pros will be notified.' }
    }
    elseif ($path -eq '/api/support' -and $method -eq 'POST') {
      # POST /api/support - support message from the contact form.
      # FUTURE: forward to the real support inbox / helpdesk.
      $body = Read-Body $ctx
      $missing = @()
      foreach ($f in 'name','email','message') {
        if (-not $body -or [string]::IsNullOrWhiteSpace([string]$body.$f)) { $missing += $f }
      }
      if ($missing.Count) {
        Send-Json $ctx 400 @{ ok = $false; error = "Missing required fields: $($missing -join ', ')" }
      } elseif (([string]$body.email) -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$') {
        Send-Json $ctx 400 @{ ok = $false; error = 'That email address does not look valid.' }
      } else {
        $entry = [ordered]@{
          id = [guid]::NewGuid().ToString()
          name = ([string]$body.name).Trim()
          email = ([string]$body.email).Trim()
          topic = if ($body.topic) { [string]$body.topic } else { 'Something else' }
          message = ([string]$body.message).Trim()
          status = 'open'
          createdAt = (Get-Date).ToUniversalTime().ToString('o')
        }
        $db = Read-Db
        if ($null -eq $db.supportMessages) { $db | Add-Member -NotePropertyName supportMessages -NotePropertyValue @() -Force }
        $db.supportMessages = @($db.supportMessages) + @([pscustomobject]$entry)
        Save-Db $db
        $ref = 'SUP-' + ($entry.id -replace '-', '').Substring(0,6).ToUpper()
        Send-Json $ctx 201 @{ ok = $true; ref = $ref; message = 'Support message received - we reply within 24 hours.' }
      }
    }
    elseif ($path -eq '/api/services' -and $method -eq 'GET') {
      $services = Get-Content $svcPath -Raw -Encoding UTF8 | ConvertFrom-Json
      Send-Json $ctx 200 @{ services = @($services) }
    }
    elseif ($path -like '/api/*') {
      Send-Json $ctx 404 @{ ok = $false; error = 'Not found' }
    }
    # ---------------- Static frontend ----------------
    else {
      $rel = [System.Uri]::UnescapeDataString($path).TrimStart('/')
      if ([string]::IsNullOrEmpty($rel)) { $rel = "index.html" }
      $file = Join-Path $root $rel
      if (Test-Path $file -PathType Leaf) {
        $bytes = [System.IO.File]::ReadAllBytes($file)
        $ext = [System.IO.Path]::GetExtension($file).ToLower()
        if ($mime.ContainsKey($ext)) { $ctx.Response.ContentType = $mime[$ext] }
        $ctx.Response.ContentLength64 = $bytes.Length
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $ctx.Response.StatusCode = 404
      }
      $ctx.Response.Close()
    }
  } catch { try { $ctx.Response.StatusCode = 500; $ctx.Response.Close() } catch { } }
}
