' Starts the local server (hidden) if it isn't running, then opens the app in Chrome.
' Pass "dev" as the first argument to open the developer view (?dev=1).
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

url = "http://localhost:8137/question-words-quiz.html"
If WScript.Arguments.Count > 0 Then
  If LCase(WScript.Arguments(0)) = "dev" Then url = url & "?dev=1"
End If

sh.Run """C:\Program Files\Google\Chrome\Application\chrome.exe"" """ & url & """", 1, False
