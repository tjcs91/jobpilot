const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'jobpilot-data.json');
const PUBLIC_DIR = process.env.PUBLIC_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, {recursive:true});
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);

function now(){ return new Date().toISOString(); }
function uid(){ return crypto.randomUUID(); }
function safeEmail(v){ return String(v || '').trim().toLowerCase(); }
function hashPassword(p){ return crypto.scryptSync(String(p), process.env.PASSWORD_SALT || 'jobpilot-development-salt', 32).toString('hex'); }
function parseCookies(req){
  const out={};
  for(const part of String(req.headers.cookie || '').split(';')){
    const i=part.indexOf('='); if(i<0) continue;
    out[part.slice(0,i).trim()] = decodeURIComponent(part.slice(i+1).trim());
  }
  return out;
}
function load(){
  if(!fs.existsSync(DATA_FILE)) return {businesses:[],users:[],sessions:[],services:[],customers:[],bookings:[],settings:[]};
  try { return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); } catch { return {businesses:[],users:[],sessions:[],services:[],customers:[],bookings:[],settings:[]}; }
}
const db=load();
function save(){ fs.writeFileSync(DATA_FILE, JSON.stringify(db,null,2)); }
function json(res,status,payload,extraHeaders={}){
  const body=JSON.stringify(payload);
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff', 'Content-Length':Buffer.byteLength(body), ...extraHeaders});
  res.end(body);
}
function html(res,file){
  const body=fs.readFileSync(path.join(PUBLIC_DIR,file));
  res.writeHead(200, {'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff','Content-Length':body.length}); res.end(body);
}
function setSession(res,userId){
  const token=crypto.randomBytes(32).toString('hex');
  db.sessions.push({token,userId,expiresAt:new Date(Date.now()+SESSION_DAYS*86400000).toISOString()}); save();
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie',`jobpilot_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS*86400}${secure}`);
}
function auth(req){
  const token=parseCookies(req).jobpilot_session;
  if(!token) return null;
  const s=db.sessions.find(x=>x.token===token && x.expiresAt>now()); if(!s) return null;
  const u=db.users.find(x=>x.id===s.userId); const b=u && db.businesses.find(x=>x.id===u.businessId); if(!u||!b) return null;
  return {token,user:u,business:b};
}
async function body(req){
  return await new Promise((resolve,reject)=>{let data='';req.on('data',c=>{data+=c;if(data.length>1e6){req.destroy();reject(new Error('Body too large'));}});req.on('end',()=>{try{resolve(data?JSON.parse(data):{});}catch{reject(new Error('Invalid JSON'));}});req.on('error',reject);});
}
function slugify(name){ let base=String(name||'business').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40)||'business'; let slug=base,n=2; while(db.businesses.some(b=>b.slug===slug)) slug=`${base}-${n++}`; return slug; }
function findService(businessId,id){ return db.services.find(s=>s.id===id && s.businessId===businessId && s.active); }
function createBooking({businessId,customerId,serviceId,date,time,address,notes}){
  const service=findService(businessId,serviceId); if(!service) return {error:'Invalid service.'};
  if(!/^\d{4}-\d{2}-\d{2}$/.test(String(date))||!/^[0-2]\d:[0-5]\d$/.test(String(time))) return {error:'Invalid booking date/time.'};
  const [h,m]=time.split(':').map(Number), start=h*60+m, end=start+service.durationMin;
  for(const b of db.bookings.filter(x=>x.businessId===businessId && x.date===date && x.status!=='Cancelled')){
    const [oh,om]=b.time.split(':').map(Number), os=oh*60+om, oe=os+(b.durationMin||60);
    if(start<oe && os<end) return {error:'That time overlaps an existing booking.',conflict:true};
  }
  const row={id:uid(),businessId,customerId,serviceId,date,time,address:String(address||'').trim(),notes:String(notes||'').trim(),status:'Booked',pricePence:service.pricePence,durationMin:service.durationMin,createdAt:now()};
  db.bookings.push(row); save(); return {row};
}
async function handle(req,res){
  const u=new URL(req.url,BASE_URL); const p=u.pathname; const method=req.method;
  if(method==='GET' && p==='/health') return json(res,200,{ok:true,time:now()});
  if(method==='GET'&&p==='/') return html(res,'landing.html');
  if(method==='GET'&&p==='/app') return html(res,'app.html');
  if(method==='GET'&&p.startsWith('/book/')) return html(res,'book.html');
  if(method==='GET'&&p==='/prototype') return html(res,'prototype.html');
  const a=auth(req);
  try{
    if(method==='POST'&&p==='/api/auth/signup'){
      const x=await body(req), email=safeEmail(x.email);
      if(!x.businessName||!email||!x.password||String(x.password).length<8) return json(res,400,{error:'Business name, email and an 8+ character password are required.'});
      if(db.users.some(q=>q.email===email)) return json(res,409,{error:'An account with that email already exists.'});
      const bid=uid(), uidv=uid(), created=now();
      db.businesses.push({id:bid,name:String(x.businessName).trim(),ownerName:String(x.ownerName||'').trim(),email,phone:String(x.phone||'').trim(),slug:slugify(x.businessName),createdAt:created,plan:'trial'});
      db.users.push({id:uidv,businessId:bid,email,passwordHash:hashPassword(x.password),createdAt:created});
      [['Full Valet',120,8000],['Mini Valet',60,4500],['Exterior Detail',90,6000]].forEach(s=>db.services.push({id:uid(),businessId:bid,name:s[0],durationMin:s[1],pricePence:s[2],active:true}));
      db.settings.push({businessId:bid,intro:'',workingStart:'08:00',workingEnd:'18:00',bookingNoticeHours:2,bufferMin:30}); save(); setSession(res,uidv); return json(res,200,{ok:true,slug:db.businesses.find(b=>b.id===bid).slug});
    }
    if(method==='POST'&&p==='/api/auth/login'){
      const x=await body(req), email=safeEmail(x.email), user=db.users.find(q=>q.email===email);
      if(!user||hashPassword(x.password)!==user.passwordHash) return json(res,401,{error:'Invalid email or password.'}); setSession(res,user.id); return json(res,200,{ok:true});
    }
    if(method==='POST'&&p==='/api/auth/logout'){
      if(!a) return json(res,401,{error:'Not signed in'}); db.sessions=db.sessions.filter(s=>s.token!==a.token); save(); const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
      res.setHeader('Set-Cookie',`jobpilot_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`); return json(res,200,{ok:true});
    }
    if(p.startsWith('/api/') && !a && !p.startsWith('/api/public/')) return json(res,401,{error:'Not signed in'});
    if(method==='GET'&&p==='/api/me') return json(res,200,{user:{email:a.user.email,business:{name:a.business.name,ownerName:a.business.ownerName,phone:a.business.phone,slug:a.business.slug,plan:a.business.plan}}});
    if(method==='GET'&&p==='/api/settings') return json(res,200,{business:a.business,settings:db.settings.find(s=>s.businessId===a.business.id)||{}});
    if(method==='PATCH'&&p==='/api/settings'){
      const x=await body(req); if(!String(x.name||'').trim()) return json(res,400,{error:'Business name is required.'}); Object.assign(a.business,{name:String(x.name).trim(),ownerName:String(x.ownerName||'').trim(),phone:String(x.phone||'').trim()}); let s=db.settings.find(q=>q.businessId===a.business.id); if(!s){s={businessId:a.business.id};db.settings.push(s);} Object.assign(s,{intro:String(x.intro||''),workingStart:String(x.workingStart||'08:00'),workingEnd:String(x.workingEnd||'18:00'),bookingNoticeHours:Number(x.bookingNoticeHours||2),bufferMin:Number(x.bufferMin||30)}); save(); return json(res,200,{ok:true});
    }
    if(method==='GET'&&p==='/api/services') return json(res,200,db.services.filter(s=>s.businessId===a.business.id).map(s=>({id:s.id,name:s.name,durationMin:s.durationMin,pricePence:s.pricePence,active:s.active})));
    if(method==='POST'&&p==='/api/services'){
      const x=await body(req), durationMin=Number(x.durationMin), price=Math.round(Number(x.price)*100); if(!x.name||durationMin<15||!Number.isFinite(price)||price<0) return json(res,400,{error:'Invalid service.'}); const s={id:uid(),businessId:a.business.id,name:String(x.name).trim(),durationMin,pricePence:price,active:true}; db.services.push(s);save();return json(res,201,s);
    }
    if(method==='GET'&&p==='/api/customers'){
      return json(res,200,db.customers.filter(c=>c.businessId===a.business.id).map(c=>({...c,bookingsCount:db.bookings.filter(b=>b.customerId===c.id).length})));
    }
    if(method==='POST'&&p==='/api/customers'){
      const x=await body(req); if(!x.name) return json(res,400,{error:'Customer name is required.'}); const c={id:uid(),businessId:a.business.id,name:String(x.name).trim(),phone:String(x.phone||'').trim(),email:safeEmail(x.email),vehicleDetails:String(x.vehicleDetails||'').trim(),notes:String(x.notes||'').trim(),createdAt:now()}; db.customers.push(c);save();return json(res,201,c);
    }
    if(method==='GET'&&p==='/api/bookings'){
      const out=db.bookings.filter(b=>b.businessId===a.business.id).sort((x,y)=>(x.date+x.time).localeCompare(y.date+y.time)).map(b=>({...b,customerName:db.customers.find(c=>c.id===b.customerId)?.name||'',customerPhone:db.customers.find(c=>c.id===b.customerId)?.phone||'',serviceName:db.services.find(s=>s.id===b.serviceId)?.name||''})); return json(res,200,out);
    }
    if(method==='POST'&&p==='/api/bookings'){
      const x=await body(req), c=db.customers.find(c=>c.id===x.customerId&&c.businessId===a.business.id); if(!c)return json(res,400,{error:'Invalid customer.'}); const result=createBooking({businessId:a.business.id,...x}); if(result.error)return json(res,result.conflict?409:400,{error:result.error}); return json(res,201,result.row);
    }
    if(method==='PATCH'&&p.startsWith('/api/bookings/')){
      const bid=p.split('/').pop(), b=db.bookings.find(x=>x.id===bid&&x.businessId===a.business.id); if(!b)return json(res,404,{error:'Booking not found'}); const x=await body(req); if(['Booked','Completed','Cancelled','No-show'].includes(x.status)) b.status=x.status; save();return json(res,200,{ok:true});
    }
    if(method==='POST'&&p==='/api/quotes/draft'){
      const x=await body(req), services=db.services.filter(s=>s.businessId===a.business.id&&s.active); if(!x.message)return json(res,400,{error:'Customer message required.'});
      if(process.env.OPENAI_API_KEY){
        try{ const prompt=`Draft a concise customer-ready reply for a UK mobile car detailing business. Never invent availability, prices or guarantees. Customer message: ${x.message}\nCustomer name: ${x.customerName||'there'}\nServices: ${JSON.stringify(services.map(s=>({name:s.name,price:`£${(s.pricePence/100).toFixed(2)}`,durationMin:s.durationMin})))}\nBusiness: ${a.business.name}`; const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${process.env.OPENAI_API_KEY}`},body:JSON.stringify({model:process.env.OPENAI_MODEL||'gpt-5-mini',messages:[{role:'system',content:'Return only the customer-ready draft reply.'},{role:'user',content:prompt}],temperature:0.2,max_tokens:300})}); if(r.ok){const j=await r.json();const draft=j.choices?.[0]?.message?.content?.trim();if(draft)return json(res,200,{draft});}}catch(e){console.error('AI fallback',e.message)}
      }
      const s=services[0], price=s?`£${(s.pricePence/100).toFixed(2)}`:'a tailored quote'; const draft=`Hi ${x.customerName||'there'},\n\nThanks for getting in touch. Based on your enquiry, our ${s?.name?.toLowerCase()||'service'} is ${price}.\n\nSend over your preferred date/time and the full job address and I’ll check availability for you. We can confirm the final price once we have the full details.\n\nThanks,\n${a.business.ownerName||a.business.name}`; return json(res,200,{draft});
    }
    if(method==='GET'&&p.startsWith('/api/public/')){
      const slug=p.split('/')[3], b=db.businesses.find(q=>q.slug===slug); if(!b)return json(res,404,{error:'Business not found'}); const s=db.services.filter(x=>x.businessId===b.id&&x.active).map(x=>({id:x.id,name:x.name,durationMin:x.durationMin,pricePence:x.pricePence})); return json(res,200,{business:{name:b.name,ownerName:b.ownerName,phone:b.phone,slug:b.slug},services:s});
    }
    if(method==='POST'&&p.startsWith('/api/public/')&&p.endsWith('/book')){
      const slug=p.split('/')[3], b=db.businesses.find(q=>q.slug===slug); if(!b)return json(res,404,{error:'Business not found'}); const x=await body(req); if(!x.name||!x.phone||!x.serviceId||!x.date||!x.time)return json(res,400,{error:'Name, phone, service, date and time are required.'}); let c=db.customers.find(q=>q.businessId===b.id&&q.phone===String(x.phone).trim()); if(!c){c={id:uid(),businessId:b.id,name:String(x.name).trim(),phone:String(x.phone).trim(),email:safeEmail(x.email),vehicleDetails:String(x.vehicleDetails||''),notes:'',createdAt:now()};db.customers.push(c);save();} const r=createBooking({businessId:b.id,customerId:c.id,...x}); if(r.error)return json(res,r.conflict?409:400,{error:r.error}); return json(res,201,{ok:true,bookingId:r.row.id});
    }
    if(method==='POST'&&p==='/api/billing/checkout') return json(res,503,{error:'Billing connection is the next external integration. Add Stripe credentials when ready.'});
    // Static assets
    if(method==='GET'){
      const pathname=decodeURIComponent(p); const safe=pathname.replace(/^\/+/, ''); const file=path.join(PUBLIC_DIR,safe); if(file.startsWith(PUBLIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()){ const ext=path.extname(file); const type={'.html':'text/html','.css':'text/css','.js':'application/javascript','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'}[ext]||'application/octet-stream'; const buf=fs.readFileSync(file);res.writeHead(200,{'Content-Type':type,'X-Content-Type-Options':'nosniff','Content-Length':buf.length});return res.end(buf); }
    }
    return json(res,404,{error:'Not found'});
  }catch(e){ console.error(e); return json(res,500,{error:'Server error'}); }
}
const server=http.createServer((req,res)=>handle(req,res));
server.listen(PORT, '0.0.0.0', ()=>console.log(`JobPilot running at ${BASE_URL}`));
