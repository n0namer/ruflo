$ErrorActionPreference='Stop'
$root='D:\Users\NIKITA\Documents\DEV\ruflo-native-m2-qa-canary'
$log=Join-Path $root 'qa-batch-right-fix.txt'
try {
 $names=@('RufloM2QaRunner','RufloM2QaSigner')
 $sids=@($names | ForEach-Object { '*' + (Get-LocalUser -Name $_ -ErrorAction Stop).SID.Value })
 $export=Join-Path $root 'qa-existing-rights.inf'
 & secedit.exe /export /cfg $export /areas USER_RIGHTS /quiet | Out-Null
 if($LASTEXITCODE -ne 0){throw ('secedit export exit '+$LASTEXITCODE)}
 $lines=Get-Content -LiteralPath $export
 $batch=@($lines|Where-Object {$_ -match '^\s*SeBatchLogonRight\s*='})
 if($batch.Count -gt 1){throw 'Ambiguous SeBatchLogonRight baseline'}
 $deny=@($lines|Where-Object {$_ -match '^\s*SeDenyBatchLogonRight\s*='})
 foreach($sid in $sids){if($deny -match [regex]::Escape($sid)){throw ('Explicit batch deny contains '+$sid)}}
 $current=@()
 if($batch.Count -eq 1){$current=@(($batch[0] -split '=',2)[1] -split ','|ForEach-Object {$_.Trim()}|Where-Object {$_})}
 $merged=@($current+$sids|Select-Object -Unique)
 $inf=Join-Path $root 'qa-batch-minimal.inf'
 $cfg=@('[Unicode]','Unicode=yes','[Version]','signature="$CHICAGO$"','Revision=1','[Privilege Rights]',('SeBatchLogonRight = ' + ($merged -join ','))) -join [Environment]::NewLine
 [System.IO.File]::WriteAllText($inf,$cfg,[Text.Encoding]::Unicode)
 & secedit.exe /configure /db (Join-Path $root 'qa-batch-policy.sdb') /cfg $inf /areas USER_RIGHTS /quiet | Out-Null
 if($LASTEXITCODE -ne 0){throw ('secedit configure exit '+$LASTEXITCODE)}
 [System.IO.File]::WriteAllText($log,'GRANT_DONE targets='+($sids -join ',')+' preserved='+$current.Count+[Environment]::NewLine)
 foreach($name in $names){
  try{Start-ScheduledTask -TaskName $name -ErrorAction Stop;Add-Content $log ('START '+$name+' requested')}
  catch{Add-Content $log ('START_ERROR '+$name+' '+$_.Exception.Message)}
 }
 Start-Sleep -Seconds 4
 foreach($name in $names){
  $t=Get-ScheduledTask -TaskName $name; $i=Get-ScheduledTaskInfo -TaskName $name
  Add-Content $log ($name+' state='+$t.State+' lastResult='+$i.LastTaskResult+' lastRun='+$i.LastRunTime)
 }
} catch {[System.IO.File]::AppendAllText($log,'ERROR '+$_.Exception.Message+[Environment]::NewLine)}