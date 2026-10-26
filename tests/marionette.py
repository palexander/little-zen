import socket,json,time
class Client:
 def __init__(self, port):
  self.s=socket.create_connection(('127.0.0.1',port));self.s.settimeout(30);self.i=0
  self.read()
  self.call('WebDriver:NewSession',{'capabilities':{'alwaysMatch':{'acceptInsecureCerts':False}}})
  self.call('Marionette:SetContext',{'value':'chrome'})
  for handle in self.call('WebDriver:GetWindowHandles'):
   self.call('WebDriver:SwitchToWindow',{'handle':handle})
   if self.js('return !document.documentElement.hasAttribute("zen-little-window") && !window.gZenWorkspaces?.privateWindowOrDisabled;')['value']:break
 def read(self):
  n=b''
  while (c:=self.s.recv(1))!=b':':
   if not c:raise EOFError()
   n+=c
  data=b''
  while len(data)<int(n):data+=self.s.recv(int(n)-len(data))
  return json.loads(data)
 def call(self,name,args={}):
  self.i+=1;data=json.dumps([0,self.i,name,args]).encode();self.s.sendall(str(len(data)).encode()+b':'+data)
  r=self.read()
  if r[2]:raise RuntimeError(r[2])
  return r[3]
 def js(self,s,args=[]):
  return self.call('WebDriver:ExecuteScript',{'script':s,'args':args,'newSandbox':False,'sandbox':'default'})
