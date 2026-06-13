Option Explicit

Dim shell, fso, root, wrapper, command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
wrapper = fso.BuildPath(root, "ahr_wrapper.ps1")
shell.CurrentDirectory = root

command = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File " & Quote(wrapper)
WScript.Quit shell.Run(command, 0, True)

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
