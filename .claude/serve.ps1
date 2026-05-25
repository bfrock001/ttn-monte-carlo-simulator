$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$prefix = 'http://localhost:8765/'

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Host "Serving $root at $prefix"

$mimes = @{
    '.html' = 'text/html; charset=utf-8'
    '.htm'  = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'application/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.gif'  = 'image/gif'
    '.ico'  = 'image/x-icon'
    '.woff' = 'font/woff'
    '.woff2'= 'font/woff2'
    '.txt'  = 'text/plain; charset=utf-8'
    '.md'   = 'text/markdown; charset=utf-8'
}

while ($listener.IsListening) {
    try {
        $ctx = $listener.GetContext()
    } catch {
        break
    }
    $req = $ctx.Request
    $res = $ctx.Response

    $rel = [System.Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
    if ([string]::IsNullOrEmpty($rel)) { $rel = 'index.html' }

    $full = Join-Path $root $rel
    if ((Test-Path -LiteralPath $full -PathType Container)) {
        $full = Join-Path $full 'index.html'
    }

    if (Test-Path -LiteralPath $full -PathType Leaf) {
        try {
            $bytes = [System.IO.File]::ReadAllBytes($full)
            $ext = [System.IO.Path]::GetExtension($full).ToLower()
            $mime = $mimes[$ext]
            if (-not $mime) { $mime = 'application/octet-stream' }
            $res.ContentType = $mime
            $res.Headers.Add('Cache-Control', 'no-cache')
            $res.ContentLength64 = $bytes.Length
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
            Write-Host "200 $rel"
        } catch {
            $res.StatusCode = 500
            Write-Host "500 $rel : $_"
        }
    } else {
        $res.StatusCode = 404
        $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $rel")
        $res.ContentLength64 = $msg.Length
        $res.OutputStream.Write($msg, 0, $msg.Length)
        Write-Host "404 $rel"
    }

    $res.OutputStream.Close()
}
