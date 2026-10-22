$ErrorActionPreference='Continue'
$log='D:\Users\NIKITA\Documents\DEV\ruflo-native-m2-qa-canary\qa-admin-audit.txt'
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('ADMIN='+([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))
foreach($name in @('RufloM2QaRunner','RufloM2QaSigner')) {
 try {
  $t=Get-ScheduledTask -TaskName $name -ErrorAction Stop
  $i=Get-ScheduledTaskInfo -TaskName $name -ErrorAction Stop
  $lines.Add($name+' state='+$t.State+' result='+$i.LastTaskResult+' lastRun='+$i.LastRunTime+' user='+$t.Principal.UserId)
  $lines.Add($name+' command='+$t.Actions.Execute+' arguments='+$t.Actions.Arguments)
 } catch { $lines.Add($name+' ERROR='+$_.Exception.Message) }
}
foreach($p in @('C:\ProgramData\Ruflo\M2QA\keys','C:\ProgramData\Ruflo\M2QA\keys\signer.private.pem','C:\ProgramData\Ruflo\M2QA\signed','C:\ProgramData\Ruflo\M2QA\runner-results')) {
 try { $acl=Get-Acl -LiteralPath $p -ErrorAction Stop; $lines.Add($p+' ACL '+(($acl.Access|ForEach-Object {$_.IdentityReference.Value+':'+$_.FileSystemRights}) -join '|')) } catch { $lines.Add($p+' ERROR='+$_.Exception.Message) }
}
[System.IO.File]::WriteAllLines($log,$lines)
