# cleanup_system_folders.ps1
# This script takes ownership of 'Program Files' and 'WindowsApps' on E: and deletes them.
# WARNING: This will break any Microsoft Store apps or games installed on E:

$targetFolders = @("E:\Program Files", "E:\WindowsApps", "E:\WpSystem")

foreach ($folder in $targetFolders) {
    if (Test-Path $folder) {
        Write-Host "Processing $folder..." -ForegroundColor Cyan
        
        # Take Ownership
        Write-Host "Taking ownership..."
        takeown /f $folder /r /d y | Out-Null
        
        # Grant full access to current user
        Write-Host "Granting permissions..."
        icacls $folder /grant "${env:USERNAME}:F" /t /c /l /q | Out-Null
        
        # Attempt deletion
        Write-Host "Deleting folder..."
        Remove-Item -Path $folder -Recurse -Force -ErrorAction SilentlyContinue
        
        if (Test-Path $folder) {
            Write-Host "Failed to delete $folder. It may be in use by the system." -ForegroundColor Red
        } else {
            Write-Host "Successfully deleted $folder." -ForegroundColor Green
        }
    } else {
        Write-Host "Folder $folder not found, skipping." -ForegroundColor Yellow
    }
}

Write-Host "`nCleanup Complete!" -ForegroundColor Green
