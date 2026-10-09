# LinkedIn Sync Script — reporte local de cambios pendientes (fix round 3)
# Detecta cambios en changes.json y registra el reporte en sync-log.md.
#
# Alcance y garantias (2026-10-06):
#   - SIN red, SIN navegador, SIN escritura en LinkedIn. Solo lee JSON local y
#     hace append a un log local.
#   - StrictMode + $ErrorActionPreference='Stop': cualquier error termina con
#     exit 1 en lugar de continuar en silencio.
#   - Lectura y escritura UTF-8 explicitas (sin depender del code page ANSI):
#     Get-Content -Encoding UTF8 y [IO.File]::AppendAllText con UTF8 sin BOM.
#   - Sello horario local ISO-8601 CON offset real (yyyy-MM-ddTHH:mm:sszzz).
#     Antes se etiquetaba la hora local como "UTC"; ya no se usa esa etiqueta.
#   - Guard estructural antes de decir "listos para aplicar": lista de cambios
#     presente y no vacia, campos/estados validos, y 'applied' exige
#     reconciliation.evidence. Si algo falla -> exit 1 y NO se escribe el log.
#   - Append IDEMPOTENTE: cada entrada lleva una clave de ejecucion determinista
#     (fecha local + conjunto de pendientes) marcada con <!-- lsync-run-key: ... -->.
#     Repetir el mismo run el mismo dia NO duplica la entrada (append-only: las
#     entradas antiguas nunca se reescriben ni se borran).
#   - Falta de pendientes -> exit 0 sin escribir nada.
#
# Uso:
#   .\sync-linkedin.ps1                       # rutas por defecto (repositorio)
#   .\sync-linkedin.ps1 -ChangesPath ... -LogPath ...   # por ejemplo en tests

#Requires -Version 5.1
param(
    [string]$ProfilePath = "C:\Users\CARDONA\Desktop\personal\portfolio\linkedin-sync\profile.json",
    [string]$ChangesPath = "C:\Users\CARDONA\Desktop\personal\portfolio\linkedin-sync\changes.json",
    [string]$MetricsPath = "C:\Users\CARDONA\Desktop\personal\portfolio\linkedin-sync\metrics.json",
    [string]$LogPath = "C:\Users\CARDONA\Desktop\personal\portfolio\linkedin-sync\sync-log.md"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$AllowedStatuses = @('pending', 'obsolete', 'needs_review', 'applied')

function Get-Prop {
    param(
        [Parameter(Mandatory = $true)]$Object,
        [Parameter(Mandatory = $true)][string]$Name,
        $Default = $null
    )
    if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) { return $Object.$Name }
    return $Default
}

function Read-Utf8Text {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { throw "archivo no encontrado: $Path" }
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    # UTF-8 estricto: detecta BOM si existe y decodifica el resto como UTF-8.
    return [System.IO.File]::ReadAllText($resolved, [System.Text.UTF8Encoding]::new($false))
}

function Append-Utf8Text {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Text
    )
    # UTF-8 sin BOM, explicito: no depende del code page de la maquina (cp1252
    # hubiera escrito bytes invalidos en sync-log.md y casado la validacion).
    [System.IO.File]::AppendAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

Write-Host "=== LinkedIn Sync Script (solo reporte local; sin red, sin escritura en LinkedIn) ===" -ForegroundColor Cyan
Write-Host ""

# 1. Cargar archivos (UTF-8 explicito)
Write-Host "[1/5] Cargando archivos..." -ForegroundColor Yellow
try {
    $profile = ConvertFrom-Json -InputObject (Read-Utf8Text -Path $ProfilePath)
    $changes = ConvertFrom-Json -InputObject (Read-Utf8Text -Path $ChangesPath)
    $metrics = ConvertFrom-Json -InputObject (Read-Utf8Text -Path $MetricsPath)
} catch {
    Write-Host "  ERROR: no se pudieron leer los archivos de entrada: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
if ($null -eq $profile -or $null -eq $changes -or $null -eq $metrics) {
    Write-Host "  ERROR: algun archivo de entrada es JSON null/vacio." -ForegroundColor Red
    exit 1
}

# 2. Guard estructural + politica local (fail-closed) y deteccion de pendientes
#    2026-10-06: changes.json usa la clave "changes" (reconciliada contra el
#    baseline en vivo); se mantiene fallback a "pending_changes" por compatibilidad.
Write-Host "[2/5] Detectando cambios pendientes..." -ForegroundColor Yellow

$changeList = $null
if ($changes.PSObject.Properties['changes'] -and $null -ne $changes.changes) {
    $changeList = @($changes.changes)
} elseif ($changes.PSObject.Properties['pending_changes'] -and $null -ne $changes.pending_changes) {
    $changeList = @($changes.pending_changes)
}

if ($null -eq $changeList) {
    Write-Host "  ERROR: changes.json no contiene la clave 'changes' (ni 'pending_changes')." -ForegroundColor Red
    exit 1
}
if ($changeList.Count -eq 0) {
    Write-Host "  ERROR: la lista de cambios esta vacia; fail-closed, no hay nada que validar." -ForegroundColor Red
    exit 1
}

$policyErrors = @()
foreach ($change in $changeList) {
    $id = [string](Get-Prop $change 'id' '(cambio sin id)')
    $field = [string](Get-Prop $change 'field' '')
    $status = [string](Get-Prop $change 'status' '')
    if ($field -eq '') { $policyErrors += "$id sin 'field'" }
    if ($AllowedStatuses -notcontains $status) { $policyErrors += "$id con estado invalido '$status'" }
    if ($status -eq 'applied') {
        $rec = Get-Prop $change 'reconciliation' $null
        $evidence = [string](Get-Prop $rec 'evidence' '')
        if ($evidence.Length -eq 0) {
            $policyErrors += "$id marcado 'applied' sin reconciliation.evidence (politica: nunca aplicado desde scripts locales)"
        }
    }
}
if ($policyErrors.Count -gt 0) {
    Write-Host "  ERROR: changes.json no pasa la politica local (fail-closed):" -ForegroundColor Red
    foreach ($err in $policyErrors) { Write-Host "    - $err" -ForegroundColor Red }
    Write-Host "  No se escribe ninguna entrada de auditoria." -ForegroundColor Red
    exit 1
}

$pendingChanges = @($changeList | Where-Object { (Get-Prop $_ 'status' '') -eq 'pending' })
Write-Host "  Cambios pendientes: $($pendingChanges.Count)" -ForegroundColor Green
Write-Host "  Politica local: OK ($($changeList.Count) cambios, estados validos, 'applied' con evidencia)" -ForegroundColor Green

if ($pendingChanges.Count -eq 0) {
    Write-Host "  No hay cambios pendientes. Sincronizacion completada." -ForegroundColor Green
    exit 0
}

# 3. Mostrar cambios
Write-Host "[3/5] Cambios a sincronizar:" -ForegroundColor Yellow
foreach ($change in $pendingChanges) {
    $priority = Get-Prop $change 'priority' 'n/a'
    $type = Get-Prop $change 'type' 'n/a'
    $field = Get-Prop $change 'field' '?'
    Write-Host "  [$priority] ${type}: $field" -ForegroundColor White
}

# 4. Perfil LinkedIn: aplicacion manual (sin escritura automatica)
Write-Host "[4/5] Preparando reporte de aplicacion manual..." -ForegroundColor Yellow
Write-Host "  NOTA: no hay escritura automatica en LinkedIn (write path deshabilitado)" -ForegroundColor Yellow
Write-Host "  Los cambios estan listos para aplicar manualmente" -ForegroundColor Green

# 5. Registrar en log (UTF-8 explicito, append-only, idempotente)
Write-Host "[5/5] Registrando en log..." -ForegroundColor Yellow

# Clave de ejecucion determinista: fecha local (dia) + conjunto de pendientes.
# Mismo dia + mismo conjunto => misma clave => no se duplica la entrada.
$stamp = Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'   # hora local con offset real
$day = Get-Date -Format 'yyyy-MM-dd'
$parts = @()
foreach ($change in $pendingChanges) {
    $id = [string](Get-Prop $change 'id' '?')
    $status = [string](Get-Prop $change 'status' '?')
    $field = [string](Get-Prop $change 'field' '?')
    $parts += "${id}:${status}:${field}"
}
$parts = @($parts | Sort-Object)
$payload = $day + '|' + ($parts -join ',')
$sha = [System.Security.Cryptography.SHA256]::Create()
try {
    $hashBytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($payload))
    $runKey = ([System.BitConverter]::ToString($hashBytes) -replace '-', '').Substring(0, 16).ToLowerInvariant()
} finally {
    $sha.Dispose()
}
$runMarker = "lsync-run-key: $runKey"

$existingLog = ''
if (Test-Path -LiteralPath $LogPath) {
    try {
        $existingLog = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $LogPath).Path, [System.Text.UTF8Encoding]::new($false))
    } catch {
        Write-Host "  ERROR: no se pudo leer el log existente: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}

if ($existingLog.Contains($runMarker)) {
    Write-Host "  Entrada de auditoria ya registrada este dia (idempotente): no se duplica el apunte." -ForegroundColor Green
    Write-Host ""
    Write-Host "=== Sincronizacion Completada (sin cambios en el log) ===" -ForegroundColor Cyan
    Write-Host "Cambios pendientes: $($pendingChanges.Count)" -ForegroundColor Green
    exit 0
}

$entryLines = @(
    ''
    ''
    "### $stamp"
    "<!-- $runMarker -->"
    '- **Trigger:** `sync-linkedin.ps1` (reporte local, sin red)'
    "- **Hora local (ISO-8601 con offset):** $stamp"
    "- **Cambios detectados:** $($pendingChanges.Count)"
    '- **Estado:** Pendiente de aplicacion manual'
    '- **Cambios:**'
)
foreach ($change in $pendingChanges) {
    $priority = Get-Prop $change 'priority' 'n/a'
    $type = Get-Prop $change 'type' 'n/a'
    $field = Get-Prop $change 'field' '?'
    $entryLines += "  - [$priority] ${type}: $field"
}
$logEntry = ($entryLines -join "`n") + "`n"

try {
    Append-Utf8Text -Path $LogPath -Text $logEntry
} catch {
    Write-Host "  ERROR: no se pudo anadir la entrada al log: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

Write-Host "  Entrada anadida (append-only, UTF-8, run key $runKey)." -ForegroundColor Green
Write-Host ""
Write-Host "=== Sincronizacion Completada ===" -ForegroundColor Cyan
Write-Host "Cambios pendientes: $($pendingChanges.Count)" -ForegroundColor Green
Write-Host "Revisa: $ChangesPath" -ForegroundColor Yellow
exit 0
