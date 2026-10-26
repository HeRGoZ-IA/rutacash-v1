# Registra (o actualiza) las tres tareas programadas de los respaldos de ADEX (Ronda 76, alternativa A).
# Lo ejecuta el PROPIETARIO, una vez, en su terminal de PowerShell (sin permisos de administrador):
#   powershell -ExecutionPolicy Bypass -File scripts\backup\registrar-tareas.ps1
# Las tareas corren con su usuario de Windows y solo con la sesión iniciada (DPAPI necesita su perfil).
# Si el equipo estaba apagado a la hora prevista, se ejecutan al encenderlo (StartWhenAvailable).
# Se ven en el Programador de tareas, carpeta \ADEX\. Para quitarlas: Unregister-ScheduledTask -TaskPath '\ADEX\' -TaskName '<nombre>'

$ErrorActionPreference = 'Stop'
$saas = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$node = (Get-Command node).Source
$me = "$env:USERDOMAIN\$env:USERNAME"

function Act([string]$orden) {
  New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ("-NoProfile -NonInteractive -WindowStyle Hidden -Command " +
    "`"Set-Location '$saas'; & '$node' --import ./scripts/register-alias.mjs scripts/backup/adex-backup.mjs $orden`"")
}
$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
$pri = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited

# 21:30 hora de Colombia = 23:30 hora de Brasil, después del cierre habitual.
Register-ScheduledTask -TaskPath '\ADEX\' -TaskName 'Respaldo diario' -Action (Act 'crear --motivo diaria') `
  -Trigger (New-ScheduledTaskTrigger -Daily -At '21:30') -Settings $set -Principal $pri -Force `
  -Description 'ADEX: copia lógica cifrada diaria (solo lectura sobre la base), copia a OneDrive y poda según la política R76' | Out-Null
Register-ScheduledTask -TaskPath '\ADEX\' -TaskName 'Ensayo semanal de restauracion' -Action (Act 'verificar') `
  -Trigger (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At '10:00') -Settings $set -Principal $pri -Force `
  -Description 'ADEX: restaura la última copia en un PostgreSQL local aislado y compara los recuentos por tabla' | Out-Null
Register-ScheduledTask -TaskPath '\ADEX\' -TaskName 'Vigilancia de respaldos' -Action (Act 'estado') `
  -Trigger @((New-ScheduledTaskTrigger -AtLogOn -User $me), (New-ScheduledTaskTrigger -Daily -At '12:00')) -Settings $set -Principal $pri -Force `
  -Description 'ADEX: notificación si la última copia falló, tiene más de 36 h o falta la clave de recuperación' | Out-Null

Get-ScheduledTask -TaskPath '\ADEX\' | ForEach-Object {
  [pscustomobject]@{ Tarea = $_.TaskName; Estado = $_.State; Proxima = (Get-ScheduledTaskInfo $_).NextRunTime }
} | Format-Table -AutoSize
