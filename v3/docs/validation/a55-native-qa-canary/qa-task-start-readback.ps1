$out='D:\Users\NIKITA\Documents\DEV\ruflo-native-m2-qa-canary\qa-task-start-readback.txt'
$lines=New-Object System.Collections.Generic.List[string]
$svc=Get-Service -Name Schedule -ErrorAction SilentlyContinue
$lines.Add('SCHEDULER='+$svc.Status)
foreach($name in @('RufloM2QaRunner','RufloM2QaSigner')){
 try {Start-ScheduledTask -TaskName $name -ErrorAction Stop;$lines.Add($name+' start-request=OK')}catch{$lines.Add($name+' start-error='+$_.Exception.Message)}
}
Start-Sleep -Seconds 3
foreach($name in @('RufloM2QaRunner','RufloM2QaSigner')){
 try{$t=Get-ScheduledTask -TaskName $name -ErrorAction Stop;$i=Get-ScheduledTaskInfo -TaskName $name -ErrorAction Stop;$lines.Add($name+' state='+$t.State+' lastResult='+$i.LastTaskResult+' lastRun='+$i.LastRunTime)}catch{$lines.Add($name+' readback-error='+$_.Exception.Message)}
}
try {
 Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-TaskScheduler/Operational';StartTime=(Get-Date).AddMinutes(-20)} -MaxEvents 80 -ErrorAction Stop |
  Where-Object { $_.Message -match 'RufloM2Qa' } |
  Select-Object -First 10 |
  ForEach-Object { $lines.Add('TASK_EVENT='+$_.Id+' '+($_.Message -replace '[\r\n]+',' ').Substring(0,[Math]::Min(550,($_.Message -replace '[\r\n]+',' ').Length))) }
} catch{$lines.Add('EVENT_READ='+$_.Exception.Message)}
[System.IO.File]::WriteAllLines($out,$lines)
