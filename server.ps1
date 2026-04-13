$port = 8080
$path = "E:\workspace\hand_gesture"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()

Write-Host "Serving HTTP on http://localhost:$port/"

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        
        $localPath = $request.Url.LocalPath
        if ($localPath -eq "/") { $localPath = "/index.html" }
        $fullPath = Join-Path $path $localPath

        if (Test-Path $fullPath -PathType Leaf) {
            if ($fullPath -match '\.html$') { $response.ContentType = 'text/html' }
            elseif ($fullPath -match '\.css$') { $response.ContentType = 'text/css' }
            elseif ($fullPath -match '\.js$') { $response.ContentType = 'application/javascript' }
            
            $bytes = [System.IO.File]::ReadAllBytes($fullPath)
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $response.StatusCode = 404
        }
        $response.Close()
    }
} finally {
    $listener.Stop()
}
