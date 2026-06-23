; Clear stale pinned taskbar shortcut on install so the icon refreshes.
; Windows caches the icon inside the LNK file — deleting it forces a fresh
; pin the next time the user pins the app.
!macro NSIS_HOOK_POSTINSTALL
  Delete "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\DoubleChat.lnk"
!macroend
