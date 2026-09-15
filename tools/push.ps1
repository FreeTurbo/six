<#
  一键上传到 GitHub
  ------------------------------------------------------------------
  把本项目的改动提交并推送到 GitHub，GitHub Pages 会自动重新部署。

  用法：双击项目根目录的「上传到GitHub.bat」
  高级：powershell -File tools\push.ps1 -Message "自定义提交说明"
#>
param(
    [string]$Message = ''
)

$ErrorActionPreference = 'Stop'
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
try { chcp 65001 | Out-Null } catch { }
try { $Host.UI.RawUI.WindowTitle = '上传到 GitHub' } catch { }

$project = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $project
$siteUrl = 'https://freeturbo.github.io/six/'

function Line { param($t, $c = 'Gray') Write-Host "  $t" -ForegroundColor $c }
function Head {
    param($t)
    Write-Host ''
    Write-Host "  $t" -ForegroundColor Cyan
    Write-Host ('  ' + ('-' * 54)) -ForegroundColor DarkGray
}
function Finish {
    param([int]$code)
    Write-Host ''
    if ($code -eq 0) {
        for ($i = 5; $i -ge 1; $i--) {
            Write-Host "`r  窗口 $i 秒后自动关闭…   " -NoNewline -ForegroundColor DarkGray
            Start-Sleep -Seconds 1
        }
        Write-Host "`r                              "
    }
    else {
        Write-Host '  按任意键关闭窗口…' -ForegroundColor DarkGray
        try { $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown') }
        catch { Start-Sleep -Seconds 10 }
    }
    exit $code
}

Clear-Host
Write-Host ''
Write-Host '  上传网站到 GitHub' -ForegroundColor White
Write-Host "  $project" -ForegroundColor DarkGray

# ---------- 1. 环境检查 ----------
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    # 刚装完 Git 时 PATH 可能还没刷新，手动找一下常见安装位置
    $cands = @(
        (Join-Path $env:ProgramFiles 'Git\cmd'),
        (Join-Path ${env:ProgramFiles(x86)} 'Git\cmd'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd')
    )
    foreach ($c in $cands) {
        if (Test-Path (Join-Path $c 'git.exe')) {
            $env:Path = "$env:Path;$c"
            break
        }
    }
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Head '出错了'
    Line '这台电脑上还没有安装 Git（上传工具）。' 'Red'
    Line '下载安装后重试：https://git-scm.com/download/win' 'Gray'
    Finish 1
}
if (-not (Test-Path (Join-Path $project '.git'))) {
    Head '出错了'
    Line '这个文件夹还没有和 GitHub 仓库绑定过。' 'Red'
    Line '（缺少 .git 目录，可能被移动或删除了）' 'DarkGray'
    Finish 1
}

# ---------- 2. 扫描改动 ----------
git add -A 2>&1 | Out-Null
$changed = @(git status --porcelain)

$ahead = 0
try { $ahead = [int](git rev-list --count 'origin/main..HEAD' 2>$null) } catch { $ahead = 0 }

if ($changed.Count -eq 0 -and $ahead -eq 0) {
    Head '结果'
    Line '没有发现任何改动，网站已经是最新的。' 'Yellow'
    Line '也就是说：这次不需要上传。' 'DarkGray'
    Finish 0
}

# ---------- 3. 列出改了什么 ----------
if ($changed.Count -gt 0) {
    Head "检测到 $($changed.Count) 处改动"
    foreach ($row in $changed) {
        if ($row.Length -lt 3) { continue }
        $code = $row.Substring(0, 2)
        $path = $row.Substring(3)
        if ($code -eq '??' -or $code -match 'A') { $label = '新增'; $color = 'Green' }
        elseif ($code -match 'D') { $label = '删除'; $color = 'Red' }
        elseif ($code -match 'R') { $label = '重命名'; $color = 'Yellow' }
        else { $label = '修改'; $color = 'Yellow' }
        Write-Host ("  [{0}] " -f $label) -ForegroundColor $color -NoNewline
        Write-Host $path
    }
}
else {
    Head '结果'
    Line '文件没有变化，但有之前的改动还没传上去。' 'Yellow'
}

# ---------- 4. 提交 ----------
if ($changed.Count -gt 0) {
    if (-not $Message) {
        $now = Get-Date -Format 'yyyy-MM-dd HH:mm'
        $names = @($changed | ForEach-Object { Split-Path -Leaf ($_.Substring(3)) } | Select-Object -Unique)
        if ($names.Count -le 3) {
            $detail = ($names -join '、')
        }
        else {
            $detail = "$($names[0])、$($names[1]) 等 $($names.Count) 个文件"
        }
        $Message = "更新网站：$detail（$now）"
    }

    $msgFile = Join-Path $env:TEMP 'gh-upload-message.txt'
    [System.IO.File]::WriteAllText($msgFile, $Message, (New-Object System.Text.UTF8Encoding($false)))

    Head '正在提交'
    $commitOut = git commit -F $msgFile 2>&1
    if ($LASTEXITCODE -ne 0) {
        Line '提交失败：' 'Red'
        $commitOut | ForEach-Object { Line $_ 'DarkGray' }
        Finish 1
    }
    Line $Message 'White'
}

# ---------- 5. 推送 ----------
Head '正在上传'
$pushOut = git push origin HEAD 2>&1
if ($LASTEXITCODE -ne 0) {
    $text = ($pushOut | Out-String)
    if ($text -match 'rejected|non-fast-forward|fetch first') {
        Line '线上有新的改动，先同步再传…' 'Yellow'
        git pull --rebase origin main 2>&1 | ForEach-Object { Line $_ 'DarkGray' }
        if ($LASTEXITCODE -ne 0) {
            Line '同步失败，可能有冲突需要手动处理。' 'Red'
            Finish 1
        }
        $pushOut = git push origin HEAD 2>&1
    }
    if ($LASTEXITCODE -ne 0) {
        Line '上传失败：' 'Red'
        $pushOut | ForEach-Object { Line $_ 'DarkGray' }
        Write-Host ''
        Line '常见原因：' 'Yellow'
        Line '  · 没联网 / 网络不通' 'DarkGray'
        Line '  · 授权过期了（重新跑一次，浏览器里再点一下授权）' 'DarkGray'
        Finish 1
    }
}

# ---------- 6. 完成 ----------
$hash = (git rev-parse --short HEAD 2>$null)
Head '上传成功'
Line "版本号：$hash" 'DarkGray'
Write-Host ''
Line '网站大约 1 分钟后自动更新：' 'Green'
Line $siteUrl 'Cyan'
Line '（GitHub 收到后要重新部署一次，稍等一下再刷新）' 'DarkGray'
Finish 0
