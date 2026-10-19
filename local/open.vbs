' Starts the local server (hidden) if it isn't running, then opens the app in Chrome.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)

running = False
On Error Resume Next
Set http = CreateObject("MSXML2.XMLHTTP")
http.Open "GET", "http://localhost:8137/index.html", False
http.Send
If Err.Number = 0 And http.Status = 200 Then running = True
On Error GoTo 0

If Not running Then
  sh.Run "node """ & dir & "\serve.js""", 0, False
  WScript.Sleep 800
End If

sh.Run """C:\Program Files\Google\Chrome\Application\chrome.exe"" ""http://localhost:8137/question-words-quiz.html""", 1, False
