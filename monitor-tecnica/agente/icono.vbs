' Abre el icono de la bandeja sin que aparezca ninguna ventana de consola.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -NonInteractive -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & dir & "\icono.ps1""", 0, False
