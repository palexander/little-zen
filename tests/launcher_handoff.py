#!/usr/bin/env python3
"""Check launcher readiness and URL-context consumption in a real isolated Zen."""
import ctypes,json,os,sys,tempfile
from pathlib import Path
import run as suite

def check(c,url,_screenshot):
 def js(s):return c.js(s)['value']
 suite.wait_until(lambda:js('return window.gZenStartup?.isReady;'))
 inbox=Path(os.environ['LITTLE_ZEN_LAUNCHER_DIRECTORY'])
 pid=js('return Services.appinfo.processID;')
 marker=inbox/f'ready-{pid}.json'
 suite.wait_until(marker.exists)
 ready=json.loads(marker.read_text())
 assert ready['pid']==pid and ready['version']==1 and ':' in ready['started'],ready
 class ProcessInfo(ctypes.Structure):
  _fields_=[('prefix',ctypes.c_ubyte*120),('seconds',ctypes.c_uint64),('microseconds',ctypes.c_uint64)]
 info=ProcessInfo()
 assert ctypes.CDLL('/usr/lib/libSystem.B.dylib').proc_pidinfo(pid,3,ctypes.c_uint64(0),ctypes.byref(info),ctypes.sizeof(info))==ctypes.sizeof(info)
 assert ready['started']==f'{info.seconds}:{info.microseconds}',ready
 now=js('return Date.now();')
 for name,target,at in [('request-0001.json',url+'other',now),('request-0002.json',url,now-61000),('request-0003.json',url,now)]:
  (inbox/name).write_text(json.dumps({'version':1,'url':target,'at':at}))
 result=js('const {BrowserWindowTracker}=ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");return BrowserWindowTracker.__littleZenMacWindowFocusBridge.noteExternalOpen('+json.dumps(url)+');')
 assert result=={},result
 assert (inbox/'request-0001.json').exists(),'Unrelated URL context was consumed'
 assert not (inbox/'request-0002.json').exists(),'Expired context was retained'
 assert not (inbox/'request-0003.json').exists(),'Matching context was not consumed'
 # Consuming a URL does not mark it reusable for a future external request.
 assert js('const {BrowserWindowTracker}=ChromeUtils.importESModule("resource:///modules/BrowserWindowTracker.sys.mjs");return BrowserWindowTracker.__littleZenMacWindowFocusBridge.noteExternalOpen('+json.dumps(url)+') === undefined;')
 print('PASS: process-start readiness, exact URL matching, expired-context cleanup and one-time consumption',flush=True)

if __name__=='__main__':
 if sys.platform!='darwin':raise SystemExit('Run this launcher integration check on macOS.')
 with tempfile.TemporaryDirectory(prefix='little-zen-inbox-') as path:
  os.environ['LITTLE_ZEN_LAUNCHER_DIRECTORY']=path
  os.environ['MOZ_REMOTE_ALLOW_SYSTEM_ACCESS']='1'
  suite.main(check=check)
