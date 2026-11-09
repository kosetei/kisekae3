# Raspberry Pi の store をローカルへ取り込むスクリプト。
# deploy-raspi2.ps1 は store を送らないので、本番のデータを持ち帰る手段はこれだけ。
#
#   .\pull-store-raspi2.ps1              不足・更新分だけコピー（ローカル側の削除なし）
#   .\pull-store-raspi2.ps1 -DryRun      何がかわるか表示だけ
#   .\pull-store-raspi2.ps1 -Mirror      ローカルを本番と同一にする（本番にないファイルを削除）
#   .\pull-store-raspi2.ps1 -Quiesce     コピー中、本番の service を停止
#   .\pull-store-raspi2.ps1 -Mirror -DryRun  削除含む差分を先に確認
#
# store/ は git に含まれない（.gitignore）。EOLを変えたくないため git ではなく robocopy で。

param(
    [switch]$Mirror,
    [switch]$DryRun,
    [switch]$Quiesce
)

$ErrorActionPreference = 'Stop'

$source = '\\192.168.10.119\myhdd\kisekae3\store'
$destination = Join-Path $PSScriptRoot 'store'

if (-not (Test-Path -LiteralPath $source)) {
    throw "Raspberry Pi store directory is not available: $source"
}

if ($Mirror -and -not $DryRun) {
    Write-Warning '-Mirror: 本番側にないファイルはローカルから削除されます。'
}

$serviceStopped = $false
if ($Quiesce) {
    & ssh raspi2 'sudo systemctl stop kisekae3.service'
    if ($LASTEXITCODE -ne 0) { throw 'Failed to stop kisekae3.service on raspi2.' }
    $serviceStopped = $true
}

try {
    # /R:1 /W:1: 本番が書きかけのファイルを8回リトライせずスキップする。
    # 開いているファイルが跳んだ場合は service を止めて再実行してください。
    $robocopyArgs = @($source, $destination, '/E', '/DCOPY:T', '/NP', '/R:1', '/W:1')
    if ($DryRun) { $robocopyArgs += '/L' }
    if ($Mirror) { $robocopyArgs += '/MIR' }

    & robocopy @robocopyArgs
    $copyExitCode = $LASTEXITCODE
    if ($copyExitCode -ge 8) { throw "Robocopy failed with exit code $copyExitCode." }

    $what = if ($DryRun) { ' DryRun の結果' } else { 'コピー' }
    Write-Output "Store 取り込み完了${what}（robocopy exit code $copyExitCode）。"
} finally {
    if ($serviceStopped) {
        & ssh raspi2 'sudo systemctl start kisekae3.service'
        if ($LASTEXITCODE -ne 0) { throw 'Failed to restart kisekae3.service on raspi2.' }
    }
}

