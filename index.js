// ══════════════════════════════════════
// CHART TERMINAL MIGRATION NOTE
// The chart terminal (Chart Cockpit, order book, trade terminal, footprint,
// order flow, liquidity, AI assistant, profile/settings) is being extracted
// out of this file into standalone modules under /chart-terminal/*.js.
// Until that migration is complete, ALL existing chart logic below stays
// exactly as-is and continues to run the live site. Do not remove any
// chart-related code from this file until its replacement module has been
// built, tested, and its <script> tag uncommented in index.html.
// ══════════════════════════════════════

// ══════════════════════════════════════
// SUPABASE INIT
// ══════════════════════════════════════
const SUPA_URL = 'https://ucwgvvsnellchioltkxs.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVjd2d2dnNuZWxsY2hpb2x0a3hzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAwODEyOTYsImV4cCI6MjA5NTY1NzI5Nn0.goU5F94rJcih_Nv8Gqp0xR7LjAH8n3zqp8qtLYLQPZM';
const { createClient } = supabase;
const db = createClient(SUPA_URL, SUPA_KEY);

// ══════════════════════════════════════
// APP STATE
// ══════════════════════════════════════
let state = {
  user: null,
  profile: null,
  brokers: [],

  activeBroker: null,
  currentDayId: null,
  currentTradeIdx: null,
  direction: 'long',
  conclusion: 'target',
  selectedChart: null,
  statsFilter: 'month',
  calMonth: new Date().getMonth(),
  calYear: new Date().getFullYear()
};

// ══════════════════════════════════════
// NAVIGATION
// ══════════════════════════════════════
function showPage(id){
  document.querySelectorAll('.page,.app-page').forEach(p=>p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if(id==='page-app') document.getElementById('mobile-nav').style.display='block';
  else document.getElementById('mobile-nav').style.display='none';
  window.scrollTo(0,0);
}

function openSidebar(){
  document.getElementById('sidebar').classList.add('open');
  const bd=document.getElementById('sidebar-backdrop');
  if(bd)bd.style.display='block';
}
function closeSidebar(){
  document.getElementById('sidebar').classList.remove('open');
  const bd=document.getElementById('sidebar-backdrop');
  if(bd)bd.style.display='none';
}
function showSection(key){
  document.querySelectorAll('.content-section').forEach(s=>s.classList.remove('active'));
  const el = document.getElementById('section-'+key);
  if(el) el.classList.add('active');
  closeSidebar();
  updateNavigationLayout(key);
  if(key==='home') refreshHome();
  if(key==='trade-list') refreshTradeList();
  if(key==='stats') {renderStats();renderCapitalGrowth();}
  if(key==='calculator') {
    initCalcBrokers();
  }
  if(key==='chart') { initMainChart(); initOrderBook(); initMarketOverview(); }
}

function setSideNav(id){
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  const el=document.getElementById(id);
  if(el) el.classList.add('active');
}
function setMobNav(id){
  document.querySelectorAll('.mn-item').forEach(n=>n.classList.remove('active'));
  const el=document.getElementById(id);
  if(el) el.classList.add('active');
}

// ══════════════════════════════════════
// CHART PAGE — TOP NAVIGATION SYNC
// Sidebar/topbar hide-show for the Chart page is already handled purely
// in CSS (#page-app:has(#section-chart.active)), driven by the same
// .content-section.active class showSection() already toggles above —
// so no visibility logic is duplicated here in JS.
// This helper only keeps the new horizontal .chart-nav-item buttons'
// active state centralized and in sync with whatever section is open,
// the same way setSideNav()/setMobNav() already do for their own navs.
// ══════════════════════════════════════
function setChartNav(key){
  document.querySelectorAll('.chart-nav-item').forEach(btn=>{
    const call = btn.getAttribute('onclick') || '';
    const match = call.match(/showSection\('([^']+)'\)/);
    btn.classList.toggle('active', !!match && match[1] === key);
  });
}
function updateNavigationLayout(key){
  setChartNav(key);
}

// ══════════════════════════════════════
// AUTH
// ══════════════════════════════════════
function showAuth(tab){
  showPage('page-auth');
  switchTab(tab);
}

function switchTab(tab){
  ['form-login','form-signup','form-forgot'].forEach(f=>document.getElementById(f).style.display='none');
  ['tab-login','tab-signup'].forEach(t=>document.getElementById(t)?.classList.remove('active'));
  hideMsg();
  if(tab==='login'){
    document.getElementById('form-login').style.display='block';
    document.getElementById('tab-login')?.classList.add('active');
    document.getElementById('auth-title').textContent='Welcome back';
    document.getElementById('auth-sub').textContent='Sign in to your EdgeTrade account';
  } else if(tab==='signup'){
    document.getElementById('form-signup').style.display='block';
    document.getElementById('tab-signup')?.classList.add('active');
    document.getElementById('auth-title').textContent='Join EdgeTrade';
    document.getElementById('auth-sub').textContent='Create your free account — 30 seconds';
  } else if(tab==='forgot'){
    document.getElementById('form-forgot').style.display='block';
    document.getElementById('auth-title').textContent='Reset Password';
    document.getElementById('auth-sub').textContent='We will send a reset link';
  }
}

async function handleLogin(){
  const email=document.getElementById('l-email').value.trim();
  const pass=document.getElementById('l-pass').value;
  if(!email||!pass){showMsg('error','Please enter email and password.');return;}
  const btn=document.getElementById('btn-login');
  btn.disabled=true;btn.textContent='Signing in...';
  const {data,error}=await db.auth.signInWithPassword({email,password:pass});
  btn.disabled=false;btn.textContent='Sign In to EdgeTrade';
  if(error){showMsg('error',error.message);return;}
  await initApp(data.user);
}

async function handleSignup(){
  const name=document.getElementById('s-name').value.trim();
  const email=document.getElementById('s-email').value.trim();
  const pass=document.getElementById('s-pass').value;
  const country=document.getElementById('s-country').value;
  if(!name||!email||!pass||!country){showMsg('error','Please fill all fields including country.');return;}
  if(pass.length<6){showMsg('error','Password must be at least 6 characters.');return;}
  const btn=document.getElementById('btn-signup');
  btn.disabled=true;btn.textContent='Creating account...';
  const {data,error}=await db.auth.signUp({
    email,password:pass,
    options:{data:{full_name:name,country}}
  });
  btn.disabled=false;btn.textContent='Create Free Account';
  if(error){showMsg('error',error.message);return;}
  showMsg('success','✓ Account created! Signing you in...');
  setTimeout(async()=>{ await initApp(data.user); },1200);
}

async function handleForgot(){
  const email=document.getElementById('f-email').value.trim();
  if(!email){showMsg('error','Please enter your email.');return;}
  const btn=document.getElementById('btn-forgot');
  btn.disabled=true;btn.textContent='Sending...';
  const {error}=await db.auth.resetPasswordForEmail(email,{redirectTo:window.location.href});
  btn.disabled=false;btn.textContent='Send Reset Link';
  if(error){showMsg('error',error.message);return;}
  showMsg('success','✓ Reset link sent! Check your email inbox.');
}

async function handleLogout(){
  await db.auth.signOut();
  state={user:null,profile:null,brokers:[],days:[],activeBroker:null,currentDayId:null,currentTradeIdx:null,direction:'long',conclusion:'target',selectedChart:null,statsFilter:'month',calMonth:new Date().getMonth(),calYear:new Date().getFullYear()};
  showPage('page-landing');
  showToast('Signed out successfully','success');
}

async function handlePasswordChange(){
  const np=document.getElementById('g-newpass').value;
  const cp=document.getElementById('g-confpass').value;
  const ms=document.getElementById('pass-msg-s');
  const me=document.getElementById('pass-msg-e');
  ms.style.display='none';me.style.display='none';
  if(!np||!cp){me.style.display='block';me.textContent='Please fill both fields.';return;}
  if(np!==cp){me.style.display='block';me.textContent='Passwords do not match.';return;}
  if(np.length<6){me.style.display='block';me.textContent='Password must be at least 6 characters.';return;}
  const {error}=await db.auth.updateUser({password:np});
  if(error){me.style.display='block';me.textContent=error.message;return;}
  ms.style.display='block';
  document.getElementById('g-newpass').value='';
  document.getElementById('g-confpass').value='';
  setTimeout(()=>{ms.style.display='none';showSection('profile');},2000);
}

// ══════════════════════════════════════
// APP INIT
// ══════════════════════════════════════
async function initApp(user){
  state.user=user;
  showPage('page-app');
  await loadProfile();
  await loadBrokers();
  await loadDays();
  refreshHome();
  showSection('home');
}

async function loadProfile(){
  const {data}=await db.from('profiles').select('*').eq('id',state.user.id).single();
  if(data){
    state.profile=data;
    const name=data.full_name||state.user.email||'Trader';
    const initials=name.charAt(0).toUpperCase();
    document.getElementById('sidebar-name').textContent=name;
    document.getElementById('profile-name-display').textContent=name;
    document.getElementById('profile-email-display').textContent=state.user.email||'';
    const savedDp=data.avatar_url;
    // Profile big avatar
    const avEl=document.getElementById('profile-av-big');
    // Sidebar avatar
    const sideAv=document.getElementById('sidebar-av');
    // Topbar avatar
    const topAv=document.getElementById('topbar-av');
    if(savedDp){
      // Profile big
      avEl.style.backgroundImage=`url(${savedDp})`;
      avEl.style.backgroundSize='cover';
      avEl.style.backgroundPosition='center';
      avEl.textContent='';
      // Sidebar
      sideAv.style.backgroundImage=`url(${savedDp})`;
      sideAv.style.backgroundSize='cover';
      sideAv.style.backgroundPosition='center';
      sideAv.textContent='';
      // Topbar
      topAv.style.backgroundImage=`url(${savedDp})`;
      topAv.style.backgroundSize='cover';
      topAv.style.backgroundPosition='center';
      topAv.textContent='';
    } else {
      avEl.textContent=initials;
      sideAv.textContent=initials;
      topAv.textContent=initials;
    }
  }
}

async function loadBrokers(){
  const {data}=await db.from('user_broker_connections').select('*').eq('user_id',state.user.id).eq('is_active',true).order('created_at');
  state.brokers=data||[];
  if(state.brokers.length>0&&!state.activeBroker){
    const b=state.brokers[0];
    state.activeBroker=b.id;
    const nm=b.account_label||b.name||'Broker';
    document.getElementById('active-broker-nm').textContent=nm;
  }
}

async function loadDays(){
  const {data}=await db.from('trading_days').select('id,date,broker_id,connection_id').eq('user_id',state.user.id).order('date',{ascending:false});
  if(!data){state.days=[];return;}
  // Load trades for each day
  const dayIds=data.map(d=>d.id);
  let trades=[];
  if(dayIds.length>0){
    const {data:td}=await db.from('trades').select('*').in('day_id',dayIds).order('created_at');
    trades=td||[];
  }
  state.days=data.map(d=>({...d,trades:trades.filter(t=>t.day_id===d.id)}));
}

// ══════════════════════════════════════
// HOME PAGE
// ══════════════════════════════════════
function getActiveBrokerDays(){
  if(!state.activeBroker) return [];
  return state.days.filter(d=>d.connection_id===state.activeBroker);
}

function refreshHome(){
  const now=new Date();
  document.getElementById('month-badge').textContent=now.toLocaleString('default',{month:'long',year:'numeric'});
  const activeDays=getActiveBrokerDays();
  document.getElementById('days-count-lbl').textContent=activeDays.length+' day'+(activeDays.length===1?'':'s')+' logged';
  const grid=document.getElementById('days-grid');
  document.querySelectorAll('.day-card').forEach(c=>c.remove());
  const empty=document.getElementById('empty-state');
  if(!state.brokers.length){
    empty.style.display='block';
    empty.querySelector('.empty-icon').textContent='🔗';
    empty.querySelector('.empty-title').textContent='No broker connected';
    empty.querySelector('.empty-sub').innerHTML='Connect a broker or create a manual account first.<br>Go to Brokers to get started.';
    updateBalCards();
    return;
  }
  if(activeDays.length===0){
    empty.style.display='block';
    empty.querySelector('.empty-icon').textContent='📋';
    empty.querySelector('.empty-title').textContent='No trading days yet';
    empty.querySelector('.empty-sub').innerHTML='Click "Add Trading Day" to start.<br>Or connect a broker to auto-sync.';
    updateBalCards();
    return;
  }
  empty.style.display='none';
  activeDays.forEach((day,i)=>{
    const card=makeDayCard(day,i);
    grid.appendChild(card);
  });
  updateBalCards();
}

function makeDayCard(day,i){
  const trades=day.trades||[];
  const total=trades.length;
  const profits=trades.filter(t=>t.conclusion==='target').length;
  const losses=trades.filter(t=>t.conclusion==='loss').length;
  let cls='',res='',resCls='dcr-empty';
  if(total>0){
    if(profits>losses){cls='dc-profit';res='▲ PROFIT';resCls='dcr-profit';}
    else if(losses>profits){cls='dc-loss';res='▼ LOSS';resCls='dcr-loss';}
    else{res='— BREAKEVEN';resCls='dcr-be';}
  }
  const d=new Date(day.date+'T00:00:00');
  const ds=d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'2-digit'});
  const c=document.createElement('div');
  c.className='day-card '+cls;
  c.style.animationDelay=(i*0.04)+'s';
  c.onclick=()=>openDay(day.id);
  c.innerHTML=`<div class="dc-inner"><div class="dc-date">${ds}</div><div class="dc-lbl">trades</div><div class="dc-count">${total}</div>${total>0?`<div class="dc-result ${resCls}">${res}</div>`:`<div class="dc-result dcr-empty">Tap to add entry</div>`}</div>`;
  return c;
}

function updateBalCards(){
  const days=getActiveBrokerDays();
  let pt=0,lt=0;
  days.forEach(d=>(d.trades||[]).forEach(t=>{
    if(t.conclusion==='target')pt++;
    if(t.conclusion==='loss')lt++;
  }));
  document.getElementById('badge-profit').textContent=pt+' trades';
  document.getElementById('badge-loss').textContent=lt+' trades';
  if(pt===0&&lt===0){
    ['bal-total','bal-profit','bal-loss','bal-balance'].forEach(id=>document.getElementById(id).textContent='—');
  }
}

async function addNewDay(){
  if(!state.user){showToast('Please sign in first','error');return;}
  if(!state.activeBroker){showToast('Pehle broker connect ya select karo','error');return;}
  const today=new Date().toISOString().split('T')[0];
  const exists=getActiveBrokerDays().find(d=>d.date===today);
  if(exists){openDay(exists.id);return;}
  const {data,error}=await db.from('trading_days').insert([{user_id:state.user.id,connection_id:state.activeBroker,date:today}]).select().single();
  if(error){showToast('Error creating day: '+error.message,'error');return;}
  state.days.unshift({...data,trades:[]});
  openDay(data.id);
}

// ══════════════════════════════════════
// TRADE LIST (C)
// ══════════════════════════════════════
function openDay(dayId){
  state.currentDayId=dayId;
  showSection('trade-list');
}

function refreshTradeList(){
  const day=state.days.find(d=>d.id===state.currentDayId);
  if(!day)return;
  const d=new Date(day.date+'T00:00:00');
  const ds=d.toLocaleDateString('en-GB',{day:'2-digit',month:'long',year:'numeric'});
  const trades=day.trades||[];
  document.getElementById('tl-date').textContent=ds;
  document.getElementById('tl-sub').textContent=trades.length+' trade'+(trades.length===1?'':'s')+' logged';
  document.getElementById('ds-date').textContent=ds;
  document.getElementById('ds-total').textContent=trades.length+' Trades';
  document.getElementById('ds-profit').textContent=trades.filter(t=>t.conclusion==='target').length+' Profit';
  document.getElementById('ds-loss').textContent=trades.filter(t=>t.conclusion==='loss').length+' Loss';
  document.getElementById('ds-be').textContent=trades.filter(t=>t.conclusion==='breakeven').length+' Breakeven';
  const list=document.getElementById('trades-list');
  document.querySelectorAll('.trade-card').forEach(c=>c.remove());
  const empty=document.getElementById('trades-empty');
  if(trades.length===0){empty.style.display='block';return;}
  empty.style.display='none';
  trades.forEach((t,i)=>{
    const card=makeTradeCard(t,i);
    list.appendChild(card);
  });
}

function makeTradeCard(t,i){
  const cmap={target:'tc-profit',loss:'tc-loss',breakeven:'tc-be'};
  const rlabel={target:'Profit',loss:'Loss',breakeven:'Breakeven'};
  const rbadge={target:'trb-profit',loss:'trb-loss',breakeven:'trb-be'};
  const dsym=t.direction==='long'?'▲':'▼';
  const dclass=t.direction==='long'?'tc-dir-l':'tc-dir-s';
  const c=document.createElement('div');
  c.className='trade-card glass-3d '+(cmap[t.conclusion]||'tc-profit');
  c.onclick=()=>openTradeEntry(i);
  c.innerHTML=`<div class="tc-num">${i+1}</div><div class="tc-dir ${dclass}">${dsym}</div><div class="tc-main"><div class="tc-top"><span class="tc-asset">${t.chart_name||'—'}</span><span class="tc-res-badge ${rbadge[t.conclusion]||'trb-profit'}">${rlabel[t.conclusion]||'Profit'}</span>${t.rrr?`<span class="tc-rrr">R:R ${t.rrr}</span>`:''}</div><div class="tc-bottom"><span class="tc-time">${t.entry_time||'—'}</span>${t.strategy?`<span class="tc-strategy">· ${t.strategy.substring(0,35)}${t.strategy.length>35?'...':''}</span>`:''}</div></div><div class="tc-right"><span class="tc-pnl ${t.conclusion==='target'?'tc-pnl-p':t.conclusion==='loss'?'tc-pnl-l':'tc-pnl-b'}">${t.conclusion==='target'?'+':t.conclusion==='loss'?'-':'±'}${t.exit_price||'—'}</span><span class="tc-arrow">›</span></div>`;
  return c;
}

function openTradeEntry(idx){
  const day=state.days.find(d=>d.id===state.currentDayId);
  if(!day)return;
  state.currentTradeIdx=idx;
  const d=new Date(day.date+'T00:00:00');
  const ds=d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'2-digit'});
  const isEdit=idx<day.trades.length;
  document.getElementById('te-title').textContent=isEdit?`Trade #${idx+1} — ${ds}`:`New Trade — ${ds}`;
  document.getElementById('te-sub').textContent=isEdit?'Edit trade entry':'Fill in your trade details';
  if(isEdit) fillForm(day.trades[idx]); else clearForm();
  showSection('trade-entry');
}

function openNewTrade(){
  const day=state.days.find(d=>d.id===state.currentDayId);
  if(!day){addNewDay();return;}
  openTradeEntry(day.trades.length);
}

function fillForm(t){
  const fields={
    'e-init':t.initial_capital,'e-upd':t.updated_capital,
    'e-chart':t.chart_name,'e-lot':t.lot_size,
    'e-time':t.entry_time,
    'e-session':t.session,'e-entry':t.entry_price,
    'e-fees':t.fees,'e-tp':t.take_profit,
    'e-ttp':t.trailing_profit,'e-sl':t.stop_loss,
    'e-tsl':t.trailing_sl,'e-exit':t.exit_price,
    'e-rrr':t.rrr,'e-strategy':t.strategy,
    'e-pov':t.pov,'e-psych':t.psychology,
    'e-learn':t.learning,'e-diff':t.different_approach
  };
  Object.entries(fields).forEach(([id,val])=>{const el=document.getElementById(id);if(el)el.value=val||'';});
  if(t.lot_unit){
    document.getElementById('e-lot-unit').value=t.lot_unit;
    const labels={lot:'Lot',usd:'USD',inr:'INR',asset:'Asset'};
    const lbl=document.getElementById('lot-unit-label');
    if(lbl)lbl.textContent=labels[t.lot_unit]||t.lot_unit;
  }
  if(t.leverage){
    const lv=parseInt(t.leverage)||1;
    document.getElementById('e-leverage').value=t.leverage;
    const sl=document.getElementById('e-lev-slider');if(sl)sl.value=Math.min(500,lv);
    const badge=document.getElementById('lev-val-badge');if(badge)badge.textContent=lv+'X';
  }
  selDir(t.direction||'long');
  selConc(t.conclusion||'target');
}

function clearForm(){
  ['e-init','e-upd','e-chart','e-lot','e-time','e-leverage','e-entry','e-fees','e-tp','e-ttp','e-sl','e-tsl','e-exit','e-rrr','e-strategy','e-pov','e-psych','e-learn','e-diff'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  document.getElementById('e-session').value='';
  document.getElementById('e-lot-unit').value='lot';
  const lbl=document.getElementById('lot-unit-label');if(lbl)lbl.textContent='Lot';
  const sl=document.getElementById('e-lev-slider');if(sl)sl.value=1;
  const badge=document.getElementById('lev-val-badge');if(badge)badge.textContent='1X';
  selDir('long');selConc('target');state.selectedChart=null;
}

async function saveTrade(){
  const day=state.days.find(d=>d.id===state.currentDayId);
  if(!day||!state.user){showToast('Error: No day selected','error');return;}
  const btn=document.getElementById('save-trade-btn');
  btn.disabled=true;btn.textContent='Saving...';
  const trade={
    day_id:day.id,user_id:state.user.id,
    chart_name:document.getElementById('e-chart').value||null,
    lot_size:parseFloat(document.getElementById('e-lot').value)||null,
    lot_unit:document.getElementById('e-lot-unit').value,
    entry_time:document.getElementById('e-time').value||null,
    leverage:document.getElementById('e-leverage').value||null,
    session:document.getElementById('e-session').value||null,
    entry_price:parseFloat(document.getElementById('e-entry').value)||null,
    fees:parseFloat(document.getElementById('e-fees').value)||null,
    direction:state.direction,
    take_profit:parseFloat(document.getElementById('e-tp').value)||null,
    trailing_profit:parseFloat(document.getElementById('e-ttp').value)||null,
    stop_loss:parseFloat(document.getElementById('e-sl').value)||null,
    trailing_sl:parseFloat(document.getElementById('e-tsl').value)||null,
    exit_price:parseFloat(document.getElementById('e-exit').value)||null,
    rrr:document.getElementById('e-rrr').value||null,
    strategy:document.getElementById('e-strategy').value||null,
    pov:document.getElementById('e-pov').value||null,
    psychology:document.getElementById('e-psych').value||null,
    learning:document.getElementById('e-learn').value||null,
    different_approach:document.getElementById('e-diff').value||null,
    conclusion:state.conclusion,
    initial_capital:parseFloat(document.getElementById('e-init').value)||null,
    updated_capital:parseFloat(document.getElementById('e-upd').value)||null,
    trade_number:state.currentTradeIdx+1
  };
  let err;
  if(state.currentTradeIdx<day.trades.length){
    const existing=day.trades[state.currentTradeIdx];
    const {error}=await db.from('trades').update(trade).eq('id',existing.id);
    err=error;
    if(!error) day.trades[state.currentTradeIdx]={...existing,...trade};
  } else {
    const {data,error}=await db.from('trades').insert([trade]).select().single();
    err=error;
    if(!error) day.trades.push(data);
  }
  btn.disabled=false;btn.textContent='💾 Save Trade Entry';
  if(err){showToast('Error: '+err.message,'error');return;}
  showToast('Trade saved successfully!','success');
  showSection('trade-list');
}

// ══════════════════════════════════════
function syncLevSlider(val){
  const v=parseInt(val)||1;
  document.getElementById('e-leverage').value=v+'X';
  const badge=document.getElementById('lev-val-badge');if(badge)badge.textContent=v+'X';
}
function syncLevInput(val){
  const num=parseInt(val)||1;
  const clamped=Math.min(500,Math.max(1,num));
  const sl=document.getElementById('e-lev-slider');if(sl)sl.value=clamped;
  document.getElementById('lev-val-badge').textContent=clamped+'X';
}
function setLev(v){
  document.getElementById('e-leverage').value=v+'X';
  const sl=document.getElementById('e-lev-slider');if(sl)sl.value=v;
  document.getElementById('lev-val-badge').textContent=v+'X';
  const dd=document.getElementById('lev-unit-dd');if(dd)dd.style.display='none';
}
// LOT STEPPER & DROPDOWN
function stepLot(dir){
  const inp=document.getElementById('e-lot');
  const cur=parseFloat(inp.value)||0;
  const next=Math.max(0,parseFloat((cur+dir).toFixed(6)));
  inp.value=next;
}
function toggleLotDD(e){
  if(e)e.stopPropagation();
  const dd=document.getElementById('lot-unit-dd');
  dd.style.display=dd.style.display==='none'?'block':'none';
}
function toggleLevDD(e){
  if(e)e.stopPropagation();
  const dd=document.getElementById('lev-unit-dd');
  dd.style.display=dd.style.display==='none'?'block':'none';
}
function selectLotUnit(val,label){
  document.getElementById('e-lot-unit').value=val;
  document.getElementById('lot-unit-label').textContent=label;
  document.getElementById('lot-unit-dd').style.display='none';
}
// Close all dropdowns on outside click
document.addEventListener('click',function(e){
  ['lot-unit-btn','lot-unit-dd','lev-unit-btn','lev-unit-dd'].forEach(function(id,i){
    if(i%2===0){
      const btn=document.getElementById(id);
      const dd=document.getElementById(['lot-unit-dd','lot-unit-dd','lev-unit-dd','lev-unit-dd'][i]);
      if(dd&&btn&&!btn.contains(e.target)&&!dd.contains(e.target)){dd.style.display='none';}
    }
  });
});

function getSessionFromISTTime(timeStr){
  if(!timeStr)return null;
  const [hh,mm]=timeStr.split(':').map(Number);
  if(isNaN(hh)||isNaN(mm))return null;
  const totalMin=hh*60+mm;
  // All ranges below are in IST (24hr clock, minutes since midnight)
  // London-NY Overlap: 18:30–22:30 IST
  if(totalMin>=(18*60+30)&&totalMin<=(22*60+30))return 'London-NY Overlap';
  // London: 13:30–22:30 IST
  if(totalMin>=(13*60+30)&&totalMin<=(22*60+30))return 'London';
  // New York: 18:30 IST – 03:30 IST (wraps past midnight)
  if(totalMin>=(18*60+30)||totalMin<=(3*60+30))return 'New York';
  // Asian: 05:30–14:30 IST
  if(totalMin>=(5*60+30)&&totalMin<=(14*60+30))return 'Asian';
  // Anything else (very early IST morning gap) — fallback
  if(totalMin>=(3*60+30)&&totalMin<(5*60+30))return 'Pre-Market';
  return 'Post-Market';
}

function autoDetectSession(timeStr){
  const sess=getSessionFromISTTime(timeStr);
  const sel=document.getElementById('e-session');
  if(sess&&sel)sel.value=sess;
}

async function backfillSessions(){
  const allTrades=[];
  (state.days||[]).forEach(d=>{(d.trades||[]).forEach(t=>allTrades.push(t));});
  const toUpdate=allTrades.filter(t=>!t.session && t.entry_time);
  if(toUpdate.length===0){showToast('No trades need session backfill.','success');return;}
  if(!confirm(`This will auto-fill the Session field for ${toUpdate.length} trade(s) that have an Entry Time but no Session, based on IST time ranges. Continue?`))return;
  let updated=0;
  for(const t of toUpdate){
    const sess=getSessionFromISTTime(t.entry_time);
    if(sess){
      const { error } = await db.from('trades').update({session:sess}).eq('id',t.id);
      if(!error){t.session=sess;updated++;}
    }
  }
  showToast(`Backfilled session for ${updated} trade(s).`,'success');
  renderStats();
}

// Broker lot sync — called when broker sends trade data via postMessage or websocket
function syncBrokerLot(lotValue, unit){
  const inp=document.getElementById('e-lot');
  if(inp&&lotValue!=null){
    inp.value=lotValue;
    inp.style.color='var(--green)';
    setTimeout(function(){inp.style.color='var(--white)';},1200);
  }
  if(unit){selectLotUnit(unit,unit.charAt(0).toUpperCase()+unit.slice(1));}
  const badge=document.getElementById('lot-sync-badge');
  if(badge){badge.style.display='inline';}
}
// Listen for broker postMessage (works with Binance/Delta bridge extensions)
window.addEventListener('message',function(ev){
  if(ev.data&&ev.data.type==='BROKER_TRADE'){
    const d=ev.data;
    if(d.lot!=null)syncBrokerLot(d.lot, d.lotUnit||'lot');
    if(d.leverage!=null)setLev(parseInt(d.leverage));
  }
});
// FORM HELPERS
// ══════════════════════════════════════
function selDir(d){
  state.direction=d;
  document.getElementById('dir-long').classList.toggle('active',d==='long');
  document.getElementById('dir-short').classList.toggle('active',d==='short');
}
function selConc(v){
  state.conclusion=v;
  ['t','b','l'].forEach(k=>document.getElementById('conc-'+k).classList.remove('active'));
  const m={target:'conc-t',breakeven:'conc-b',loss:'conc-l'};
  if(m[v])document.getElementById(m[v]).classList.add('active');
}
function toggleEye(id,btn){
  const i=document.getElementById(id);
  i.type=i.type==='password'?'text':'password';
  btn.textContent=i.type==='text'?'🙈':'👁';
}

// ══════════════════════════════════════
// CHART SELECTOR
// ══════════════════════════════════════
const CHARTS=[
  {sym:'BTC/USDT',name:'Bitcoin',cat:'crypto'},{sym:'ETH/USDT',name:'Ethereum',cat:'crypto'},
  {sym:'SOL/USDT',name:'Solana',cat:'crypto'},{sym:'XRP/USDT',name:'Ripple',cat:'crypto'},
  {sym:'BNB/USDT',name:'BNB',cat:'crypto'},{sym:'ADA/USDT',name:'Cardano',cat:'crypto'},
  {sym:'DOGE/USDT',name:'Dogecoin',cat:'crypto'},{sym:'AVAX/USDT',name:'Avalanche',cat:'crypto'},
  {sym:'MATIC/USDT',name:'Polygon',cat:'crypto'},{sym:'DOT/USDT',name:'Polkadot',cat:'crypto'},
  {sym:'LTC/USDT',name:'Litecoin',cat:'crypto'},{sym:'LINK/USDT',name:'Chainlink',cat:'crypto'},
  {sym:'EUR/USD',name:'Euro Dollar',cat:'forex'},{sym:'GBP/USD',name:'Pound Dollar',cat:'forex'},
  {sym:'USD/JPY',name:'Dollar Yen',cat:'forex'},{sym:'AUD/USD',name:'Aussie Dollar',cat:'forex'},
  {sym:'USD/CHF',name:'Swiss Franc',cat:'forex'},{sym:'NZD/USD',name:'Kiwi Dollar',cat:'forex'},
  {sym:'USD/CAD',name:'Dollar CAD',cat:'forex'},{sym:'EUR/GBP',name:'Euro Pound',cat:'forex'},
  {sym:'USD/INR',name:'Dollar Rupee',cat:'forex'},{sym:'EUR/JPY',name:'Euro Yen',cat:'forex'},
  {sym:'XAU/USD',name:'Gold',cat:'commodity'},{sym:'XAG/USD',name:'Silver',cat:'commodity'},
  {sym:'OIL/USD',name:'Crude Oil (WTI)',cat:'commodity'},{sym:'NGAS',name:'Natural Gas',cat:'commodity'},
  {sym:'COPPER',name:'Copper',cat:'commodity'},{sym:'WHEAT',name:'Wheat',cat:'commodity'},
  {sym:'NIFTY 50',name:'Nifty 50 Index',cat:'indian'},{sym:'BANKNIFTY',name:'Bank Nifty',cat:'indian'},
  {sym:'SENSEX',name:'BSE Sensex',cat:'indian'},{sym:'RELIANCE',name:'Reliance Industries',cat:'indian'},
  {sym:'TCS',name:'Tata Consultancy',cat:'indian'},{sym:'HDFC',name:'HDFC Bank',cat:'indian'},
  {sym:'INFY',name:'Infosys',cat:'indian'},{sym:'ICICIBANK',name:'ICICI Bank',cat:'indian'},
  {sym:'WIPRO',name:'Wipro',cat:'indian'},{sym:'HCLTECH',name:'HCL Tech',cat:'indian'},
  {sym:'AAPL',name:'Apple',cat:'us'},{sym:'TSLA',name:'Tesla',cat:'us'},
  {sym:'NVDA',name:'NVIDIA',cat:'us'},{sym:'MSFT',name:'Microsoft',cat:'us'},
  {sym:'AMZN',name:'Amazon',cat:'us'},{sym:'GOOGL',name:'Alphabet',cat:'us'},
  {sym:'META',name:'Meta',cat:'us'},{sym:'NFLX',name:'Netflix',cat:'us'},
];

let chartDDOpen=false;
function openChartDD(){
  document.getElementById('chart-dd').classList.add('open');
  renderChartList(CHARTS);
  setTimeout(()=>document.getElementById('chart-search').focus(),80);
  chartDDOpen=true;
}
function filterCharts(val){
  const f=val?CHARTS.filter(c=>c.sym.toLowerCase().includes(val.toLowerCase())||c.name.toLowerCase().includes(val.toLowerCase())):CHARTS;
  renderChartList(f);
}
function filterByCat(cat,el){
  document.querySelectorAll('.chart-cat').forEach(c=>c.classList.remove('active'));
  el.classList.add('active');
  renderChartList(cat==='all'?CHARTS:CHARTS.filter(c=>c.cat===cat));
}
function renderChartList(list){
  const el=document.getElementById('chart-list');
  el.innerHTML='';
  if(!list.length){el.innerHTML='<div style="padding:14px;text-align:center;color:var(--muted);font-size:12px;">No results</div>';return;}
  list.forEach(c=>{
    const d=document.createElement('div');
    d.className='chart-item';
    d.innerHTML=`<span>${c.sym} <span style="color:var(--muted);font-size:10px;font-family:Outfit,sans-serif;">— ${c.name}</span></span><span class="chart-item-cat">${c.cat}</span>`;
    d.onclick=()=>selectChart(c);
    el.appendChild(d);
  });
}
function selectChart(c){
  state.selectedChart=c;
  document.getElementById('e-chart').value=c.sym;
  document.getElementById('chart-dd').classList.remove('open');
  chartDDOpen=false;
  const isIndian=c.cat==='indian';
  const isCrypto=c.cat==='crypto';
  document.getElementById('pfx-entry').textContent=isIndian?'₹':'$';
  document.getElementById('lot-asset-opt').textContent=c.sym.split('/')[0];
}
document.addEventListener('click',e=>{
  const w=document.querySelector('.chart-wrap');
  if(w&&!w.contains(e.target)&&chartDDOpen){
    document.getElementById('chart-dd').classList.remove('open');
    chartDDOpen=false;
  }
});

// ══════════════════════════════════════
// BROKER POPUP (D) — FULL API SYSTEM
// ══════════════════════════════════════
let allBrokerConfigs = [];
let selectedBrokerConfig = null;
let selectedAcctType = 'real';
let connectedFilter = 'all';

// Brokers that support Demo/Testnet API connection
const DEMO_SUPPORTED_BROKERS = [
  'binance','bybit','okx','delta exchange','kucoin','bitget',
  'gate.io','bingx','kraken','coinbase advanced','htx (huobi)',
  'bitfinex','crypto.com','mexc','exness','ic markets',
  'pepperstone','xm','deriv','metatrader 4','metatrader 5','hotforex'
];

function brokerSupportsDemo(name){
  if(!name) return false;
  const n = name.toLowerCase();
  return DEMO_SUPPORTED_BROKERS.some(b => n.includes(b) || b.includes(n));
}

function selectAcctType(type){
  selectedAcctType = type;
  document.getElementById('atype-real').classList.toggle('active', type==='real');
  document.getElementById('atype-demo').classList.toggle('active', type==='demo');
  const note = document.getElementById('atype-note');
  const lbl = document.getElementById('conn-label');
  const bName = selectedBrokerConfig ? selectedBrokerConfig.name : '';
  if(type==='demo'){
    note.style.display='block';
    note.className='atype-note demo-note';
    note.textContent='✅ Demo/Testnet — Simulated funds. No real money at risk.';
    if(lbl && !lbl.value.toLowerCase().includes('demo')) lbl.value = bName + ' Demo Account';
  } else {
    note.style.display='block';
    note.className='atype-note real-note';
    note.textContent='⚠️ Real Account — Actual funds. Use Read-Only API keys only.';
    if(lbl && lbl.value.toLowerCase().includes('demo')) lbl.value = bName + ' Account';
  }
}

function filterConnected(type){
  connectedFilter = type;
  ['all','real','demo'].forEach(t=>{
    const btn = document.getElementById('cf-'+t);
    if(btn) btn.classList.toggle('active', t===type);
  });
  renderConnected();
}

// Official broker logos — pulled live from each broker's own website favicon (their own brand asset, used purely for account identification). Bybit uses its verified official logo directly since its website favicon isn't representative.
const BROKER_DOMAINS = {
  'binance': 'binance.com',
  'bybit': {url:'https://commons.wikimedia.org/wiki/Special:FilePath/Bybit_Logo.svg'},
  'bitget': 'bitget.com',
  'coinbase': 'coinbase.com',
  'coinswitch': 'coinswitch.co',
  'delta': 'delta.exchange',
  'kucoin': 'kucoin.com',
  'okx': 'okx.com',
  'exness': 'exness.com',
  'hotforex': 'hfm.com',
  'ic markets': 'icmarkets.com',
  'pepperstone': 'pepperstone.com',
  'xm': 'xm.com',
  'metatrader 4': 'metatrader4.com',
  'metatrader 5': 'metatrader5.com',
  'zerodha': 'zerodha.com',
  'upstox': 'upstox.com',
  'angel one': 'angelone.in',
  'fyers': 'fyers.in',
  'dhan': 'dhan.co',
  'finvasia (shoonya)': 'shoonya.com',
  'alice blue': 'aliceblueonline.com',
  'pocketful': 'pocketful.in',
  'samco': 'samco.in',
  'kotak neo': 'kotakneo.com',
  'gate.io': 'gate.io',
  'kraken': 'kraken.com',
  'mexc': 'mexc.com',
  'bingx': 'bingx.com',
  'bitfinex': 'bitfinex.com',
  'htx (huobi)': 'htx.com',
  'crypto.com': 'crypto.com',
  'deriv': 'deriv.com',
  'coindcx': 'coindcx.com',
  'wazirx': 'wazirx.com',
  'groww': 'groww.in',
  'tradingview': 'tradingview.com',
  'manual entry': {url:'https://unpkg.com/lucide-static@latest/icons/square-pen.svg'}
};

function getBrokerLogoHTML(name, size){
  size = size || 28;
  if(!name) return null;
  const key = name.toLowerCase().replace(/\s*\(mt[45]\)\s*/g,'').trim();
  const fullKey = name.toLowerCase().trim();
  let raw = BROKER_DOMAINS[fullKey] || BROKER_DOMAINS[key];
  if(!raw){
    const foundKey = Object.keys(BROKER_DOMAINS).find(k => key.startsWith(k) || k.startsWith(key));
    if(foundKey) raw = BROKER_DOMAINS[foundKey];
  }
  if(!raw) return null;
  const imgUrl = (typeof raw === 'object' && raw.url) ? raw.url : `https://www.google.com/s2/favicons?sz=128&domain=${typeof raw === 'string' ? raw : raw.domain}`;
  const radius = Math.round(size*0.28)+'px';
  const imgSize = Math.round(size*0.62);
  return `<div style="width:${size}px;height:${size}px;border-radius:${radius};background:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,0.35);flex-shrink:0;overflow:hidden;"><img src="${imgUrl}" width="${imgSize}" height="${imgSize}" style="object-fit:contain;" onerror="this.parentElement.innerHTML='🏦';this.parentElement.style.fontSize='${Math.round(size*0.5)}px';"></div>`;
}

async function openBrokerPopup(){
  document.getElementById('broker-popup').classList.add('open');
  document.body.style.overflow='hidden';
  showBrokerMain();
  await loadBrokerConfigs();
  renderConnected();
}

function closeBrokerPopup(){
  document.getElementById('broker-popup').classList.remove('open');
  document.body.style.overflow='';
}
function closeBrokerOutside(e){if(e.target===document.getElementById('broker-popup'))closeBrokerPopup();}

// ── BROKER CENTRE (PAGE 1) ──
async function openBrokerCentre(){
  closeBrokerPopup();
  document.getElementById('broker-centre-overlay').classList.add('open');
  document.body.style.overflow='hidden';
  await loadBrokerConfigs();
  renderBcGrid();
  renderSyncStatus();
}
function closeBrokerCentre(){
  document.getElementById('broker-centre-overlay').classList.remove('open');
  document.getElementById('broker-add-overlay').classList.remove('open');
  document.body.style.overflow='';
}
function closeBrokerCentreOutside(e){if(e.target===document.getElementById('broker-centre-overlay'))closeBrokerCentre();}

function renderBcGrid(filterVal){
  const el = document.getElementById('bc-grid');
  if(!el) return;
  el.innerHTML='';
  let list = state.brokers;
  if(filterVal){
    const f = filterVal.toLowerCase();
    list = list.filter(b=>(b.account_label||b.name||'').toLowerCase().includes(f));
  }
  if(!list.length){
    el.innerHTML = '<div style="grid-column:1/-1;font-size:12px;color:var(--muted);padding:20px;text-align:center;">No brokers connected yet. Tap "Add New Broker" below.</div>';
    return;
  }
  list.forEach(b=>{
    const config = allBrokerConfigs.find(c=>c.id===b.broker_id) || {};
    const brokerName = config.name || b.name;
    const isSelected = state.activeBroker === b.id;
    const logoHTML = getBrokerLogoHTML(brokerName, 40) || `<div class="conn-logo">${config.emoji||b.emoji||'🏦'}</div>`;
    const d = document.createElement('div');
    d.className = 'broker-tile' + (isSelected?' selected':'');
    d.onclick = ()=>selectBroker(b);
    d.innerHTML = `
      ${logoHTML}
      <div class="bt-name">${b.account_label||b.name}</div>
      <div class="bt-type">${config.type||b.type||'Manual'}</div>
    `;
    el.appendChild(d);
  });
}
function filterBcGrid(val){ renderBcGrid(val); }

function renderSyncStatus(){
  const el = document.getElementById('bc-sync-list');
  if(!el) return;
  el.innerHTML='';
  if(!state.brokers.length){
    el.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:10px;text-align:center;">No accounts yet.</div>';
    return;
  }
  state.brokers.forEach(b=>{
    const lastSync = b.last_sync ? new Date(b.last_sync).toLocaleString() : (b.is_manual?'Manual entry':'Never');
    const statusColor = b.sync_status==='success'?'var(--green)':b.sync_status==='error'?'var(--red)':'var(--gold)';
    const row = document.createElement('div');
    row.className = 'bc-sync-item';
    row.innerHTML = `
      <span class="bc-sync-dot" style="background:${statusColor};box-shadow:0 0 5px ${statusColor};"></span>
      <div>
        <div class="bc-sync-nm">${b.account_label||b.name}</div>
        <div class="bc-sync-sub">Last Synced: ${lastSync}</div>
      </div>
    `;
    el.appendChild(row);
  });
}

// ── ADD NEW BROKER (PAGE 2) ──
function openBrokerAddPage(){
  document.getElementById('broker-centre-overlay').classList.remove('open');
  document.getElementById('broker-add-overlay').classList.add('open');
  loadBrokerConfigs();
}
function showBrokerCentreFromAdd(){
  document.getElementById('broker-add-overlay').classList.remove('open');
  document.getElementById('broker-centre-overlay').classList.add('open');
}
function closeBrokerAddPage(){
  document.getElementById('broker-add-overlay').classList.remove('open');
  document.body.style.overflow='';
}
function closeBrokerAddOutside(e){if(e.target===document.getElementById('broker-add-overlay'))closeBrokerAddPage();}

// ── CONNECT / MANUAL FORM (opens over Page 2) ──
function closeBrokerFormPopup(){
  document.getElementById('broker-form-popup').classList.remove('open');
  const addOpen = document.getElementById('broker-add-overlay').classList.contains('open');
  const centreOpen = document.getElementById('broker-centre-overlay').classList.contains('open');
  if(!addOpen && !centreOpen) document.body.style.overflow='';
}
function closeBrokerFormOutside(e){if(e.target===document.getElementById('broker-form-popup'))closeBrokerFormPopup();}
function showBrokerFormBack(){ closeBrokerFormPopup(); }

// Block page scroll when broker popup is open
(function(){
  const overlay = document.getElementById('broker-popup');
  if(!overlay) return;
  overlay.addEventListener('touchmove', function(e){
    const panel = overlay.querySelector('.popup-panel');
    if(panel && panel.contains(e.target)){
      e.stopPropagation();
    } else {
      e.preventDefault();
    }
  }, {passive:false});
  overlay.addEventListener('wheel', function(e){
    const panel = overlay.querySelector('.popup-panel');
    if(panel && panel.contains(e.target)){
      e.stopPropagation();
    } else {
      e.preventDefault();
    }
  }, {passive:false});
})();

function showBrokerMain(){
  document.getElementById('broker-main-view').style.display='flex';
  document.getElementById('broker-connect-view').style.display='none';
  document.getElementById('broker-manual-view').style.display='none';
}

function showManualForm(){
  document.getElementById('broker-form-popup').classList.add('open');
  document.getElementById('broker-connect-view').style.display='none';
  document.getElementById('broker-manual-view').style.display='block';
  document.body.style.overflow='hidden';
}

function showConnectForm(config){
  selectedBrokerConfig = config;
  document.getElementById('broker-form-popup').classList.add('open');
  document.getElementById('broker-connect-view').style.display='block';
  document.getElementById('broker-manual-view').style.display='none';
  document.body.style.overflow='hidden';

  // Fill broker info
  document.getElementById('connect-broker-title').textContent = 'Connect ' + config.name;
  const emojiEl = document.getElementById('connect-broker-emoji');
  const customLogo = getBrokerLogoHTML(config.name, 44);
  if(customLogo){ emojiEl.innerHTML = customLogo; } else { emojiEl.textContent = config.emoji || '🏦'; }
  document.getElementById('connect-broker-name').textContent = config.name;
  document.getElementById('connect-broker-type').textContent = config.type;
  document.getElementById('connect-instructions').textContent = config.instructions || 'Get API key from broker website.';
  document.getElementById('connect-instructions-title').textContent = config.requires_mt_login ? 'How to Connect' : 'How to get API Key';

  const link = document.getElementById('connect-broker-link');
  if(config.website_url){ link.href=config.website_url; link.style.display='block'; }
  else link.style.display='none';

  // Show/hide fields
  document.getElementById('field-api-key').style.display = config.requires_api_key ? 'flex' : 'none';
  document.getElementById('field-api-secret').style.display = config.requires_secret ? 'flex' : 'none';
  document.getElementById('field-passphrase').style.display = config.requires_passphrase ? 'flex' : 'none';
  document.getElementById('field-mt-server').style.display = config.requires_mt_login ? 'flex' : 'none';
  document.getElementById('field-mt-login').style.display = config.requires_mt_login ? 'flex' : 'none';
  document.getElementById('field-mt-password').style.display = config.requires_mt_login ? 'flex' : 'none';

  // Clear fields
  document.getElementById('conn-label').value = config.name + ' Account';
  document.getElementById('conn-api-key').value = '';
  document.getElementById('conn-api-secret').value = '';
  document.getElementById('conn-passphrase').value = '';
  document.getElementById('conn-mt-server').value = '';
  document.getElementById('conn-mt-login').value = '';
  document.getElementById('conn-mt-password').value = '';
  document.getElementById('conn-error').style.display = 'none';
  // Reset account type to Real
  selectedAcctType = 'real';
  const atReal = document.getElementById('atype-real');
  const atDemo = document.getElementById('atype-demo');
  const atNote = document.getElementById('atype-note');
  if(atReal) atReal.classList.add('active');
  if(atDemo) atDemo.classList.remove('active');
  if(atNote){ atNote.style.display='none'; atNote.textContent=''; }
  // Enable or disable Demo button based on broker support
  if(atDemo){
    if(brokerSupportsDemo(config.name)){
      atDemo.classList.remove('disabled-btn');
      atDemo.title='';
    } else {
      atDemo.classList.add('disabled-btn');
      atDemo.title='This broker does not support Demo API connection';
    }
  }
}

async function loadBrokerConfigs(){
  if(allBrokerConfigs.length > 0){ renderAvailable(allBrokerConfigs); return; }
  const { data, error } = await db.from('broker_configs').select('*').eq('is_active', true).eq('is_manual', false).order('market').order('name');
  if(error){ return; }
  allBrokerConfigs = data || [];
  renderAvailable(allBrokerConfigs);
}

function renderConnected(){
  const list = document.getElementById('conn-list');
  list.innerHTML = '';
  if(!state.brokers.length){
    list.innerHTML='<div style="font-size:12px;color:var(--muted);padding:10px;text-align:center;">No accounts connected yet. Add one below.</div>';
    return;
  }
  const filteredForDisplay = connectedFilter==='all' ? state.brokers : state.brokers.filter(b=>(b.account_type||'real')===connectedFilter);
  if(!filteredForDisplay.length){
    list.innerHTML=`<div style="font-size:12px;color:var(--muted);padding:10px;text-align:center;">No ${connectedFilter} accounts connected.</div>`;
    return;
  }
  filteredForDisplay.forEach(b=>{
    const config = allBrokerConfigs.find(c=>c.id===b.broker_id) || {};
    const isSelected = state.activeBroker === b.id;
    const lastSync = b.last_sync ? new Date(b.last_sync).toLocaleDateString() : 'Never';
    const statusColor = b.sync_status==='success'?'var(--green)':b.sync_status==='error'?'var(--red)':'var(--gold)';
    const d = document.createElement('div');
    d.className = 'conn-item' + (isSelected?' selected':'');
    d.onclick = ()=>selectBroker(b);
    const brokerName = config.name || b.name;
    const logoHTML = getBrokerLogoHTML(brokerName, 44) || `<div class="conn-logo">${config.emoji||b.emoji||'🏦'}</div>`;
    d.innerHTML = `
      ${logoHTML}
      <div class="conn-info">
        <div class="conn-name" style="display:flex;align-items:center;gap:6px;">${b.account_label||b.name}<span class="acct-badge ${b.account_type||'real'}">${(b.account_type||'real').toUpperCase()}</span></div>
        <div class="conn-type">${config.type||b.type||'Manual'} · Synced: ${lastSync}</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        ${!b.is_manual?`<button onclick="event.stopPropagation();syncBroker('${b.id}','${b.broker_id}')" style="background:var(--gold-dim);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:10px;color:var(--gold);cursor:pointer;">🔄 Sync</button>`:''}
        <button class="icon-btn-del" onclick="event.stopPropagation();deleteBroker('${b.id}','${b.account_label||b.name}')" title="Delete"><img src="https://unpkg.com/lucide-static@latest/icons/trash-2.svg" alt="Delete"></button>
        <div class="conn-status ${b.is_manual?'conn-status-m':''}" style="background:${statusColor};border:2px solid var(--bg3);box-shadow:0 0 4px ${statusColor};width:8px;height:8px;"></div>
      </div>
    `;
    list.appendChild(d);
  });
}

function renderAvailable(list){
  const el = document.getElementById('avail-grid');
  el.innerHTML = '';
  const connectedIds = state.brokers.map(b=>b.broker_id).filter(Boolean);
  list.forEach(b=>{
    const d = document.createElement('div');
    d.className = 'avail-broker';
    const isConnected = connectedIds.includes(b.id);
    d.onclick = ()=>showConnectForm(b);
    const logoHTML = getBrokerLogoHTML(b.name, 40) || `<span class="avail-emoji">${b.emoji||'🏦'}</span>`;
    d.innerHTML = `
      ${logoHTML}
      <div>
        <div class="avail-nm">${b.name}</div>
        <div class="avail-type">${b.type}</div>
      </div>
      ${isConnected?'<span style="font-size:10px;color:var(--green);margin-left:auto;">✓</span>':''}
    `;
    el.appendChild(d);
  });
}

function filterBrokers(val){
  const f = val ? allBrokerConfigs.filter(b=>b.name.toLowerCase().includes(val.toLowerCase())||b.type.toLowerCase().includes(val.toLowerCase())) : allBrokerConfigs;
  renderAvailable(f);
}

async function submitBrokerConnection(){
  if(!state.user||!selectedBrokerConfig) return;
  const label = document.getElementById('conn-label').value.trim();
  const apiKey = document.getElementById('conn-api-key').value.trim();
  const apiSecret = document.getElementById('conn-api-secret').value.trim();
  const passphrase = document.getElementById('conn-passphrase').value.trim();
  const mtServer = document.getElementById('conn-mt-server').value.trim();
  const mtLogin = document.getElementById('conn-mt-login').value.trim();
  const mtPassword = document.getElementById('conn-mt-password').value.trim();
  const errEl = document.getElementById('conn-error');

  if(!label){ errEl.textContent='Please enter an account label.'; errEl.style.display='block'; return; }
  if(selectedBrokerConfig.requires_api_key && !apiKey){ errEl.textContent='API Key is required.'; errEl.style.display='block'; return; }
  if(selectedBrokerConfig.requires_secret && !apiSecret){ errEl.textContent='API Secret is required.'; errEl.style.display='block'; return; }
  if(selectedBrokerConfig.requires_passphrase && !passphrase){ errEl.textContent='Passphrase is required.'; errEl.style.display='block'; return; }
  if(selectedBrokerConfig.requires_mt_login && !mtServer){ errEl.textContent='Server is required.'; errEl.style.display='block'; return; }
  if(selectedBrokerConfig.requires_mt_login && !mtLogin){ errEl.textContent='Login (Account Number) is required.'; errEl.style.display='block'; return; }
  if(selectedBrokerConfig.requires_mt_login && !mtPassword){ errEl.textContent='Investor Password is required.'; errEl.style.display='block'; return; }

  errEl.style.display='none';
  const btn = document.getElementById('conn-submit-btn');
  btn.textContent='Connecting...'; btn.disabled=true;

  const { data: encData, error: encError } = await db.functions.invoke('encrypt-keys', {
    body: {
      api_key: apiKey || null,
      api_secret: apiSecret || null,
      api_passphrase: passphrase || null,
      mt_investor_password: mtPassword || null
    }
  });

  if(encError){
    btn.textContent='Connect Account'; btn.disabled=false;
    errEl.textContent='Encryption error: '+encError.message; errEl.style.display='block'; return;
  }

  const { data, error } = await db.from('user_broker_connections').insert([{
    user_id: state.user.id,
    broker_id: selectedBrokerConfig.id,
    account_label: label,
    account_type: selectedAcctType,
    api_key_encrypted: encData.api_key_encrypted,
    api_secret_encrypted: encData.api_secret_encrypted,
    api_passphrase_encrypted: encData.api_passphrase_encrypted,
    mt_server: mtServer || null,
    mt_login: mtLogin || null,
    mt_investor_password_encrypted: encData.mt_investor_password_encrypted,
    sync_status: 'pending',
    is_active: true
  }]).select().single();

  btn.textContent='Connect Account'; btn.disabled=false;

  if(error){ errEl.textContent='Error: '+error.message; errEl.style.display='block'; return; }

  // Add to state with config info
  const brokerWithConfig = {
    ...data,
    name: selectedBrokerConfig.name,
    emoji: selectedBrokerConfig.emoji,
    type: selectedBrokerConfig.type,
    is_manual: false
  };
  state.brokers.push(brokerWithConfig);
  selectBroker(brokerWithConfig);
  showToast(selectedBrokerConfig.name+' connected!','success');
  showBrokerMain();
  renderConnected();
  renderAvailable(allBrokerConfigs);
}

async function submitManualBroker(){
  if(!state.user) return;
  const name = document.getElementById('manual-broker-name').value.trim();
  const market = document.getElementById('manual-broker-market').value;
  const label = document.getElementById('manual-account-label').value.trim()||name;
  if(!name){ showToast('Please enter broker name','error'); return; }

  const { data, error } = await db.from('user_broker_connections').insert([{
    user_id: state.user.id,
    broker_id: 'manual',
    account_label: label,
    is_active: true,
    sync_status: 'manual',
    extra_data: { broker_name: name, market }
  }]).select().single();

  if(error){ showToast('Error: '+error.message,'error'); return; }

  const brokerData = { ...data, name: name, emoji: '📝', type: 'Manual - '+market, is_manual: true };
  state.brokers.push(brokerData);
  selectBroker(brokerData);
  showToast(name+' account created!','success');
  showBrokerMain();
  renderConnected();
}

function selectBroker(b){
  state.activeBroker = b.id;
  const name = b.account_label || b.name;
  document.getElementById('active-broker-nm').textContent = name;
  closeBrokerPopup();
  closeBrokerCentre();
  closeBrokerAddPage();
  document.body.style.overflow='';
  refreshHome();
  showToast(name+' selected!','success');
}

async function syncBroker(connectionId, brokerId){
  showToast('Syncing trades...','success');
  try {
    const { data, error } = await db.functions.invoke('sync-'+brokerId, {
      body: { connection_id: connectionId }
    });
    if(error) throw error;
    const synced = data?.trades_synced ?? 0;
    showToast('Sync complete! '+synced+' trade'+(synced===1?'':'s')+' imported.','success');
    // Reload data
    await loadDays();
    renderConnected();
    refreshHome();
  } catch(e) {
    // error suppressed
    showToast('Sync failed. Please try again.','error');
  }
}

async function deleteBroker(connectionId, name){
  const broker = state.brokers.find(b=>b.id===connectionId);
  const isManual = !!broker?.is_manual;
  if(!confirm('Delete "'+name+'"?\n\nYeh broker hata dega.\nKya aap sure hain?')) return;

  let deleteTrades = true;
  if(isManual){
    deleteTrades = confirm('Iske manual trades bhi delete karne hain?\n\nOK = trades bhi delete honge\nCancel = trades safe rakhe jayenge');
  }

  if(deleteTrades){
    const { data: dayRows } = await db.from('trading_days').select('id').eq('connection_id', connectionId);
    const dayIds = (dayRows||[]).map(d=>d.id);
    if(dayIds.length>0){
      await db.from('trades').delete().in('day_id', dayIds);
      await db.from('trading_days').delete().in('id', dayIds);
    }
    state.days = state.days.filter(d=>d.connection_id!==connectionId);
  }

  const { error } = await db.from('user_broker_connections').delete().eq('id', connectionId);
  if(error){ showToast('Error: '+error.message,'error'); return; }
  state.brokers = state.brokers.filter(b=>b.id!==connectionId);
  if(state.activeBroker===connectionId){
    state.activeBroker = state.brokers[0]?.id || null;
    const nm = state.brokers[0]?.account_label || state.brokers[0]?.name || 'No Broker';
    document.getElementById('active-broker-nm').textContent = nm;
  }
  renderConnected();
  renderAvailable(allBrokerConfigs);
  refreshHome();
  showToast(name+' removed.','success');
}
// ══════════════════════════════════════
function setStatsFilter(f,btn){
  state.statsFilter=f;
  document.querySelectorAll('.sf-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderStats();
  renderCapitalGrowth();
}

function getFilteredTrades(){
  const now=new Date();
  const all=state.days.flatMap(d=>d.trades.map(t=>({...t,date:d.date})));
  if(state.statsFilter==='all')return all;
  let from=new Date();
  if(state.statsFilter==='week'){from=new Date(now);from.setDate(now.getDate()-7);}
  else if(state.statsFilter==='month'){from=new Date(now.getFullYear(),now.getMonth(),1);}
  else if(state.statsFilter==='30'){from=new Date(now);from.setDate(now.getDate()-30);}
  else if(state.statsFilter==='90'){from=new Date(now);from.setDate(now.getDate()-90);}
  return all.filter(t=>new Date(t.date+'T00:00:00')>=from);
}

function renderStats(){
  const trades=getFilteredTrades();
  const total=trades.length;
  const profits=trades.filter(t=>t.conclusion==='target').length;
  const losses=trades.filter(t=>t.conclusion==='loss').length;
  const bes=trades.filter(t=>t.conclusion==='breakeven').length;
  const winRate=total>0?Math.round((profits/total)*100):0;
  document.getElementById('st-winrate').textContent=winRate+'%';
  document.getElementById('st-total').textContent=total;
  document.getElementById('st-wins').textContent=profits;
  document.getElementById('st-losses').textContent=losses;
  const rrrs=trades.filter(t=>t.rrr).map(t=>{
    const parts=t.rrr.split(':');
    return parts.length===2?parseFloat(parts[1])/parseFloat(parts[0]):0;
  }).filter(r=>r>0);
  const avgRRR=rrrs.length>0?(rrrs.reduce((a,b)=>a+b,0)/rrrs.length).toFixed(2):'—';
  document.getElementById('st-rrr').textContent=avgRRR;

  // Quality bars
  if(total>0){
    document.getElementById('bar-profit').style.width=(profits/total*100)+'%';
    document.getElementById('bar-loss').style.width=(losses/total*100)+'%';
    document.getElementById('bar-be').style.width=(bes/total*100)+'%';
  }
  document.getElementById('qv-profit').textContent=profits;
  document.getElementById('qv-loss').textContent=losses;
  document.getElementById('qv-be').textContent=bes;

  // Session analysis
  const sessions=['London','New York','Asian','London-NY Overlap'];
  const sessHtml=sessions.map(s=>{
    const st=trades.filter(t=>t.session===s);
    const sw=st.filter(t=>t.conclusion==='target').length;
    const wr=st.length>0?Math.round(sw/st.length*100):0;
    return `<div class="analysis-row"><span class="ar-label">${s}</span><div class="ar-bar-wrap"><div class="ar-bar" style="width:${wr}%;background:${wr>50?'var(--green)':'var(--red)'};"></div></div><span class="ar-val" style="color:${wr>50?'var(--green)':'var(--red)'};">${st.length>0?wr+'%':'—'}</span></div>`;
  }).join('');
  document.getElementById('session-analysis').innerHTML=sessHtml||'<div style="color:var(--muted);font-size:13px;">No data yet.</div>';

  // Day analysis
  const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dayHtml=days.map((dn,di)=>{
    const dt=trades.filter(t=>new Date(t.date+'T00:00:00').getDay()===di);
    const dw=dt.filter(t=>t.conclusion==='target').length;
    const wr=dt.length>0?Math.round(dw/dt.length*100):0;
    return `<div class="analysis-row"><span class="ar-label">${dn}</span><div class="ar-bar-wrap"><div class="ar-bar" style="width:${wr}%;background:${wr>50?'var(--green)':'var(--red)'};"></div></div><span class="ar-val" style="color:${wr>50?'var(--green)':'var(--red)'};">${dt.length>0?wr+'%':'—'}</span></div>`;
  }).join('');
  document.getElementById('day-analysis').innerHTML=dayHtml;

  // Streak
  const recent=trades.slice(-10);
  if(recent.length===0){document.getElementById('streak-section').innerHTML='<div style="color:var(--muted);font-size:13px;">No trades yet.</div>';return;}
  const dots=recent.map(t=>`<div class="s-dot ${t.conclusion==='target'?'s-p':'s-l'}">${t.conclusion==='target'?'✅':'❌'}</div>`).join('');
  let streak=0,cur=recent[recent.length-1]?.conclusion;
  for(let i=recent.length-1;i>=0;i--){if(recent[i].conclusion===cur)streak++;else break;}
  document.getElementById('streak-section').innerHTML=`<div class="streak-dots">${dots}</div><div style="font-size:11px;color:var(--muted);margin-top:10px;">Current streak: <span style="color:${cur==='target'?'var(--green)':'var(--red)'};font-weight:600;">+${streak} ${cur==='target'?'Profit':'Loss'}</span></div>`;

  // Weak points
  const wps=[];
  days.forEach((dn,di)=>{
    const dt=trades.filter(t=>new Date(t.date+'T00:00:00').getDay()===di);
    const dw=dt.filter(t=>t.conclusion==='target').length;
    const wr=dt.length>0?Math.round(dw/dt.length*100):null;
    if(wr!==null&&wr<40&&dt.length>=3)wps.push(`Your <strong>${dn}</strong> win rate is only ${wr}% — consider avoiding trades on ${dn}.`);
  });
  let worstLossDay=null, worstLossDayCount=-1;
  days.forEach((dn,di)=>{
    const dt=trades.filter(t=>new Date(t.date+'T00:00:00').getDay()===di);
    const dl=dt.filter(t=>t.conclusion==='loss').length;
    if(dl>worstLossDayCount){worstLossDayCount=dl;worstLossDay=dn;}
  });
  if(worstLossDayCount>=2)wps.push(`<strong>${worstLossDay}</strong> has your highest number of losses (${worstLossDayCount} loss${worstLossDayCount>1?'es':''}) across the selected period.`);
  sessions.forEach(s=>{
    const st=trades.filter(t=>t.session===s);
    const sw=st.filter(t=>t.conclusion==='target').length;
    const wr=st.length>0?Math.round(sw/st.length*100):null;
    if(wr!==null&&wr<40&&st.length>=3)wps.push(`Your <strong>${s}</strong> session win rate is ${wr}% — consider reducing ${s} trades.`);
  });
  const stratMap={};
  trades.forEach(t=>{
    const s=(t.strategy||'').trim();
    if(!s)return;
    if(!stratMap[s])stratMap[s]={total:0,wins:0};
    stratMap[s].total++;
    if(t.conclusion==='target')stratMap[s].wins++;
  });
  let worstStrat=null, worstStratWr=101;
  Object.keys(stratMap).forEach(s=>{
    const m=stratMap[s];
    if(m.total>=3){
      const wr=Math.round(m.wins/m.total*100);
      if(wr<worstStratWr){worstStratWr=wr;worstStrat=s;}
    }
  });
  if(worstStrat&&worstStratWr<50)wps.push(`Your strategy "<strong>${worstStrat.substring(0,40)}${worstStrat.length>40?'...':''}</strong>" has only a ${worstStratWr}% win rate (${stratMap[worstStrat].wins}W / ${stratMap[worstStrat].total-stratMap[worstStrat].wins}L of ${stratMap[worstStrat].total} trades).`);

  const symMap={};
  trades.forEach(t=>{
    const sym=(t.chart_name||'').trim();
    if(!sym)return;
    if(!symMap[sym])symMap[sym]={total:0,wins:0};
    symMap[sym].total++;
    if(t.conclusion==='target')symMap[sym].wins++;
  });
  let worstSym=null, worstSymWr=101;
  Object.keys(symMap).forEach(sym=>{
    const m=symMap[sym];
    if(m.total>=3){
      const wr=Math.round(m.wins/m.total*100);
      if(wr<worstSymWr){worstSymWr=wr;worstSym=sym;}
    }
  });
  if(worstSym&&worstSymWr<50)wps.push(`You perform worst on <strong>${worstSym}</strong> — only ${worstSymWr}% win rate (${symMap[worstSym].wins}W / ${symMap[worstSym].total-symMap[worstSym].wins}L of ${symMap[worstSym].total} trades).`);

  const PSYCH_KEYWORDS=['fomo','revenge','fear','greed','overconfiden','impulsive','anxious','panic','hesitat'];
  const psychCounts={};
  trades.forEach(t=>{
    const p=(t.psychology||'').toLowerCase();
    if(!p)return;
    PSYCH_KEYWORDS.forEach(kw=>{
      if(p.includes(kw)){
        psychCounts[kw]=(psychCounts[kw]||0)+1;
      }
    });
  });
  let topPsych=null, topPsychCount=0;
  Object.keys(psychCounts).forEach(kw=>{
    if(psychCounts[kw]>topPsychCount){topPsychCount=psychCounts[kw];topPsych=kw;}
  });
  if(topPsych&&topPsychCount>=2)wps.push(`You mentioned "<strong>${topPsych}</strong>" in your psychology notes on ${topPsychCount} trades — this pattern may be affecting your results.`);

  if(losses>profits&&total>=5)wps.push(`More <strong>Loss</strong> trades than Profit. Focus on risk management and trade quality over quantity.`);
  const wpEl=document.getElementById('weak-points');
  if(wps.length===0){wpEl.innerHTML='<div style="color:var(--muted);font-size:13px;">'+( total<5?'Trade more to unlock personalized weak point analysis.':'No significant weak points found. Keep going!')+'</div>';}
  else{wpEl.innerHTML=wps.map(w=>`<div class="weak-item"><span class="weak-icon">⚠️</span><div class="weak-text">${w}</div></div>`).join('');}

  // Strong points
  const sps=[];
  let bestDay=null, bestDayWr=-1, bestDayCount=0;
  days.forEach((dn,di)=>{
    const dt=trades.filter(t=>new Date(t.date+'T00:00:00').getDay()===di);
    const dw=dt.filter(t=>t.conclusion==='target').length;
    const wr=dt.length>0?Math.round(dw/dt.length*100):-1;
    if(dt.length>=3&&wr>bestDayWr){bestDayWr=wr;bestDay=dn;bestDayCount=dt.length;}
  });
  if(bestDay&&bestDayWr>=60)sps.push(`<strong>${bestDay}</strong> is your best day — ${bestDayWr}% win rate across ${bestDayCount} trades.`);

  let bestSession=null, bestSessionWr=-1, bestSessionCount=0;
  sessions.forEach(s=>{
    const st=trades.filter(t=>t.session===s);
    const sw=st.filter(t=>t.conclusion==='target').length;
    const wr=st.length>0?Math.round(sw/st.length*100):-1;
    if(st.length>=3&&wr>bestSessionWr){bestSessionWr=wr;bestSession=s;bestSessionCount=st.length;}
  });
  if(bestSession&&bestSessionWr>=60)sps.push(`Your <strong>${bestSession}</strong> session performs best — ${bestSessionWr}% win rate across ${bestSessionCount} trades.`);

  let bestStrat=null, bestStratWr=-1;
  Object.keys(stratMap).forEach(s=>{
    const m=stratMap[s];
    if(m.total>=3){
      const wr=Math.round(m.wins/m.total*100);
      if(wr>bestStratWr){bestStratWr=wr;bestStrat=s;}
    }
  });
  if(bestStrat&&bestStratWr>=60)sps.push(`Your strategy "<strong>${bestStrat.substring(0,40)}${bestStrat.length>40?'...':''}</strong>" is strong — ${bestStratWr}% win rate (${stratMap[bestStrat].wins}W / ${stratMap[bestStrat].total-stratMap[bestStrat].wins}L of ${stratMap[bestStrat].total} trades).`);

  let bestSym=null, bestSymWr=-1;
  Object.keys(symMap).forEach(sym=>{
    const m=symMap[sym];
    if(m.total>=3){
      const wr=Math.round(m.wins/m.total*100);
      if(wr>bestSymWr){bestSymWr=wr;bestSym=sym;}
    }
  });
  if(bestSym&&bestSymWr>=60)sps.push(`You perform best on <strong>${bestSym}</strong> — ${bestSymWr}% win rate (${symMap[bestSym].wins}W / ${symMap[bestSym].total-symMap[bestSym].wins}L of ${symMap[bestSym].total} trades).`);

  const POSITIVE_PSYCH_KEYWORDS=['confident','disciplined','calm','patient','focused','controlled','followed plan','sticking to plan'];
  const posPsychCounts={};
  trades.forEach(t=>{
    const p=(t.psychology||'').toLowerCase();
    if(!p)return;
    POSITIVE_PSYCH_KEYWORDS.forEach(kw=>{
      if(p.includes(kw)){
        posPsychCounts[kw]=(posPsychCounts[kw]||0)+1;
      }
    });
  });
  let topPosPsych=null, topPosPsychCount=0;
  Object.keys(posPsychCounts).forEach(kw=>{
    if(posPsychCounts[kw]>topPosPsychCount){topPosPsychCount=posPsychCounts[kw];topPosPsych=kw;}
  });
  if(topPosPsych&&topPosPsychCount>=2)sps.push(`You mentioned "<strong>${topPosPsych}</strong>" in your psychology notes on ${topPosPsychCount} trades — this mindset is working in your favor.`);

  if(profits>losses&&total>=5)sps.push(`Overall you're winning more than losing — ${profits} profitable trades vs ${losses} losses. Keep it up.`);

  const spEl=document.getElementById('strong-points');
  if(spEl){
    if(sps.length===0){spEl.innerHTML='<div style="color:var(--muted);font-size:13px;">'+( total<5?'Trade more to unlock personalized strength analysis.':'Keep trading to build up clear strength patterns.')+'</div>';} 
    else{spEl.innerHTML=sps.map(w=>`<div class="strong-item"><span class="strong-icon">✅</span><div class="strong-text">${w}</div></div>`).join('');}
  }

  // Calendar
  // Strategy Performance
  renderStrategyStats(trades);

  // Calendar
  renderCalendar();
}

function renderCapitalGrowth(){
  const wrap=document.getElementById('capital-growth-chart-wrap');
  const card=document.getElementById('capital-growth-card');
  if(!wrap||!card)return;
  const trades=getFilteredTrades();
  const points=trades
    .filter(t=>t.updated_capital!=null && t.updated_capital!=='' && !isNaN(parseFloat(t.updated_capital)))
    .map(t=>({date:t.date,val:parseFloat(t.updated_capital)}))
    .sort((a,b)=>new Date(a.date+'T00:00:00')-new Date(b.date+'T00:00:00'));
  if(points.length<2){
    wrap.innerHTML='<div class="capital-growth-empty">Not enough capital data yet for this period. Fill "Updated Capital" in your trade entries to see growth here.</div>';
    return;
  }
  const vals=points.map(p=>p.val);
  const minV=Math.min(...vals), maxV=Math.max(...vals);
  const range=(maxV-minV)||1;
  const w=900,h=220,pad=10;
  const stepX=(w-pad*2)/(points.length-1);
  const coords=points.map((p,i)=>{
    const x=pad+i*stepX;
    const y=pad+(h-pad*2)*(1-((p.val-minV)/range));
    return [x,y];
  });
  const pathD=coords.map((c,i)=>(i===0?'M':'L')+c[0].toFixed(2)+','+c[1].toFixed(2)).join(' ');
  const areaD=pathD+' L'+coords[coords.length-1][0].toFixed(2)+','+(h-pad)+' L'+coords[0][0].toFixed(2)+','+(h-pad)+' Z';
  const first=vals[0], last=vals[vals.length-1];
  const change=last-first;
  const changePct=first!==0?((change/first)*100):0;
  const isUp=change>=0;
  wrap.innerHTML=`
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:220px;display:block;">
      <defs>
        <linearGradient id="cgGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--gold)" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="var(--gold)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <path d="${areaD}" fill="url(#cgGrad)" stroke="none"/>
      <path d="${pathD}" fill="none" stroke="var(--gold)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>
    <div class="capital-growth-meta">
      <div class="cg-meta-item">Start<span class="cg-meta-val">₹${first.toLocaleString('en-IN')}</span></div>
      <div class="cg-meta-item">Current<span class="cg-meta-val">₹${last.toLocaleString('en-IN')}</span></div>
      <div class="cg-meta-item">Change<span class="cg-meta-val ${isUp?'cg-up':'cg-down'}">${isUp?'+':''}₹${change.toLocaleString('en-IN')} (${isUp?'+':''}${changePct.toFixed(1)}%)</span></div>
    </div>`;
}

function changeCalMonth(dir){
  state.calMonth+=dir;
  if(state.calMonth>11){state.calMonth=0;state.calYear++;}
  if(state.calMonth<0){state.calMonth=11;state.calYear--;}
  renderCalendar();
}

function renderCalendar(){
  const M=state.calMonth,Y=state.calYear;
  const label=new Date(Y,M,1).toLocaleString('default',{month:'long',year:'numeric'});
  document.getElementById('cal-month-label').textContent=label;
  const grid=document.getElementById('cal-grid');
  grid.innerHTML='';
  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d=>{
    const h=document.createElement('div');
    h.className='cal-day-hdr';h.textContent=d;
    grid.appendChild(h);
  });
  const first=new Date(Y,M,1).getDay();
  for(let i=0;i<first;i++){
    const e=document.createElement('div');
    e.className='cal-day cal-empty';
    grid.appendChild(e);
  }
  const days=new Date(Y,M+1,0).getDate();
  for(let d=1;d<=days;d++){
    const dateStr=`${Y}-${String(M+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dayData=state.days.find(day=>day.date===dateStr);
    const el=document.createElement('div');
    if(!dayData||!dayData.trades.length){el.className='cal-day cal-no-trade';el.textContent=d;}
    else{
      const p=dayData.trades.filter(t=>t.conclusion==='target').length;
      const l=dayData.trades.filter(t=>t.conclusion==='loss').length;
      el.className='cal-day '+(p>l?'cal-profit':'cal-loss');
      el.textContent=d;
      el.title=`${dayData.trades.length} trades — ${p} profit, ${l} loss`;
      el.onclick=()=>{state.currentDayId=dayData.id;showSection('trade-list');}
    }
    grid.appendChild(el);
  }
}

// ══════════════════════════════════════
// BOT
// ══════════════════════════════════════
const BOT_ANSWERS=[
  {k:['add trade','new trade','how to add'],a:'To add a trade, click the "+" button in the bottom navigation or click "Add Trade" button on any day. Fill in the entry details and save.'},
  {k:['broker','connect','exchange'],a:'Go to the top broker selector and click it. A popup will show all available brokers. Click any broker to add it, or create a manual account for brokers not listed.'},
  {k:['stats','statistics','performance'],a:'Click "Stats" in the bottom navigation or sidebar. You will see your win rate, session analysis, day analysis, streak, and personalized weak points.'},
  {k:['password','reset password'],a:'Go to Profile > Change Password. Enter your new password and confirm it, then click Reset Password.'},
  {k:['theme','dark','light','color'],a:'Go to Settings from the sidebar or Profile menu. You can switch between Dark and Light theme and choose from 5 accent colors.'},
  {k:['profit','loss','breakeven'],a:'When saving a trade, select Trade Conclusion — Target (Profit), Breakeven, or Loss. The day card on the home page will show the overall result.'},
  {k:['psychology','mindset','emotion'],a:'In the Trade Entry form, there is a Psychology & Mindset section. Write your emotional state, confidence level, or any feelings before the trade.'},
  {k:['strategy','setup'],a:'In Trade Entry, use the Strategy & Setups field to note your trading strategy, like "BOS on 15m, FVG fill, London session entry."'},
  {k:['chart','symbol','asset'],a:'In Trade Entry, click the Chart/Asset Name field. A search popup will appear with Crypto, Forex, Commodities, Indian Stocks, and US Stocks.'},
  {k:['session'],a:'Sessions available: London, New York, Asian, London-NY Overlap, Pre-Market, Post-Market. Stats page shows your performance by session.'},
  {k:['help','support'],a:'You can reach support through the Help & Support option in your Profile, or continue asking me questions here!'},
  {k:['rrr','risk reward','rr'],a:'Enter your Risk:Reward Ratio in the R:R field like "1:2" meaning you risk 1 to make 2. Stats page shows your average R:R over time.'},
];

function sendBot(){
  const inp=document.getElementById('bot-input');
  const msg=inp.value.trim();
  if(!msg)return;
  addBotMsg(msg,'user');
  inp.value='';
  setTimeout(()=>{
    const lower=msg.toLowerCase();
    const match=BOT_ANSWERS.find(b=>b.k.some(k=>lower.includes(k)));
    addBotMsg(match?match.a:"I am not sure about that. Try asking about adding trades, brokers, stats, settings, or the chart selector. For more help, contact support via Profile.",'bot');
  },600);
}

function addBotMsg(text,role){
  const el=document.getElementById('bot-messages');
  const d=document.createElement('div');
  d.style.cssText=`padding:12px 16px;border-radius:${role==='user'?'10px 10px 3px 10px':'10px 10px 10px 3px'};font-size:14px;line-height:1.6;max-width:85%;${role==='user'?'align-self:flex-end;background:var(--gold-dim);border:1px solid var(--border);':'background:rgba(255,255,255,0.04);border:1px solid var(--border2);'}`;
  if(role==='bot')d.innerHTML=`<strong style="color:var(--gold);font-size:11px;letter-spacing:1px;display:block;margin-bottom:4px;">EDGE ASSISTANT</strong>${text}`;
  else d.textContent=text;
  el.appendChild(d);
  el.scrollTop=el.scrollHeight;
}

// ══════════════════════════════════════
// PROFILE
// ══════════════════════════════════════
async function editName(){
  const name=prompt('Enter new name:',state.profile?.full_name||'');
  if(!name?.trim())return;
  const {error}=await db.from('profiles').update({full_name:name.trim()}).eq('id',state.user.id);
  if(error){showToast('Error: '+error.message,'error');return;}
  if(state.profile)state.profile.full_name=name.trim();
  await loadProfile();
  showToast('Name updated!','success');
}

function changeDP(){
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.onchange = async (e) => {
    const file = e.target.files[0];
    if(!file) return;
    if(file.size > 2*1024*1024){ showToast('Image too large. Max 2MB.','error'); return; }
    showToast('Uploading photo...','info');
    try{
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      const filePath = `${state.user.id}/avatar.${ext}`;
      const { error: uploadError } = await db.storage.from('avatars').upload(filePath, file, { upsert: true });
      if(uploadError){ alert('UPLOAD ERROR: '+JSON.stringify(uploadError)); return; }
      const { data: urlData } = db.storage.from('avatars').getPublicUrl(filePath);
      const publicUrl = urlData.publicUrl + '?t=' + Date.now();
      const { error: updateError } = await db.from('profiles').update({ avatar_url: publicUrl }).eq('id', state.user.id);
      if(updateError){ alert('DB UPDATE ERROR: '+JSON.stringify(updateError)); return; }
      const applyDp = (el) => {
        if(!el) return;
        el.style.backgroundImage=`url(${publicUrl})`;
        el.style.backgroundSize='cover';
        el.style.backgroundPosition='center';
        el.textContent='';
      };
      applyDp(document.getElementById('profile-av-big'));
      applyDp(document.getElementById('sidebar-av'));
      applyDp(document.getElementById('topbar-av'));
      if(state.profile) state.profile.avatar_url = publicUrl;
      showToast('Profile photo updated!','success');
    }catch(err){
      alert('CATCH ERROR: '+err.message);
    }
  };
  inp.click();
}

// ══════════════════════════════════════
// SETTINGS
// ══════════════════════════════════════
function setTheme(t,btn){
  document.querySelectorAll('.theme-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  if(t==='light')document.documentElement.classList.add('light-mode');
  else document.documentElement.classList.remove('light-mode');
  localStorage.setItem('et-theme',t);
}

function setAccent(a,el){
  document.querySelectorAll('.swatch').forEach(s=>s.classList.remove('active'));
  el.classList.add('active');
  document.documentElement.classList.remove('theme-cyan','theme-green','theme-purple','theme-steel');
  if(a!=='gold')document.documentElement.classList.add('theme-'+a);
  localStorage.setItem('et-accent',a);
}

function loadPrefs(){
  const t=localStorage.getItem('et-theme');
  const a=localStorage.getItem('et-accent');
  if(t==='light')document.documentElement.classList.add('light-mode');
  if(a&&a!=='gold')document.documentElement.classList.add('theme-'+a);
}

// ══════════════════════════════════════
// COUNTRY SELECTOR
// ══════════════════════════════════════
const COUNTRIES=['Afghanistan','Albania','Algeria','Argentina','Armenia','Australia','Austria','Azerbaijan','Bahrain','Bangladesh','Belarus','Belgium','Bolivia','Brazil','Bulgaria','Cambodia','Canada','Chile','China','Colombia','Croatia','Cuba','Czech Republic','Denmark','Egypt','Estonia','Ethiopia','Finland','France','Georgia','Germany','Ghana','Greece','Guatemala','Honduras','Hong Kong','Hungary','India','Indonesia','Iran','Iraq','Ireland','Israel','Italy','Jamaica','Japan','Jordan','Kazakhstan','Kenya','Kuwait','Latvia','Lebanon','Lithuania','Malaysia','Mexico','Moldova','Morocco','Myanmar','Nepal','Netherlands','New Zealand','Nigeria','Norway','Oman','Pakistan','Panama','Peru','Philippines','Poland','Portugal','Qatar','Romania','Russia','Saudi Arabia','Serbia','Singapore','Slovakia','South Africa','South Korea','Spain','Sri Lanka','Sweden','Switzerland','Syria','Taiwan','Thailand','Turkey','UAE','Uganda','Ukraine','United Kingdom','United States','Uzbekistan','Venezuela','Vietnam','Yemen','Zimbabwe'];

let countryOpen=false;
function buildCountryList(filter=''){
  const list=document.getElementById('country-list');
  list.innerHTML='';
  (filter?COUNTRIES.filter(c=>c.toLowerCase().includes(filter.toLowerCase())):COUNTRIES).forEach(c=>{
    const d=document.createElement('div');
    d.className='country-item';d.textContent=c;
    d.onclick=()=>selectCountry(c);
    list.appendChild(d);
  });
}
function toggleCountry(){
  const dd=document.getElementById('country-dd');
  const dis=document.getElementById('country-display');
  countryOpen=!countryOpen;
  if(countryOpen){dd.classList.add('open');dis.classList.add('open');buildCountryList();setTimeout(()=>document.getElementById('country-search').focus(),80);}
  else{dd.classList.remove('open');dis.classList.remove('open');}
}
function filterCountries(v){buildCountryList(v);}
function selectCountry(c){
  document.getElementById('s-country').value=c;
  document.getElementById('country-text').textContent=c;
  document.getElementById('country-text').style.color='var(--white)';
  document.getElementById('country-dd').classList.remove('open');
  document.getElementById('country-display').classList.remove('open');
  document.getElementById('country-search').value='';
  countryOpen=false;
}
document.addEventListener('click',e=>{
  const w=document.querySelector('.country-wrap');
  if(w&&!w.contains(e.target)&&countryOpen){
    document.getElementById('country-dd').classList.remove('open');
    document.getElementById('country-display').classList.remove('open');
    countryOpen=false;
  }
});

// ══════════════════════════════════════
// UI HELPERS
// ══════════════════════════════════════
function showMsg(type,text){
  const ms=document.getElementById('msg-success');
  const me=document.getElementById('msg-error');
  ms.style.display='none';me.style.display='none';
  if(type==='success'){ms.textContent='✓ '+text;ms.style.display='block';}
  else{me.textContent=text;me.style.display='block';}
}
function hideMsg(){
  document.getElementById('msg-success').style.display='none';
  document.getElementById('msg-error').style.display='none';
}

function showToast(msg,type='success'){
  const t=document.getElementById('toast');
  t.textContent=(type==='success'?'✓ ':'')+msg;
  t.className='toast show '+(type==='success'?'success':'error');
  setTimeout(()=>t.className='toast',3000);
}

// ══════════════════════════════════════
// INIT
// ══════════════════════════════════════
window.onload=async function(){
  loadPrefs();
  buildCountryList();
  renderChartList(CHARTS);

  // Force hide loader after 4 seconds no matter what
  const forceHide = setTimeout(()=>{
    const ls=document.getElementById('loading-screen');
    if(ls){ls.style.opacity='0';ls.style.transition='opacity 0.5s';setTimeout(()=>ls.style.display='none',500);}
    showPage('page-landing');
  }, 4000);

  try {
    // Check if user is already logged in — with 3s timeout
    const sessionPromise = db.auth.getSession();
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve({data:{session:null}}), 3000));
    const {data:{session}} = await Promise.race([sessionPromise, timeoutPromise]);

    clearTimeout(forceHide);

    if(session?.user){
      await initApp(session.user);
    } else {
      showPage('page-landing');
    }
  } catch(e) {
    clearTimeout(forceHide);
    showPage('page-landing');
  }

  // Hide loading screen
  setTimeout(()=>{
    const ls=document.getElementById('loading-screen');
    if(ls){ls.style.opacity='0';ls.style.transition='opacity 0.5s';setTimeout(()=>ls.style.display='none',500);}
  },800);

  // Auth state changes
  db.auth.onAuthStateChange((event,session)=>{
    if(event==='SIGNED_IN'&&session){}
    if(event==='SIGNED_OUT'){showPage('page-landing');}
  });
};
// ══════════════════════════════════════
// STRATEGY AUTOCOMPLETE SYSTEM
// ══════════════════════════════════════
let _strategyCache = [];
let _stratDDOpen = false;

async function loadUserStrategies(){
  if(!state.user) return;
  try {
    const {data} = await db.from('trades')
      .select('strategy')
      .eq('user_id', state.user.id)
      .not('strategy','is',null)
      .neq('strategy','');
    if(!data){_strategyCache=[];return;}
    const map={};
    data.forEach(t=>{
      const s=(t.strategy||'').trim();
      if(s) map[s]=(map[s]||0)+1;
    });
    _strategyCache = Object.entries(map)
      .map(([strategy,usage_count])=>({strategy,usage_count}))
      .sort((a,b)=>b.usage_count-a.usage_count);
  } catch(e){_strategyCache=[];}
}

function openStrategyDD(){
  if(!_strategyCache.length){
    loadUserStrategies().then(()=>renderStrategyDD(''));
  } else {
    renderStrategyDD(document.getElementById('e-strategy').value||'');
  }
  const overlay = document.getElementById('strategy-modal-overlay');
  if(overlay) overlay.classList.add('open');
  document.body.style.overflow='hidden';
  _stratDDOpen = true;
  // Clear search and focus
  setTimeout(()=>{
    const si = document.getElementById('strategy-search-inp');
    if(si){ si.value=''; si.focus(); }
  }, 100);
}

function filterStrategyDD(val){
  renderStrategyDD(val);
  if(_strategyCache.length>0 && !_stratDDOpen){
    const overlay = document.getElementById('strategy-modal-overlay');
    if(overlay) overlay.classList.add('open');
    document.body.style.overflow='hidden';
    _stratDDOpen = true;
  }
}

function renderStrategyDD(query){
  const list = document.getElementById('strategy-dd-list');
  if(!list) return;
  const q=(query||'').toLowerCase().trim();
  const filtered = q ? _strategyCache.filter(s=>s.strategy.toLowerCase().includes(q)) : _strategyCache;
  if(!filtered.length){
    list.innerHTML='<div class="strategy-dd-empty">No saved strategies yet.<br>Type a strategy name and save your trade — it will appear here next time!</div>';
    return;
  }
  list.innerHTML = filtered.map(s=>{
    const safeName = s.strategy.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    return '<div class="strategy-item" onclick="selectStrategy(\'' + safeName + '\')"><span class="strategy-item-name">' + s.strategy + '</span><span class="strategy-item-count">' + s.usage_count + 'x used</span></div>';
  }).join('');
}

function selectStrategy(name){
  const ta = document.getElementById('e-strategy');
  if(ta){ ta.value = name; }
  closeStrategyDD();
}

function closeStrategyDD(e){
  // Called from X button (no event) or overlay background click
  if(e && e.type==='click' && e.target !== document.getElementById('strategy-modal-overlay')) return;
  const overlay = document.getElementById('strategy-modal-overlay');
  if(overlay) overlay.classList.remove('open');
  document.body.style.overflow='';
  _stratDDOpen = false;
}

function closeStrategyDDBtn(){
  const overlay = document.getElementById('strategy-modal-overlay');
  if(overlay) overlay.classList.remove('open');
  document.body.style.overflow='';
  _stratDDOpen = false;
}


// Hook into initApp to load strategies
const _origInitApp = window.initApp;
window.initApp = async function(user){
  await _origInitApp.call(this, user);
  await loadUserStrategies();
};

// Reload strategies after saveTrade
const _origSaveTrade = window.saveTrade;
window.saveTrade = async function(){
  await _origSaveTrade.call(this);
  await loadUserStrategies();
};

// ══════════════════════════════════════
// STRATEGY STATS
// ══════════════════════════════════════
let _stratView = 'list';

function setStratView(view, btn){
  _stratView = view;
  document.querySelectorAll('.strat-filter-btn').forEach(b=>b.classList.remove('active'));
  if(btn) btn.classList.add('active');
  document.getElementById('strat-list-view').style.display = view==='list' ? 'block' : 'none';
  document.getElementById('strat-compare-view').style.display = view==='compare' ? 'block' : 'none';
}

function renderStrategyStats(trades){
  const map={};
  trades.forEach(t=>{
    const s=(t.strategy||'').trim();
    if(!s)return;
    if(!map[s]) map[s]={name:s,total:0,wins:0,losses:0,bes:0,bySession:{}};
    map[s].total++;
    if(t.conclusion==='target') map[s].wins++;
    else if(t.conclusion==='loss') map[s].losses++;
    else map[s].bes++;
    const sess=(t.session||'').trim();
    if(sess){
      if(!map[s].bySession[sess]) map[s].bySession[sess]={total:0,wins:0};
      map[s].bySession[sess].total++;
      if(t.conclusion==='target') map[s].bySession[sess].wins++;
    }
  });
  const strats = Object.values(map).sort((a,b)=>b.total-a.total);
  const listEl = document.getElementById('strat-list-view');
  if(!strats.length){
    listEl.innerHTML='<div style="color:var(--muted);font-size:13px;">No strategy data yet. Start logging trades with strategies.</div>';
    const cg = document.getElementById('strat-compare-grid'); if(cg) cg.innerHTML='';
    return;
  }
  const maxTotal = Math.max(...strats.map(s=>s.total));
  listEl.innerHTML = strats.map((s,i)=>{
    const wr = Math.round(s.wins/s.total*100);
    const barColor = wr>=60?'var(--green)':wr>=40?'var(--gold)':'var(--red)';
    return '<div>' +
      '<div class="strat-row" onclick="toggleStratDetail(\'strat-detail-' + i + '\')">' +
        '<div style="flex:1;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">' +
            '<span class="strat-name">' + s.name + '</span>' +
            '<div class="strat-badges">' +
              '<span class="strat-badge sb-total">' + s.total + ' trades</span>' +
              '<span class="strat-badge sb-win">&#x2705; ' + s.wins + '</span>' +
              '<span class="strat-badge sb-loss">&#x274C; ' + s.losses + '</span>' +
              '<span class="strat-badge sb-wr" style="font-weight:700;">' + wr + '%</span>' +
            '</div>' +
          '</div>' +
          '<div class="strat-bar-wrap"><div class="strat-bar" style="width:' + (s.total/maxTotal*100) + '%;background:' + barColor + ';"></div></div>' +
        '</div>' +
        '<span style="margin-left:10px;color:var(--muted);font-size:12px;">&#x203A;</span>' +
      '</div>' +
      '<div class="strat-detail-panel" id="strat-detail-' + i + '">' +
        '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;text-align:center;">' +
          '<div><div style="font-family:\'Cormorant Garamond\',serif;font-size:22px;font-weight:600;color:' + barColor + ';">' + wr + '%</div><div style="font-size:10px;color:var(--muted);">Win Rate</div></div>' +
          '<div><div style="font-family:\'Cormorant Garamond\',serif;font-size:22px;font-weight:600;color:var(--white);">' + s.total + '</div><div style="font-size:10px;color:var(--muted);">Trades</div></div>' +
          '<div><div style="font-family:\'Cormorant Garamond\',serif;font-size:22px;font-weight:600;color:var(--green);">' + s.wins + '</div><div style="font-size:10px;color:var(--muted);">Wins</div></div>' +
          '<div><div style="font-family:\'Cormorant Garamond\',serif;font-size:22px;font-weight:600;color:var(--red);">' + s.losses + '</div><div style="font-size:10px;color:var(--muted);">Losses</div></div>' +
        '</div>' +
        (s.bes>0 ? '<div style="margin-top:8px;font-size:12px;color:var(--muted);text-align:center;">&#x2696;&#xFE0F; ' + s.bes + ' Breakeven trade' + (s.bes>1?'s':'') + '</div>' : '') +
        (Object.keys(s.bySession).length>0 ? '<div class="strat-session-block">' + Object.keys(s.bySession).sort((a,b)=>s.bySession[b].total-s.bySession[a].total).map(sessName=>{ const sm=s.bySession[sessName]; const swr=Math.round(sm.wins/sm.total*100); const swrColor=swr>=60?'var(--green)':swr>=40?'var(--gold)':'var(--red)'; return '<div class="strat-session-row"><span class="strat-session-name">' + sessName + ' (' + sm.total + ')</span><span class="strat-session-wr" style="color:' + swrColor + ';">\xA0' + swr + '%</span></div>'; }).join('') + '</div>' : '') +
      '</div>' +
    '</div>';
  }).join('');

  const grid = document.getElementById('strat-compare-grid');
  if(grid){
    grid.innerHTML = strats.map(s=>{
      const wr = Math.round(s.wins/s.total*100);
      const col = wr>=60?'var(--green)':wr>=40?'var(--gold)':'var(--red)';
      return '<div class="strat-compare-card"><div class="strat-compare-name" title="' + s.name + '">' + s.name + '</div><div class="strat-compare-wr" style="color:' + col + ';">' + wr + '%</div><div class="strat-compare-sub">' + s.wins + 'W &middot; ' + s.losses + 'L &middot; ' + s.total + ' total</div></div>';
    }).join('');
  }
}

function toggleStratDetail(id){
  const el = document.getElementById(id);
  if(!el) return;
  const isOpen = el.classList.contains('open');
  document.querySelectorAll('.strat-detail-panel').forEach(p=>p.classList.remove('open'));
  if(!isOpen) el.classList.add('open');
}
// ═══════════════════════════════════
// CANDLE RAIN ANIMATION — TAGDA VERSION
// ═══════════════════════════════════
(function initCandleRain(){
  const canvas = document.getElementById('candle-rain');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');

  function resize(){
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  // Candle factory
  function newCandle(spreadY){
    const bull = Math.random() > 0.44;
    const bH = 18 + Math.random() * 52;
    const bW = 6 + Math.random() * 7;
    return {
      x: Math.random() * canvas.width,
      y: spreadY ? Math.random() * canvas.height : -100 - Math.random() * 400,
      speed: 0.6 + Math.random() * 1.4,
      bH, bW,
      wickT: 6 + Math.random() * 22,
      wickB: 6 + Math.random() * 16,
      bull,
      alpha: 0.08 + Math.random() * 0.38,
      drift: (Math.random() - 0.5) * 0.25,
      rot: (Math.random() - 0.5) * 0.22,
      rotSpeed: (Math.random() - 0.5) * 0.0012,
      scale: 0.55 + Math.random() * 1.0,
      // Glow pulse
      pulse: Math.random() * Math.PI * 2,
      pulseSpeed: 0.02 + Math.random() * 0.03,
    };
  }

  const COUNT = 55;
  const candles = [];
  for(let i = 0; i < COUNT; i++) candles.push(newCandle(true));

  function drawCandle(c){
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.rot);
    ctx.scale(c.scale, c.scale);

    // Pulsing glow effect
    const glowPulse = 0.7 + 0.3 * Math.sin(c.pulse);
    ctx.globalAlpha = c.alpha * glowPulse;

    const col = c.bull ? '#4CAF7D' : '#E05252';
    const glowCol = c.bull ? 'rgba(76,175,125,0.15)' : 'rgba(224,82,82,0.15)';
    const hw = c.bW / 2;

    // Outer glow
    const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, c.bW * 2.5);
    grd.addColorStop(0, glowCol);
    grd.addColorStop(1, 'transparent');
    ctx.fillStyle = grd;
    ctx.fillRect(-c.bW * 2.5, -c.bH / 2 - c.wickT, c.bW * 5, c.bH + c.wickT + c.wickB);

    // Wick
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, -c.bH / 2 - c.wickT);
    ctx.lineTo(0, c.bH / 2 + c.wickB);
    ctx.stroke();

    // Candle body
    ctx.fillStyle = col;
    ctx.beginPath();
    if(ctx.roundRect){
      ctx.roundRect(-hw, -c.bH / 2, c.bW, c.bH, 2);
    } else {
      ctx.rect(-hw, -c.bH / 2, c.bW, c.bH);
    }
    ctx.fill();

    // Shine on body
    const shine = ctx.createLinearGradient(-hw, -c.bH/2, hw, c.bH/2);
    shine.addColorStop(0, 'rgba(255,255,255,0.18)');
    shine.addColorStop(0.4, 'rgba(255,255,255,0.06)');
    shine.addColorStop(1, 'rgba(0,0,0,0.1)');
    ctx.fillStyle = shine;
    ctx.beginPath();
    if(ctx.roundRect){
      ctx.roundRect(-hw, -c.bH / 2, c.bW, c.bH, 2);
    } else {
      ctx.rect(-hw, -c.bH / 2, c.bW, c.bH);
    }
    ctx.fill();

    ctx.restore();
  }

  let animId;
  let lastTime = 0;

  function animate(timestamp){
    const delta = Math.min((timestamp - lastTime) / 16, 3);
    lastTime = timestamp;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    candles.forEach(c => {
      c.y += c.speed * delta;
      c.x += c.drift * delta;
      c.rot += c.rotSpeed * delta;
      c.pulse += c.pulseSpeed * delta;

      // Reset when off screen
      if(c.y > canvas.height + 120){
        Object.assign(c, newCandle(false));
      }
      // Keep x in bounds loosely
      if(c.x < -60) c.drift = Math.abs(c.drift);
      if(c.x > canvas.width + 60) c.drift = -Math.abs(c.drift);

      drawCandle(c);
    });

    animId = requestAnimationFrame(animate);
  }

  animId = requestAnimationFrame(animate);

  // Pause when tab hidden — save battery
  document.addEventListener('visibilitychange', () => {
    if(document.hidden){
      cancelAnimationFrame(animId);
    } else {
      lastTime = 0;
      animId = requestAnimationFrame(animate);
    }
  });

  // Pause when scrolled past hero
  const heroSection = document.querySelector('.hero');
  if(heroSection){
    const obs = new IntersectionObserver(entries => {
      if(entries[0].isIntersecting){
        lastTime = 0;
        animId = requestAnimationFrame(animate);
      } else {
        cancelAnimationFrame(animId);
      }
    }, {threshold: 0.01});
    obs.observe(heroSection);
  }
})();

// ══════════════════════════════════════
// CALCULATOR + AI
// ══════════════════════════════════════

let calcImg = null;
let mainChartInstance = null;
let activeIndicators = {};
let klineSocket = null;
let obSocket = null;
let moSocket = null;
let currentInterval = '1m';
let currentSymbol = 'BTCUSDT';
let binanceMarkets = null;

// ── Chart Tabs (Chrome-style workspace tabs, Pane 1 only) ──
// Each tab remembers its own symbol/interval/chartType/indicators. Only ONE
// klinecharts instance + one live WebSocket run at a time (whichever tab is
// active) — switching tabs snapshots the outgoing tab's live state, then
// restores the incoming tab's state into the same chart engine. This keeps
// things smooth (no N parallel sockets/instances) while still feeling like
// independent tabs, since every value is fully persisted per tab.
let chartTabs = [{ id: 1, symbol: 'BTCUSDT', interval: '1m', chartType: 'candle_solid', indicators: [] }];
let activeChartTabId = 1;
let nextChartTabId = 2;
const CHART_TAB_INDICATOR_OVERLAY = { MA: true, EMA: true, BOLL: true, VOL: false, MACD: false, RSI: false, KDJ: false };

// ── Pane 2 (Phase 2): fully independent state, mirrors Pane 1's globals above.
// Order Book/Trading panel stay bound to Pane 1 only — active-pane binding is Phase 4.
let mainChartInstance2 = null;
let activeIndicators2 = {};
let klineSocket2 = null;
let currentInterval2 = '1m';
let currentSymbol2 = 'ETHUSDT';
let currentChartType2 = 'candle_solid';
let pane2Initialized = false;
let latestPrice2 = null;

async function initMainChart(){
  renderChartTabs();
  const container = document.getElementById('klineMainChart');
  try {
    container.innerHTML = '<div style="padding:20px;color:var(--muted);">Loading chart library...</div>';
    if (typeof klinecharts === 'undefined') {
      throw new Error('klinecharts library did not load from CDN (script tag failed or wrong URL)');
    }
    container.innerHTML = '';
    ensureDemoAccount().then(loadDemoPositions);
    if(mainChartInstance) return;
    mainChartInstance = klinecharts.init('klineMainChart');
    if (!mainChartInstance) throw new Error('klinecharts.init() returned null — check container id');

    mainChartInstance.setStyles({
      grid: { show:true, horizontal:{color:'#2a2a2a'}, vertical:{color:'#2a2a2a'} },
      candle: { bar: { upColor:'#4CAF7D', downColor:'#E05252', noChangeColor:'#888888' } }
    });
    attachCrosshairSync(1, mainChartInstance);
    attachViewportSync(1, mainChartInstance);

    await loadChartInterval(currentInterval);
  } catch(err) {
    container.innerHTML = '<div style="padding:20px;color:#E05252;font-family:monospace;font-size:13px;white-space:pre-wrap;">CHART ERROR:\n' + err.message + '</div>';
    console.error('Chart init failed:', err);
  }
}

// Fetches candles for the given Binance interval (1m/5m/15m/1h/4h/1d), applies them
// to the chart, and re-subscribes the live kline WebSocket to that same interval.
async function loadChartInterval(interval){
  const res = await fetch('https://api.binance.com/api/v3/klines?symbol=' + currentSymbol + '&interval=' + interval + '&limit=300');
  if (!res.ok) throw new Error('Binance API fetch failed: ' + res.status);
  const raw = await res.json();
  const data = raw.map(k => ({
    timestamp: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
  }));
  mainChartInstance.applyNewData(data);

  if(klineSocket) klineSocket.close();
  klineSocket = new WebSocket('wss://stream.binance.com:9443/ws/' + currentSymbol.toLowerCase() + '@kline_' + interval);
  klineSocket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const k = msg.k;
    mainChartInstance.updateData({
      timestamp: k.t, open: parseFloat(k.o), high: parseFloat(k.h),
      low: parseFloat(k.l), close: parseFloat(k.c), volume: parseFloat(k.v)
    });
    latestPrice = parseFloat(k.c);
    checkTpSlLiquidation(latestPrice);
    updateOpenPositionsPnL(latestPrice);
    updateMaxPriceOverlay(latestPrice);
  };
  currentInterval = interval;
}

let chartMaximized = false;
let prevMaxOverlayPrice = null;
// Remembers where #chart-tabs-bar normally lives, so it can be moved inside
// .chart-workspace for fullscreen (see toggleChartMaximize) and put back exactly
// where it was afterwards.
let chartTabsBarOriginalParent = null;
let chartTabsBarOriginalNext = null;
function formatPriceDisplay(price){
  if(price >= 1) return price.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2});
  return price.toPrecision(4);
}
function updateMaxPriceOverlay(price){
  const el = document.getElementById('chart-max-price');
  if(!el) return;
  el.textContent = formatPriceDisplay(price);
  if(prevMaxOverlayPrice != null){
    el.style.color = price >= prevMaxOverlayPrice ? 'var(--green)' : 'var(--red)';
  }
  prevMaxOverlayPrice = price;
}

function toggleChartMaximize(){
  const workspace = document.querySelector('.chart-workspace');
  const chartDiv = document.getElementById('klineMainChart');
  const overlay = document.getElementById('chart-symbol-overlay');
  const btn = document.getElementById('chart-maximize-btn');
  const cockpitBtn = document.getElementById('chart-maximize-btn-cockpit');
  const tabsBar = document.getElementById('chart-tabs-bar');
  const cockpit = document.getElementById('chart-cockpit');
  if(!workspace || !chartDiv) return;
  chartMaximized = !chartMaximized;
  if(chartMaximized){
    // #chart-tabs-bar normally sits OUTSIDE .chart-workspace. Maximized workspace
    // becomes position:fixed + inset:0 + very high z-index, covering the whole
    // viewport on top of the tabs bar and hiding it. Move the tabs bar inside the
    // workspace (as the first child, above the cockpit) for the duration of
    // fullscreen so it stays visible and usable; restored on exit below.
    if(tabsBar && tabsBar.parentElement !== workspace){
      chartTabsBarOriginalParent = tabsBar.parentElement;
      chartTabsBarOriginalNext = tabsBar.nextSibling;
      workspace.insertBefore(tabsBar, cockpit || workspace.firstChild);
      tabsBar.classList.add('chart-tabs-bar-fullscreen');
    }
    workspace.classList.add('chart-maximized');
    document.body.style.overflow = 'hidden';
    if(overlay) overlay.style.display = 'flex';
    if(btn){ btn.innerHTML = '✕'; btn.title = 'Exit fullscreen'; }
    if(cockpitBtn){ cockpitBtn.innerHTML = '✕'; cockpitBtn.title = 'Exit fullscreen'; }
  } else {
    workspace.classList.remove('chart-maximized');
    document.body.style.overflow = '';
    if(overlay) overlay.style.display = 'none';
    if(btn){ btn.innerHTML = '⛶'; btn.title = 'Maximize chart'; }
    if(cockpitBtn){ cockpitBtn.innerHTML = '⛶'; cockpitBtn.title = 'Fullscreen'; }
    // Restore the tabs bar to exactly where it lived before maximizing.
    if(tabsBar && chartTabsBarOriginalParent){
      tabsBar.classList.remove('chart-tabs-bar-fullscreen');
      if(chartTabsBarOriginalNext && chartTabsBarOriginalNext.parentElement === chartTabsBarOriginalParent){
        chartTabsBarOriginalParent.insertBefore(tabsBar, chartTabsBarOriginalNext);
      } else {
        chartTabsBarOriginalParent.appendChild(tabsBar);
      }
      chartTabsBarOriginalParent = null;
      chartTabsBarOriginalNext = null;
    }
  }
  setTimeout(() => {
    if(mainChartInstance && mainChartInstance.resize) mainChartInstance.resize();
    window.dispatchEvent(new Event('resize'));
  }, 50);
}
document.addEventListener('keydown', (e) => { if(e.key === 'Escape' && chartMaximized) toggleChartMaximize(); });

async function switchTimeframe(tf){
  closeCockpitDropdown(document.getElementById('tf-dd'));
  if(tf === currentInterval || !mainChartInstance) return;
  document.querySelectorAll('.chart-item[id^="tf-item-"]').forEach(b => b.classList.remove('active-tool'));
  const activeItem = document.getElementById('tf-item-' + tf);
  if(activeItem) activeItem.classList.add('active-tool');
  const selectBtn = document.getElementById('tf-select-btn');
  const labelText = activeItem ? activeItem.textContent : tf;
  if(selectBtn) selectBtn.title = 'Timeframe: ' + labelText;
  const labelEl = document.getElementById('tf-current-label');
  if(labelEl) labelEl.textContent = labelText;
  try {
    await loadChartInterval(tf);
  } catch(err) {
    console.error('Timeframe switch failed:', err);
  }
  broadcastIntervalSync(1, tf);
}

let currentChartType = 'candle_solid';
const CHART_TYPE_ICONS = {
  candle_solid: '<svg class="nav-icon-svg" viewBox="0 0 24 24"><line x1="6" y1="2" x2="6" y2="7"/><rect x="4" y="7" width="4" height="8" rx="1" fill="currentColor"/><line x1="6" y1="15" x2="6" y2="22"/><line x1="14" y1="4" x2="14" y2="9"/><rect x="12" y="9" width="4" height="7" rx="1" fill="currentColor"/><line x1="14" y1="16" x2="14" y2="20"/></svg>',
  candle_stroke: '<svg class="nav-icon-svg" viewBox="0 0 24 24"><line x1="6" y1="2" x2="6" y2="7"/><rect x="4" y="7" width="4" height="8" rx="1"/><line x1="6" y1="15" x2="6" y2="22"/><line x1="14" y1="4" x2="14" y2="9"/><rect x="12" y="9" width="4" height="7" rx="1"/><line x1="14" y1="16" x2="14" y2="20"/></svg>',
  ohlc: '<svg class="nav-icon-svg" viewBox="0 0 24 24"><line x1="7" y1="4" x2="7" y2="20"/><line x1="3" y1="8" x2="7" y2="8"/><line x1="7" y1="15" x2="11" y2="15"/><line x1="17" y1="2" x2="17" y2="18"/><line x1="13" y1="6" x2="17" y2="6"/><line x1="17" y1="13" x2="21" y2="13"/></svg>',
  area: '<svg class="nav-icon-svg" viewBox="0 0 24 24"><path d="M3 17 L8 11 L12 14 L16 7 L21 10 L21 21 L3 21 Z" fill="currentColor" fill-opacity="0.18" stroke="none"/><polyline points="3,17 8,11 12,14 16,7 21,10"/></svg>'
};
function switchChartType(type){
  closeCockpitDropdown(document.getElementById('ct-dd'));
  if(!mainChartInstance || type === currentChartType) return;
  mainChartInstance.setStyles({ candle: { type } });
  document.querySelectorAll('.chart-item[id^="ct-item-"]').forEach(b => b.classList.remove('active-tool'));
  const activeItem = document.getElementById('ct-item-' + type);
  if(activeItem) activeItem.classList.add('active-tool');
  const selectBtn = document.getElementById('ct-select-btn');
  if(selectBtn) selectBtn.title = 'Chart type: ' + (activeItem ? activeItem.textContent : type);
  const iconEl = document.getElementById('ct-current-icon');
  if(iconEl) iconEl.innerHTML = CHART_TYPE_ICONS[type] || CHART_TYPE_ICONS.candle_solid;
  currentChartType = type;
}

function formatSymbolLabel(sym){
  return sym.replace(/USDT$/, '') + '/USDT';
}

async function loadBinanceMarkets(){
  if(binanceMarkets) return binanceMarkets;
  try{
    const res = await fetch('https://api.binance.com/api/v3/ticker/24hr');
    const data = await res.json();
    binanceMarkets = data
      .filter(t => t.symbol.endsWith('USDT') && !/(UP|DOWN|BULL|BEAR)USDT$/.test(t.symbol))
      .sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 150)
      .map(t => t.symbol);
  }catch(err){
    console.error('Failed to load markets:', err);
    binanceMarkets = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT'];
  }
  return binanceMarkets;
}

function renderMarketList(list){
  const el = document.getElementById('market-list');
  if(!el) return;
  if(!list.length){ el.innerHTML = '<div style="padding:10px;color:var(--muted);font-size:12px;">No match</div>'; return; }
  el.innerHTML = list.map(sym =>
    '<div class="chart-item" onclick="selectMarket(\'' + sym + '\')"><span>' + formatSymbolLabel(sym) + '</span><span class="chart-item-cat">Binance</span></div>'
  ).join('');
}

/* ═══ Cockpit dropdown system ═══
   Every .chart-dd panel gets moved ("portaled") to document.body the moment
   it opens, then repositioned with position:fixed under its trigger button.
   This is what actually fixes the old "dropdown renders behind/clipped by
   the chart" bug: .chart-cockpit needs overflow-x:auto for its horizontal
   scroll, and that clips ANY absolutely/fixed positioned descendant that
   stays inside it (backdrop-filter on the cockpit makes this worse, since it
   also creates a containing block for fixed children). Moving the dropdown
   out of that DOM subtree entirely sidesteps the problem completely,
   regardless of any ancestor's overflow/backdrop-filter. */
const COCKPIT_DD_IDS = ['market-dd','tf-dd','ct-dd','ind-dd'];

function positionCockpitDropdown(dd, btn){
  const r = btn.getBoundingClientRect();
  const minWidth = parseInt(dd.getAttribute('data-min-width') || '150', 10);
  const width = Math.max(r.width, minWidth);
  let left = r.left;
  if(left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
  if(left < 8) left = 8;
  dd.style.position = 'fixed';
  dd.style.top = (r.bottom + 6) + 'px';
  dd.style.left = left + 'px';
  dd.style.width = width + 'px';
  dd.style.right = 'auto';
}

function closeCockpitDropdown(dd){
  if(!dd || !dd.classList.contains('open')) return;
  dd.classList.remove('open');
  if(dd._origParent){
    if(dd._origNext && dd._origNext.parentNode === dd._origParent) dd._origParent.insertBefore(dd, dd._origNext);
    else dd._origParent.appendChild(dd);
  }
  dd.style.position = '';
  dd.style.top = '';
  dd.style.left = '';
  dd.style.width = '';
  dd.style.right = '';
}

function closeAllCockpitDropdowns(exceptId){
  COCKPIT_DD_IDS.forEach(id => {
    if(id === exceptId) return;
    closeCockpitDropdown(document.getElementById(id));
  });
}

function openCockpitDropdown(ddId, btnId){
  const dd = document.getElementById(ddId);
  const btn = document.getElementById(btnId);
  if(!dd || !btn) return;
  closeAllCockpitDropdowns(ddId);
  closeLayoutDropdowns();
  if(!dd._origParent){
    dd._origParent = dd.parentNode;
    dd._origNext = dd.nextSibling;
  }
  document.body.appendChild(dd);
  positionCockpitDropdown(dd, btn);
  dd.classList.add('open');
}

document.addEventListener('click', (e) => {
  COCKPIT_DD_IDS.forEach(id => {
    const dd = document.getElementById(id);
    if(!dd || !dd.classList.contains('open')) return;
    const btnId = id.replace(/-dd$/, '-select-btn');
    const btn = document.getElementById(btnId);
    if(dd.contains(e.target)) return;
    if(btn && (btn === e.target || btn.contains(e.target))) return;
    closeCockpitDropdown(dd);
  });
});
function repositionOpenCockpitDropdowns(){
  COCKPIT_DD_IDS.forEach(id => {
    const dd = document.getElementById(id);
    if(!dd || !dd.classList.contains('open')) return;
    const btnId = id.replace(/-dd$/, '-select-btn');
    const btn = document.getElementById(btnId);
    if(btn) positionCockpitDropdown(dd, btn);
  });
}
window.addEventListener('scroll', repositionOpenCockpitDropdowns, true);
window.addEventListener('resize', repositionOpenCockpitDropdowns);

async function toggleMarketDropdown(){
  const dd = document.getElementById('market-dd');
  if(!dd) return;
  if(dd.classList.contains('open')){ closeCockpitDropdown(dd); return; }
  openCockpitDropdown('market-dd', 'market-select-btn');
  const list = await loadBinanceMarkets();
  renderMarketList(list);
  const s = document.getElementById('market-search');
  if(s) setTimeout(() => s.focus(), 50);
}

function filterMarketList(val){
  if(!binanceMarkets) return;
  const v = val.trim().toUpperCase();
  renderMarketList(v ? binanceMarkets.filter(s => s.includes(v)) : binanceMarkets);
}

async function selectMarket(symbol){
  closeCockpitDropdown(document.getElementById('market-dd'));
  if(symbol === currentSymbol || !mainChartInstance) return;
  currentSymbol = symbol;
  const label = formatSymbolLabel(symbol);
  const btn = document.getElementById('market-select-btn');
  if(btn) btn.textContent = label + ' ▾';
  const nameEl = document.querySelector('#chart-symbol-overlay .csym-name');
  if(nameEl) nameEl.innerHTML = label + ' <span class="csym-sub">· Binance</span>';
  prevMaxOverlayPrice = null;
  // Keep the active tab pill + Order Book/Trade Terminal labels in sync the moment
  // the symbol changes — previously these only refreshed on the next tab switch.
  const idx = getChartTabIndex(activeChartTabId);
  if(idx !== -1){ chartTabs[idx].symbol = symbol; renderChartTabs(); }
  updateTradingWorkspaceLabel(currentSymbol);
  try{
    await loadChartInterval(currentInterval);
    connectOrderBook(currentSymbol);
  }catch(err){ console.error('Symbol switch failed:', err); }
  broadcastSymbolSync(1, symbol);
}

function toggleTfDropdown(){
  const dd = document.getElementById('tf-dd');
  if(!dd) return;
  if(dd.classList.contains('open')){ closeCockpitDropdown(dd); return; }
  openCockpitDropdown('tf-dd', 'tf-select-btn');
}

function toggleCtDropdown(){
  const dd = document.getElementById('ct-dd');
  if(!dd) return;
  if(dd.classList.contains('open')){ closeCockpitDropdown(dd); return; }
  openCockpitDropdown('ct-dd', 'ct-select-btn');
}

function toggleIndDropdown(){
  const dd = document.getElementById('ind-dd');
  if(!dd) return;
  if(dd.classList.contains('open')){ closeCockpitDropdown(dd); return; }
  openCockpitDropdown('ind-dd', 'ind-select-btn');
}

/* ═══ Split Screen / Layout picker (Phase 1: UI + basic 1↔2 pane split) ═══
   Two separate popups (per confirmed spec — sync card is NOT inside the grid
   card): the sync card portals to document.body first, the grid card portals
   right below it. Both share the .chart-dd visual style/z-index but are
   opened/closed/positioned by their own logic here, independent of the
   generic COCKPIT_DD_IDS system used for market/timeframe/type/indicators.
   3+ pane layouts are selectable in the UI but real independent chart
   instances per pane are Phase 2 — clicking them just shows a notice so
   nothing half-works or breaks. */
let currentLayoutGroup = 1;
let currentLayoutVariant = 0;
let layoutSyncSettings = { symbol:false, interval:false, crosshair:false, time:false, dateRange:false };

// Leaf = 'S'. Counts per group intentionally match the TradingView reference
// screenshot (1:1, 2:2, 3:6, 4:10, 5:10, 6:6, 7:3, 8:4).
const LAYOUT_CONFIGS = {
  1: [ 'S' ],
  2: [
    {dir:'row', c:['S','S']},
    {dir:'col', c:['S','S']}
  ],
  3: [
    {dir:'row', c:['S','S','S']},
    {dir:'col', c:['S','S','S']},
    {dir:'row', c:['S', {dir:'col', c:['S','S']}]},
    {dir:'row', c:[{dir:'col', c:['S','S']}, 'S']},
    {dir:'col', c:['S', {dir:'row', c:['S','S']}]},
    {dir:'col', c:[{dir:'row', c:['S','S']}, 'S']}
  ],
  4: [
    {dir:'row', c:[{dir:'col',c:['S','S']},{dir:'col',c:['S','S']}]},
    {dir:'col', c:['S','S','S','S']},
    {dir:'row', c:['S','S','S','S']},
    {dir:'row', c:['S', {dir:'col', c:['S','S','S']}]},
    {dir:'row', c:[{dir:'col', c:['S','S','S']}, 'S']},
    {dir:'col', c:['S', {dir:'row', c:['S','S','S']}]},
    {dir:'col', c:[{dir:'row', c:['S','S','S']}, 'S']},
    {dir:'row', c:['S','S',{dir:'col',c:['S','S']}]},
    {dir:'row', c:[{dir:'col',c:['S','S']},'S','S']},
    {dir:'col', c:['S','S',{dir:'row',c:['S','S']}]}
  ],
  5: [
    {dir:'row', c:['S',{dir:'col',c:['S','S','S','S']}]},
    {dir:'col', c:['S','S','S','S','S']},
    {dir:'row', c:['S','S','S','S','S']},
    {dir:'row', c:[{dir:'col',c:['S','S']},{dir:'col',c:['S','S','S']}]},
    {dir:'row', c:[{dir:'col',c:['S','S','S']},{dir:'col',c:['S','S']}]},
    {dir:'col', c:[{dir:'row',c:['S','S']},{dir:'row',c:['S','S','S']}]},
    {dir:'col', c:[{dir:'row',c:['S','S','S']},{dir:'row',c:['S','S']}]},
    {dir:'row', c:['S','S',{dir:'col',c:['S','S','S']}]},
    {dir:'row', c:[{dir:'col',c:['S','S','S']},'S','S']},
    {dir:'col', c:['S','S',{dir:'row',c:['S','S','S']}]}
  ],
  6: [
    {dir:'row', c:[{dir:'col',c:['S','S','S']},{dir:'col',c:['S','S','S']}]},
    {dir:'col', c:['S','S','S','S','S','S']},
    {dir:'row', c:['S','S','S','S','S','S']},
    {dir:'row', c:[{dir:'col',c:['S','S']},{dir:'col',c:['S','S']},{dir:'col',c:['S','S']}]},
    {dir:'col', c:[{dir:'row',c:['S','S']},{dir:'row',c:['S','S']},{dir:'row',c:['S','S']}]},
    {dir:'row', c:[{dir:'col',c:['S','S','S']},'S','S','S']}
  ],
  7: [
    {dir:'row', c:[{dir:'col',c:['S','S','S']},{dir:'col',c:['S','S','S']},'S']},
    {dir:'row', c:['S','S','S','S','S','S','S']},
    {dir:'col', c:[{dir:'row',c:['S','S','S']},{dir:'row',c:['S','S','S']},'S']}
  ],
  8: [
    {dir:'row', c:[{dir:'col',c:['S','S','S','S']},{dir:'col',c:['S','S','S','S']}]},
    {dir:'col', c:['S','S','S','S','S','S','S','S']},
    {dir:'row', c:['S','S','S','S','S','S','S','S']},
    {dir:'row', c:[{dir:'col',c:['S','S']},{dir:'col',c:['S','S']},{dir:'col',c:['S','S']},{dir:'col',c:['S','S']}]}
  ]
};

function renderLayoutIconNode(node){
  if(node === 'S') return '<div class="li-leaf"></div>';
  const dirClass = node.dir === 'row' ? 'li-row' : 'li-col';
  return '<div class="li-split ' + dirClass + '">' + node.c.map(renderLayoutIconNode).join('') + '</div>';
}
function renderLayoutIconHTML(node){
  if(node === 'S') return '<div class="li-icon"><div class="li-leaf"></div></div>';
  const dirClass = node.dir === 'row' ? 'li-row' : 'li-col';
  return '<div class="li-icon ' + dirClass + '">' + node.c.map(renderLayoutIconNode).join('') + '</div>';
}

function renderLayoutPicker(){
  const wrap = document.getElementById('layout-grid-list');
  if(!wrap) return;
  let html = '';
  Object.keys(LAYOUT_CONFIGS).forEach(function(groupKey){
    html += '<div class="layout-grid-row"><span class="layout-grid-num">' + groupKey + '</span><div class="layout-grid-icons">';
    LAYOUT_CONFIGS[groupKey].forEach(function(variant, vIdx){
      const isActive = (String(currentLayoutGroup) === groupKey && currentLayoutVariant === vIdx);
      html += '<div class="li-btn' + (isActive ? ' active-tool' : '') + '" onclick="applyLayout(' + groupKey + ',' + vIdx + ')" title="' + groupKey + ' pane">' + renderLayoutIconHTML(variant) + '</div>';
    });
    html += '</div></div>';
  });
  wrap.innerHTML = html;
}

function updateLayoutBtnIcon(group, variantIdx){
  const wrap = document.getElementById('layout-btn-icon');
  if(!wrap) return;
  const config = (LAYOUT_CONFIGS[group] && LAYOUT_CONFIGS[group][variantIdx]) || 'S';
  wrap.innerHTML = renderLayoutIconHTML(config);
}

/* ═══ Phase 3: Cross-pane Sync Engine ═══
   Only the toggles turned ON in the SYNC IN LAYOUT popup are ever propagated
   between panes — everything else about a pane (symbol, interval, chart
   type, indicators, drawings) stays fully independent, exactly as spec'd.
   Symbol/interval sync re-uses each pane's own selectMarket / switchTimeframe
   function, which already has an "already this value -> return" guard at the
   top, so a broadcast can never loop back into itself. Crosshair/time/date-
   range sync use a synchronous re-entrancy flag for the same reason. */

function toggleLayoutSync(key, checked){
  layoutSyncSettings[key] = checked;
  if(checked) attachAllPaneSyncSubscriptions();
}

// Live klinecharts instance for a given pane id (1, 2, or 3-8), or null if that pane hasn't been created yet.
function getPaneChartInstance(paneId){
  if(paneId === 1) return mainChartInstance || null;
  if(paneId === 2) return mainChartInstance2 || null;
  return (extraPanes[paneId] && extraPanes[paneId].chart) || null;
}

// Every OTHER pane that currently has a live chart instance — including ones parked in the
// hidden pool, so they're already in sync by the time the user brings them back into a layout.
function getSyncBroadcastTargets(sourcePaneId){
  const targets = [];
  for(let pid = 1; pid <= 8; pid++){
    if(pid !== sourcePaneId && getPaneChartInstance(pid)) targets.push(pid);
  }
  return targets;
}

function broadcastSymbolSync(sourcePaneId, symbol){
  if(!layoutSyncSettings.symbol) return;
  getSyncBroadcastTargets(sourcePaneId).forEach(pid => {
    if(pid === 1) selectMarket(symbol);
    else if(pid === 2) selectMarket2(symbol);
    else selectExtraMarket(pid, symbol);
  });
}

function broadcastIntervalSync(sourcePaneId, interval){
  if(!layoutSyncSettings.interval) return;
  getSyncBroadcastTargets(sourcePaneId).forEach(pid => {
    if(pid === 1) switchTimeframe(interval);
    else if(pid === 2) switchTimeframe2(interval);
    else switchExtraTimeframe(pid, interval);
  });
}

// Crosshair sync: klinecharts' documented executeAction('onCrosshairChange', data) replay API
// is purpose-built for mirroring one chart's crosshair onto another chart instance.
let isBroadcastingCrosshair = false;
function attachCrosshairSync(paneId, chart){
  if(!chart || chart._crosshairSyncAttached) return;
  chart._crosshairSyncAttached = true;
  chart.subscribeAction('onCrosshairChange', (data) => {
    if(!layoutSyncSettings.crosshair || isBroadcastingCrosshair) return;
    isBroadcastingCrosshair = true;
    getSyncBroadcastTargets(paneId).forEach(pid => {
      const target = getPaneChartInstance(pid);
      if(target && target.executeAction) target.executeAction('onCrosshairChange', data);
    });
    isBroadcastingCrosshair = false;
  });
}

// Time sync = scroll position (which candles are visible) matches across panes.
// Date range sync = zoom level (candle width) matches across panes.
// Kept as two independent channels so either can be toggled on its own.
//
// IMPORTANT #1: klinecharts' scrollToDataIndex/setBarSpace animate with easing over several
// hundred ms, so the target chart's OWN onScroll/onZoom keeps firing well after the call
// returns. A single shared "isBroadcasting" boolean reset on the same tick (or even a
// couple of rAFs later) is nowhere near long enough — the target's echoed events slip
// through, get treated as genuine user scrolls, and get broadcast right back to the
// source (and to other panes), each round trip drifting the visible range further.
// That feedback loop is what caused panes to run away further and further back in
// history. Fix: mute each *target* chart's own handler for a fixed window (longer than
// klinecharts' animation) right when we programmatically move it, tracked per-chart
// so unrelated panes are unaffected.
//
// IMPORTANT #2: each pane fetches its own kline data independently (own API call, own
// moment in time, own limit=300 window), so the two panes' underlying data arrays are
// NOT index-aligned even for the same symbol/interval — dataList[realFrom] in Pane 1 is
// a different real candle/time than dataList[realFrom] in Pane 2. Broadcasting the raw
// array index (scrollToDataIndex) therefore lands each pane on the "wrong" spot. Fix:
// resolve the source's anchor bar to its real timestamp and sync with scrollToTimestamp,
// which lines panes up on the exact same moment in time regardless of array offset.
const VIEWPORT_SYNC_MUTE_MS = 500;
function attachViewportSync(paneId, chart){
  if(!chart || chart._viewportSyncAttached) return;
  chart._viewportSyncAttached = true;
  chart._syncMuteUntil = 0;
  const handler = () => {
    if(Date.now() < chart._syncMuteUntil) return;
    if(!layoutSyncSettings.time && !layoutSyncSettings.dateRange) return;
    const range = chart.getVisibleRange();
    const barSpace = chart.getBarSpace();
    const dataList = chart.getDataList ? chart.getDataList() : null;
    const anchorBar = dataList && dataList[range.realFrom] ? dataList[range.realFrom] : null;
    const until = Date.now() + VIEWPORT_SYNC_MUTE_MS;
    getSyncBroadcastTargets(paneId).forEach(pid => {
      const target = getPaneChartInstance(pid);
      if(!target) return;
      target._syncMuteUntil = until;
      if(layoutSyncSettings.dateRange && target.setBarSpace) target.setBarSpace(barSpace);
      if(layoutSyncSettings.time){
        if(anchorBar && target.scrollToTimestamp) target.scrollToTimestamp(anchorBar.timestamp);
        else if(target.scrollToDataIndex) target.scrollToDataIndex(range.realFrom);
      }
    });
  };
  chart.subscribeAction('onScroll', handler);
  chart.subscribeAction('onZoom', handler);
}

// Wires up crosshair + viewport sync for every pane chart that currently exists. Safe to call
// repeatedly — each chart instance only gets attached once (tracked on the instance itself).
function attachAllPaneSyncSubscriptions(){
  for(let pid = 1; pid <= 8; pid++){
    const chart = getPaneChartInstance(pid);
    if(!chart) continue;
    attachCrosshairSync(pid, chart);
    attachViewportSync(pid, chart);
  }
}

/* ═══ Generic N-pane tree renderer (Phase 2 extended: all 1–8 layouts) ═══
   Pane 1 (#chart-panel-wrap-1) and Pane 2 (#chart-pane-2) keep their existing
   dedicated, already-tested code untouched. Panes 3–8 use ONE generic
   parametrized system below (extraPanes registry + functions taking paneId)
   instead of duplicating code 6 times. Panes not used by the current layout
   are moved into #extra-panes-pool (display:none) — never destroyed — so
   their chart instance + websocket stay alive and switching layouts back
   and forth is instant with zero re-init/leak risk. */

/* ═══ Panes 3–8: generic system (Phase 2 extended) ═══
   One registry + one set of paneId-parametrized functions instead of
   duplicating Pane 2's code six more times. Each entry in extraPanes holds
   its own chart instance, symbol, interval, chart-type and indicators —
   fully independent, same as Pane 2. */
const EXTRA_PANE_DEFAULT_SYMBOLS = { 3:'SOLUSDT', 4:'BNBUSDT', 5:'XRPUSDT', 6:'DOGEUSDT', 7:'ADAUSDT', 8:'LTCUSDT' };
const TF_LABELS = { '1m':'1m', '5m':'5m', '15m':'15m', '1h':'1H', '4h':'4H', '1d':'1D' };
const CT_LABELS = { candle_solid:'Candle', candle_stroke:'Hollow', ohlc:'OHLC', area:'Area' };
const IND_OVERLAY = { MA:true, EMA:true, BOLL:true, VOL:false, MACD:false, RSI:false, KDJ:false };
let extraPanes = {};

function buildExtraPaneDOM(paneId){
  const symbol = EXTRA_PANE_DEFAULT_SYMBOLS[paneId] || 'BTCUSDT';
  extraPanes[paneId] = { chart:null, symbol, interval:'1m', chartType:'candle_solid', indicators:{}, socket:null, initialized:false };
  const wrap = document.createElement('div');
  wrap.className = 'chart-pane-2';
  wrap.id = 'chart-pane-' + paneId;
  const tfItems = Object.keys(TF_LABELS).map(tf =>
    '<div class="chart-item' + (tf==='1m' ? ' active-tool' : '') + '" id="tf-item-' + tf + '-' + paneId + '" onclick="switchExtraTimeframe(' + paneId + ',\'' + tf + '\')">' + TF_LABELS[tf] + '</div>'
  ).join('');
  const ctItems = Object.keys(CT_LABELS).map(ct =>
    '<div class="chart-item' + (ct==='candle_solid' ? ' active-tool' : '') + '" id="ct-item-' + ct + '-' + paneId + '" onclick="switchExtraChartType(' + paneId + ',\'' + ct + '\')">' + CT_LABELS[ct] + '</div>'
  ).join('');
  const indItems = Object.keys(IND_OVERLAY).map(name =>
    '<div class="chart-item" id="ind-btn-' + name + '-' + paneId + '" onclick="toggleExtraIndicator(' + paneId + ',\'' + name + '\',' + IND_OVERLAY[name] + ')">' + name + '</div>'
  ).join('');
  wrap.innerHTML =
    '<div class="pane2-toolbar">' +
      '<div class="chart-wrap" style="width:120px;">' +
        '<button class="chart-tool-btn" id="market-select-btn-' + paneId + '" onclick="toggleExtraDropdown(' + paneId + ',\'market\')" title="Market" style="width:100%;text-align:left;font-family:\'JetBrains Mono\',monospace;font-size:12px;">' + formatSymbolLabel(symbol) + ' ▾</button>' +
        '<div class="chart-dd" id="market-dd-' + paneId + '" data-min-width="200">' +
          '<div class="chart-search-w"><input type="text" class="chart-search" id="market-search-' + paneId + '" placeholder="Search market..." oninput="filterExtraMarketList(' + paneId + ',this.value)"></div>' +
          '<div class="chart-list" id="market-list-' + paneId + '"><div style="padding:10px;color:var(--muted);font-size:12px;">Loading markets...</div></div>' +
        '</div>' +
      '</div>' +
      '<div class="chart-wrap">' +
        '<button class="cmd-pill cmd-pill-label" id="tf-select-btn-' + paneId + '" onclick="toggleExtraDropdown(' + paneId + ',\'tf\')" title="Timeframe: 1m">' +
          '<span id="tf-current-label-' + paneId + '">1m</span><svg class="pill-chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>' +
        '</button>' +
        '<div class="chart-dd" id="tf-dd-' + paneId + '" data-min-width="140"><div class="chart-list">' + tfItems + '</div></div>' +
      '</div>' +
      '<div class="chart-wrap">' +
        '<button class="cmd-pill cmd-pill-label" id="ct-select-btn-' + paneId + '" onclick="toggleExtraDropdown(' + paneId + ',\'ct\')" title="Chart type: Candle">' +
          '<span class="ct-icon-wrap" id="ct-current-icon-' + paneId + '">' + CHART_TYPE_ICONS.candle_solid + '</span><svg class="pill-chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>' +
        '</button>' +
        '<div class="chart-dd" id="ct-dd-' + paneId + '" data-min-width="150"><div class="chart-list">' + ctItems + '</div></div>' +
      '</div>' +
      '<div class="chart-wrap">' +
        '<button class="cmd-pill" id="ind-select-btn-' + paneId + '" onclick="toggleExtraDropdown(' + paneId + ',\'ind\')" title="Indicators"><span class="fx-icon">ƒx</span></button>' +
        '<div class="chart-dd" id="ind-dd-' + paneId + '" data-min-width="150"><div class="chart-list">' + indItems + '</div></div>' +
      '</div>' +
    '</div>' +
    '<div class="pane2-chart-holder"><div id="klineChart' + paneId + '" style="width:100%;height:100%;background:var(--bg2);"></div></div>';
  return wrap;
}

async function initExtraChart(paneId){
  const st = extraPanes[paneId];
  if(!st || st.initialized) return;
  st.initialized = true;
  const container = document.getElementById('klineChart' + paneId);
  if(!container) return;
  // If symbol sync is ON, a newly created pane should mirror Pane 1's current symbol
  // instead of falling back to its own hardcoded default.
  if(layoutSyncSettings.symbol && st.symbol !== currentSymbol){
    st.symbol = currentSymbol;
    const btn = document.getElementById('market-select-btn-' + paneId);
    if(btn) btn.textContent = formatSymbolLabel(currentSymbol) + ' ▾';
  }
  try{
    if(typeof klinecharts === 'undefined') throw new Error('klinecharts library not loaded');
    st.chart = klinecharts.init('klineChart' + paneId);
    if(!st.chart) throw new Error('klinecharts.init() returned null for pane ' + paneId);
    st.chart.setStyles({
      grid: { show:true, horizontal:{color:'#2a2a2a'}, vertical:{color:'#2a2a2a'} },
      candle: { bar: { upColor:'#4CAF7D', downColor:'#E05252', noChangeColor:'#888888' } }
    });
    attachCrosshairSync(paneId, st.chart);
    attachViewportSync(paneId, st.chart);
    await loadExtraChartInterval(paneId, st.interval);
    const list = await loadBinanceMarkets();
    renderExtraMarketList(paneId, list);
  }catch(err){
    container.innerHTML = '<div style="padding:20px;color:#E05252;font-family:monospace;font-size:13px;white-space:pre-wrap;">CHART ERROR:\n' + err.message + '</div>';
    console.error('Pane ' + paneId + ' chart init failed:', err);
  }
}

async function loadExtraChartInterval(paneId, interval){
  const st = extraPanes[paneId];
  if(!st || !st.chart) return;
  const res = await fetch('https://api.binance.com/api/v3/klines?symbol=' + st.symbol + '&interval=' + interval + '&limit=300');
  if(!res.ok) throw new Error('Binance API fetch failed: ' + res.status);
  const raw = await res.json();
  const data = raw.map(k => ({
    timestamp: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
  }));
  st.chart.applyNewData(data);
  if(st.socket) st.socket.close();
  st.socket = new WebSocket('wss://stream.binance.com:9443/ws/' + st.symbol.toLowerCase() + '@kline_' + interval);
  st.socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const k = msg.k;
    st.chart.updateData({
      timestamp: k.t, open: parseFloat(k.o), high: parseFloat(k.h),
      low: parseFloat(k.l), close: parseFloat(k.c), volume: parseFloat(k.v)
    });
    st.latestPrice = parseFloat(k.c);
    if(activePaneId === paneId) updateLiqPreview();
  };
  st.interval = interval;
}

async function switchExtraTimeframe(paneId, tf){
  closeCockpitDropdown(document.getElementById('tf-dd-' + paneId));
  const st = extraPanes[paneId];
  if(!st || !st.chart || tf === st.interval) return;
  document.querySelectorAll('.chart-item[id^="tf-item-"][id$="-' + paneId + '"]').forEach(b => b.classList.remove('active-tool'));
  const activeItem = document.getElementById('tf-item-' + tf + '-' + paneId);
  if(activeItem) activeItem.classList.add('active-tool');
  const selectBtn = document.getElementById('tf-select-btn-' + paneId);
  const labelText = activeItem ? activeItem.textContent : tf;
  if(selectBtn) selectBtn.title = 'Timeframe: ' + labelText;
  const labelEl = document.getElementById('tf-current-label-' + paneId);
  if(labelEl) labelEl.textContent = labelText;
  try{ await loadExtraChartInterval(paneId, tf); }
  catch(err){ console.error('Pane ' + paneId + ' timeframe switch failed:', err); }
  broadcastIntervalSync(paneId, tf);
}

function switchExtraChartType(paneId, type){
  closeCockpitDropdown(document.getElementById('ct-dd-' + paneId));
  const st = extraPanes[paneId];
  if(!st || !st.chart || type === st.chartType) return;
  st.chart.setStyles({ candle: { type } });
  document.querySelectorAll('.chart-item[id^="ct-item-"][id$="-' + paneId + '"]').forEach(b => b.classList.remove('active-tool'));
  const activeItem = document.getElementById('ct-item-' + type + '-' + paneId);
  if(activeItem) activeItem.classList.add('active-tool');
  const selectBtn = document.getElementById('ct-select-btn-' + paneId);
  if(selectBtn) selectBtn.title = 'Chart type: ' + (activeItem ? activeItem.textContent : type);
  const iconEl = document.getElementById('ct-current-icon-' + paneId);
  if(iconEl) iconEl.innerHTML = CHART_TYPE_ICONS[type] || CHART_TYPE_ICONS.candle_solid;
  st.chartType = type;
}

function renderExtraMarketList(paneId, list){
  const el = document.getElementById('market-list-' + paneId);
  if(!el) return;
  if(!list.length){ el.innerHTML = '<div style="padding:10px;color:var(--muted);font-size:12px;">No match</div>'; return; }
  el.innerHTML = list.map(sym =>
    '<div class="chart-item" onclick="selectExtraMarket(' + paneId + ',\'' + sym + '\')"><span>' + formatSymbolLabel(sym) + '</span><span class="chart-item-cat">Binance</span></div>'
  ).join('');
}

function filterExtraMarketList(paneId, val){
  if(!binanceMarkets) return;
  const v = val.trim().toUpperCase();
  renderExtraMarketList(paneId, v ? binanceMarkets.filter(s => s.includes(v)) : binanceMarkets);
}

async function selectExtraMarket(paneId, symbol){
  closeCockpitDropdown(document.getElementById('market-dd-' + paneId));
  const st = extraPanes[paneId];
  if(!st || !st.chart || symbol === st.symbol) return;
  st.symbol = symbol;
  const label = formatSymbolLabel(symbol);
  const btn = document.getElementById('market-select-btn-' + paneId);
  if(btn) btn.textContent = label + ' ▾';
  try{ await loadExtraChartInterval(paneId, st.interval); }
  catch(err){ console.error('Pane ' + paneId + ' symbol switch failed:', err); }
  broadcastSymbolSync(paneId, symbol);
}

function toggleExtraIndicator(paneId, name, overlayOnCandle){
  const st = extraPanes[paneId];
  if(!st || !st.chart) return;
  const btn = document.getElementById('ind-btn-' + name + '-' + paneId);
  if(st.indicators[name]){
    st.chart.removeIndicator(st.indicators[name], name);
    delete st.indicators[name];
    if(btn) btn.classList.remove('active-tool');
  } else {
    let pId;
    if(overlayOnCandle) pId = st.chart.createIndicator(name, true, {id:'candle_pane'});
    else pId = st.chart.createIndicator(name);
    st.indicators[name] = pId;
    if(btn) btn.classList.add('active-tool');
  }
}

function toggleExtraDropdown(paneId, kind){
  const ddId = kind + '-dd-' + paneId;
  const btnId = kind + '-select-btn-' + paneId;
  const dd = document.getElementById(ddId);
  const btn = document.getElementById(btnId);
  if(!dd || !btn) return;
  if(dd.classList.contains('open')){ closeCockpitDropdown(dd); return; }
  closeAllCockpitDropdowns();
  closeAllPane2Dropdowns();
  closeLayoutDropdowns();
  document.querySelectorAll('.chart-dd.open').forEach(el => { if(el !== dd) closeCockpitDropdown(el); });
  if(!dd._origParent){ dd._origParent = dd.parentNode; dd._origNext = dd.nextSibling; }
  document.body.appendChild(dd);
  positionCockpitDropdown(dd, btn);
  dd.classList.add('open');
  if(kind === 'market'){
    const s = document.getElementById('market-search-' + paneId);
    if(s) setTimeout(() => s.focus(), 50);
  }
}

// Generic click-outside-to-close + reposition for ALL extra-pane dropdowns (id pattern
// "{kind}-dd-{paneId}" where paneId >= 3 — panes 1/2 have their own dedicated listeners).
document.addEventListener('click', (e) => {
  document.querySelectorAll('.chart-dd.open').forEach(dd => {
    const m = dd.id.match(/^([a-z]+)-dd-(\d+)$/);
    if(!m || parseInt(m[2], 10) < 3) return;
    const btn = document.getElementById(m[1] + '-select-btn-' + m[2]);
    if(dd.contains(e.target)) return;
    if(btn && (btn === e.target || btn.contains(e.target))) return;
    closeCockpitDropdown(dd);
  });
});
function repositionOpenExtraDropdowns(){
  document.querySelectorAll('.chart-dd.open').forEach(dd => {
    const m = dd.id.match(/^([a-z]+)-dd-(\d+)$/);
    if(!m || parseInt(m[2], 10) < 3) return;
    const btn = document.getElementById(m[1] + '-select-btn-' + m[2]);
    if(btn) positionCockpitDropdown(dd, btn);
  });
}
window.addEventListener('scroll', repositionOpenExtraDropdowns, true);
window.addEventListener('resize', repositionOpenExtraDropdowns);

function assignLeaves(node, counter){
  if(node === 'S'){
    counter.n++;
    return getPaneElement(counter.n);
  }
  const div = document.createElement('div');
  div.className = 'split-' + (node.dir === 'row' ? 'row' : 'col');
  node.c.forEach(child => div.appendChild(assignLeaves(child, counter)));
  return div;
}

function getPaneElement(idx){
  if(idx === 1) return document.getElementById('chart-panel-wrap-1');
  if(idx === 2){
    const el = document.getElementById('chart-pane-2');
    if(el) el.style.display = 'flex';
    return el;
  }
  let el = document.getElementById('chart-pane-' + idx);
  if(!el) el = buildExtraPaneDOM(idx);
  el.style.display = 'flex';
  return el;
}

function applyLayout(group, variantIdx){
  const config = LAYOUT_CONFIGS[group] && LAYOUT_CONFIGS[group][variantIdx];
  if(!config) return;
  currentLayoutGroup = group;
  currentLayoutVariant = variantIdx;
  const stack = document.getElementById('chart-panes-stack');
  const pool = document.getElementById('extra-panes-pool');
  const layoutBtn = document.getElementById('layout-select-btn');
  if(!stack || !pool) return;

  // Park every pane beyond this layout's count into the hidden pool FIRST —
  // before building the new tree — so nothing gets wiped by accident.
  for(let pid = 2; pid <= 8; pid++){
    if(pid > group){
      const el = document.getElementById('chart-pane-' + pid);
      if(el) pool.appendChild(el);
    }
  }

  // If the layout just shrank and hid the currently-active pane, Order Book +
  // Trade Terminal fall back to Pane 1 rather than staying bound to a hidden pane.
  if(activePaneId > group) setActivePane(1);

  const counter = { n: 0 };
  const rootEl = assignLeaves(config, counter);
  stack.innerHTML = '';
  stack.appendChild(rootEl);

  if(layoutBtn) layoutBtn.classList.toggle('active-tool', group > 1);
  updateLayoutBtnIcon(group, variantIdx);
  renderLayoutPicker();
  closeLayoutDropdowns();
  highlightActivePane();

  if(group >= 2){
    if(!pane2Initialized) initChart2();
    else if(layoutSyncSettings.symbol && currentSymbol2 !== currentSymbol) selectMarket2(currentSymbol);
  }
  for(let pid = 3; pid <= group; pid++){
    if(extraPanes[pid] && !extraPanes[pid].initialized) initExtraChart(pid);
    else if(extraPanes[pid] && layoutSyncSettings.symbol && extraPanes[pid].symbol !== currentSymbol) selectExtraMarket(pid, currentSymbol);
  }

  setTimeout(() => {
    if(mainChartInstance && mainChartInstance.resize) mainChartInstance.resize();
    if(mainChartInstance2 && mainChartInstance2.resize) mainChartInstance2.resize();
    for(let pid = 3; pid <= 8; pid++){
      if(extraPanes[pid] && extraPanes[pid].chart && extraPanes[pid].chart.resize) extraPanes[pid].chart.resize();
    }
    window.dispatchEvent(new Event('resize'));
  }, 60);
}

function positionLayoutDropdowns(){
  const btn = document.getElementById('layout-select-btn');
  const syncDd = document.getElementById('layout-sync-dd');
  const gridDd = document.getElementById('layout-grid-dd');
  if(!btn || !syncDd || !gridDd) return;
  const r = btn.getBoundingClientRect();
  const width = Math.max(r.width, 300);
  let left = r.left;
  if(left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
  if(left < 8) left = 8;
  syncDd.style.left = left + 'px';
  syncDd.style.width = width + 'px';
  syncDd.style.top = (r.bottom + 6) + 'px';
  const syncHeight = syncDd.offsetHeight;
  gridDd.style.left = left + 'px';
  gridDd.style.width = width + 'px';
  gridDd.style.top = (r.bottom + 6 + syncHeight + 8) + 'px';
}

function openLayoutDropdowns(){
  const btn = document.getElementById('layout-select-btn');
  const syncDd = document.getElementById('layout-sync-dd');
  const gridDd = document.getElementById('layout-grid-dd');
  if(!btn || !syncDd || !gridDd) return;
  closeAllCockpitDropdowns();
  [syncDd, gridDd].forEach(dd => {
    if(!dd._origParent){ dd._origParent = dd.parentNode; dd._origNext = dd.nextSibling; }
    document.body.appendChild(dd);
    dd.style.position = 'fixed';
    dd.style.right = 'auto';
    dd.classList.add('open');
  });
  positionLayoutDropdowns();
}

function closeLayoutDropdowns(){
  ['layout-sync-dd','layout-grid-dd'].forEach(id => {
    const dd = document.getElementById(id);
    if(!dd || !dd.classList.contains('open')) return;
    dd.classList.remove('open');
    if(dd._origParent){
      if(dd._origNext && dd._origNext.parentNode === dd._origParent) dd._origParent.insertBefore(dd, dd._origNext);
      else dd._origParent.appendChild(dd);
    }
    dd.style.position = ''; dd.style.top = ''; dd.style.left = ''; dd.style.width = ''; dd.style.right = '';
  });
}

function toggleLayoutDropdown(){
  const syncDd = document.getElementById('layout-sync-dd');
  if(syncDd && syncDd.classList.contains('open')){ closeLayoutDropdowns(); return; }
  openLayoutDropdowns();
  renderLayoutPicker();
}

document.addEventListener('click', (e) => {
  const syncDd = document.getElementById('layout-sync-dd');
  const gridDd = document.getElementById('layout-grid-dd');
  const btn = document.getElementById('layout-select-btn');
  if(!syncDd || !syncDd.classList.contains('open')) return;
  if(syncDd.contains(e.target) || (gridDd && gridDd.contains(e.target))) return;
  if(btn && (btn === e.target || btn.contains(e.target))) return;
  closeLayoutDropdowns();
});
window.addEventListener('scroll', () => {
  const syncDd = document.getElementById('layout-sync-dd');
  if(syncDd && syncDd.classList.contains('open')) positionLayoutDropdowns();
}, true);
window.addEventListener('resize', () => {
  const syncDd = document.getElementById('layout-sync-dd');
  if(syncDd && syncDd.classList.contains('open')) positionLayoutDropdowns();
});

function toggleIndicator(name, overlayOnCandle){
  const btn = document.getElementById('ind-btn-'+name);
  if(activeIndicators[name]){
    mainChartInstance.removeIndicator(activeIndicators[name], name);
    delete activeIndicators[name];
    if(btn) btn.classList.remove('active-tool');
  } else {
    let paneId;
    if(overlayOnCandle){
      paneId = mainChartInstance.createIndicator(name, true, {id:'candle_pane'});
    } else {
      paneId = mainChartInstance.createIndicator(name);
    }
    activeIndicators[name] = paneId;
    if(btn) btn.classList.add('active-tool');
  }
}

function useDrawTool(name){
  mainChartInstance.createOverlay(name);
}

function clearDrawings(){
  mainChartInstance.removeOverlay();
}

/* ═══ Chart Tabs — Chrome-style workspace tabs (Pane 1 only) ═══
   A "tab" is a saved workspace config: {id, symbol, interval, chartType, indicators}.
   Only the ACTIVE tab's config is ever live in mainChartInstance/klineSocket — this
   is what keeps tab switching smooth (one chart engine, one socket, reused), while
   still giving every tab its own independent, fully-remembered state. */

function getChartTabIndex(tabId){
  return chartTabs.findIndex(t => t.id === tabId);
}

// Pulls the live Pane-1 state (currentSymbol/currentInterval/currentChartType/
// activeIndicators) back into the active tab's saved record. Called right before
// switching away from a tab, so nothing the user changed via the cockpit dropdowns
// is ever lost.
function snapshotActiveChartTab(){
  const idx = getChartTabIndex(activeChartTabId);
  if(idx === -1) return;
  chartTabs[idx].symbol = currentSymbol;
  chartTabs[idx].interval = currentInterval;
  chartTabs[idx].chartType = currentChartType;
  chartTabs[idx].indicators = Object.keys(activeIndicators);
}

function renderChartTabs(){
  const list = document.getElementById('chart-tabs-list');
  if(!list) return;
  const canClose = chartTabs.length > 1;
  list.innerHTML = chartTabs.map(t => {
    const label = formatSymbolLabel(t.symbol);
    const isActive = t.id === activeChartTabId;
    const closeBtn = canClose
      ? '<span class="ctab-close" onclick="event.stopPropagation();closeChartTab(' + t.id + ')" title="Close tab">✕</span>'
      : '';
    return '<div class="chart-tab-item' + (isActive ? ' active' : '') + '" data-tab-id="' + t.id + '" onclick="switchChartTab(' + t.id + ')">'
      + '<span class="ctab-dot"></span><span class="ctab-label">' + label + '</span>' + closeBtn
      + '</div>';
  }).join('');
}

// Restores a tab's saved config into the live Pane-1 chart engine: symbol, chart
// type, timeframe, and indicators, plus every cockpit UI label/active-state that
// goes with them — mirrors exactly what selectMarket()/switchTimeframe()/
// switchChartType()/toggleIndicator() already do individually, just all at once.
async function applyChartTabState(tab){
  if(!mainChartInstance) return;

  // Clear indicators from the outgoing tab before drawing the incoming tab's set.
  Object.keys(activeIndicators).forEach(name => {
    mainChartInstance.removeIndicator(activeIndicators[name], name);
    const btn = document.getElementById('ind-btn-' + name);
    if(btn) btn.classList.remove('active-tool');
  });
  activeIndicators = {};

  // Symbol
  currentSymbol = tab.symbol;
  const label = formatSymbolLabel(currentSymbol);
  const marketBtn = document.getElementById('market-select-btn');
  if(marketBtn) marketBtn.textContent = label + ' ▾';
  const nameEl = document.querySelector('#chart-symbol-overlay .csym-name');
  if(nameEl) nameEl.innerHTML = label + ' <span class="csym-sub">· Binance</span>';
  prevMaxOverlayPrice = null;

  // Chart type
  currentChartType = tab.chartType;
  mainChartInstance.setStyles({ candle: { type: currentChartType } });
  document.querySelectorAll('.chart-item[id^="ct-item-"]').forEach(b => b.classList.remove('active-tool'));
  const ctItem = document.getElementById('ct-item-' + currentChartType);
  if(ctItem) ctItem.classList.add('active-tool');
  const ctSelectBtn = document.getElementById('ct-select-btn');
  if(ctSelectBtn) ctSelectBtn.title = 'Chart type: ' + (ctItem ? ctItem.textContent : currentChartType);
  const ctIconEl = document.getElementById('ct-current-icon');
  if(ctIconEl) ctIconEl.innerHTML = CHART_TYPE_ICONS[currentChartType] || CHART_TYPE_ICONS.candle_solid;

  // Timeframe label (loadChartInterval below does the actual data fetch + socket)
  currentInterval = tab.interval;
  document.querySelectorAll('.chart-item[id^="tf-item-"]').forEach(b => b.classList.remove('active-tool'));
  const tfItem = document.getElementById('tf-item-' + currentInterval);
  if(tfItem) tfItem.classList.add('active-tool');
  const tfSelectBtn = document.getElementById('tf-select-btn');
  const tfLabelText = tfItem ? tfItem.textContent : currentInterval;
  if(tfSelectBtn) tfSelectBtn.title = 'Timeframe: ' + tfLabelText;
  const tfLabelEl = document.getElementById('tf-current-label');
  if(tfLabelEl) tfLabelEl.textContent = tfLabelText;

  try{
    await loadChartInterval(currentInterval);
    connectOrderBook(currentSymbol);
    updateTradingWorkspaceLabel(currentSymbol);
  }catch(err){ console.error('Chart tab switch failed:', err); }

  // Indicators
  (tab.indicators || []).forEach(name => {
    const overlay = CHART_TAB_INDICATOR_OVERLAY[name];
    const paneId = overlay
      ? mainChartInstance.createIndicator(name, true, {id:'candle_pane'})
      : mainChartInstance.createIndicator(name);
    activeIndicators[name] = paneId;
    const btn = document.getElementById('ind-btn-' + name);
    if(btn) btn.classList.add('active-tool');
  });

  // Keep split-screen sync (if the user has it toggled on) consistent with tab switches.
  broadcastSymbolSync(1, currentSymbol);
  broadcastIntervalSync(1, currentInterval);
}

// New tab always inherits the symbol of whichever tab is active right now —
// i.e. the tab the user was looking at the moment they clicked "+".
async function addChartTab(){
  closeAllCockpitDropdowns();
  const inheritedSymbol = currentSymbol; // symbol of whichever tab is active right now
  const tab = { id: nextChartTabId++, symbol: inheritedSymbol, interval: '1m', chartType: 'candle_solid', indicators: [] };
  chartTabs.push(tab);
  snapshotActiveChartTab(); // persist the outgoing tab's live state before we move activeChartTabId
  activeChartTabId = tab.id;
  renderChartTabs();
  await applyChartTabState(tab);
}

async function switchChartTab(tabId){
  if(tabId === activeChartTabId) return;
  const idx = getChartTabIndex(tabId);
  if(idx === -1) return;
  closeAllCockpitDropdowns();
  snapshotActiveChartTab();
  activeChartTabId = tabId;
  renderChartTabs();
  await applyChartTabState(chartTabs[idx]);
}

async function closeChartTab(tabId){
  if(chartTabs.length <= 1) return; // always keep at least one tab open
  const idx = getChartTabIndex(tabId);
  if(idx === -1) return;
  const wasActive = tabId === activeChartTabId;
  chartTabs.splice(idx, 1);
  if(wasActive){
    const newIdx = Math.min(idx, chartTabs.length - 1);
    activeChartTabId = chartTabs[newIdx].id;
    renderChartTabs();
    await applyChartTabState(chartTabs[newIdx]);
  } else {
    renderChartTabs();
  }
}

/* ═══ Pane 2: independent chart instance (Phase 2) ═══
   Mirrors Pane 1's initMainChart/loadChartInterval/selectMarket/switchTimeframe/
   switchChartType/toggleIndicator, but fully separate — own klinecharts instance,
   own symbol/interval/indicator state, own dropdowns. Lazy-inited the first time
   applyLayout() shows 2 panes, then kept alive (never disposed) so toggling back
   to 1 pane and forward again doesn't recreate/leak — it just shows/hides. */

async function initChart2(){
  if(pane2Initialized) return;
  pane2Initialized = true;
  const container = document.getElementById('klineChart2');
  if(!container) return;
  // If symbol sync is ON, a newly created pane should mirror Pane 1's current symbol
  // instead of falling back to its own hardcoded default (previously always ETHUSDT).
  if(layoutSyncSettings.symbol) currentSymbol2 = currentSymbol;
  try{
    if(typeof klinecharts === 'undefined') throw new Error('klinecharts library not loaded');
    mainChartInstance2 = klinecharts.init('klineChart2');
    if(!mainChartInstance2) throw new Error('klinecharts.init() returned null for Pane 2');
    mainChartInstance2.setStyles({
      grid: { show:true, horizontal:{color:'#2a2a2a'}, vertical:{color:'#2a2a2a'} },
      candle: { bar: { upColor:'#4CAF7D', downColor:'#E05252', noChangeColor:'#888888' } }
    });
    attachCrosshairSync(2, mainChartInstance2);
    attachViewportSync(2, mainChartInstance2);
    await loadChartInterval2(currentInterval2);
    // Order Book/Trading panel intentionally NOT connected here — stays bound to Pane 1 until Phase 4.
    const list = await loadBinanceMarkets();
    renderMarketList2(list);
  }catch(err){
    container.innerHTML = '<div style="padding:20px;color:#E05252;font-family:monospace;font-size:13px;white-space:pre-wrap;">CHART ERROR:\n' + err.message + '</div>';
    console.error('Pane 2 chart init failed:', err);
  }
}

async function loadChartInterval2(interval){
  const res = await fetch('https://api.binance.com/api/v3/klines?symbol=' + currentSymbol2 + '&interval=' + interval + '&limit=300');
  if(!res.ok) throw new Error('Binance API fetch failed: ' + res.status);
  const raw = await res.json();
  const data = raw.map(k => ({
    timestamp: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
  }));
  mainChartInstance2.applyNewData(data);

  if(klineSocket2) klineSocket2.close();
  klineSocket2 = new WebSocket('wss://stream.binance.com:9443/ws/' + currentSymbol2.toLowerCase() + '@kline_' + interval);
  klineSocket2.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const k = msg.k;
    mainChartInstance2.updateData({
      timestamp: k.t, open: parseFloat(k.o), high: parseFloat(k.h),
      low: parseFloat(k.l), close: parseFloat(k.c), volume: parseFloat(k.v)
    });
    latestPrice2 = parseFloat(k.c);
    if(activePaneId === 2) updateLiqPreview();
  };
  currentInterval2 = interval;
}

async function switchTimeframe2(tf){
  closeCockpitDropdown(document.getElementById('tf-dd-2'));
  if(tf === currentInterval2 || !mainChartInstance2) return;
  document.querySelectorAll('.chart-item[id^="tf-item-"][id$="-2"]').forEach(b => b.classList.remove('active-tool'));
  const activeItem = document.getElementById('tf-item-' + tf + '-2');
  if(activeItem) activeItem.classList.add('active-tool');
  const selectBtn = document.getElementById('tf-select-btn-2');
  const labelText = activeItem ? activeItem.textContent : tf;
  if(selectBtn) selectBtn.title = 'Timeframe: ' + labelText;
  const labelEl = document.getElementById('tf-current-label-2');
  if(labelEl) labelEl.textContent = labelText;
  try{ await loadChartInterval2(tf); }
  catch(err){ console.error('Pane 2 timeframe switch failed:', err); }
  broadcastIntervalSync(2, tf);
}

function switchChartType2(type){
  closeCockpitDropdown(document.getElementById('ct-dd-2'));
  if(!mainChartInstance2 || type === currentChartType2) return;
  mainChartInstance2.setStyles({ candle: { type } });
  document.querySelectorAll('.chart-item[id^="ct-item-"][id$="-2"]').forEach(b => b.classList.remove('active-tool'));
  const activeItem = document.getElementById('ct-item-' + type + '-2');
  if(activeItem) activeItem.classList.add('active-tool');
  const selectBtn = document.getElementById('ct-select-btn-2');
  if(selectBtn) selectBtn.title = 'Chart type: ' + (activeItem ? activeItem.textContent : type);
  const iconEl = document.getElementById('ct-current-icon-2');
  if(iconEl) iconEl.innerHTML = CHART_TYPE_ICONS[type] || CHART_TYPE_ICONS.candle_solid;
  currentChartType2 = type;
}

function renderMarketList2(list){
  const el = document.getElementById('market-list-2');
  if(!el) return;
  if(!list.length){ el.innerHTML = '<div style="padding:10px;color:var(--muted);font-size:12px;">No match</div>'; return; }
  el.innerHTML = list.map(sym =>
    '<div class="chart-item" onclick="selectMarket2(\'' + sym + '\')"><span>' + formatSymbolLabel(sym) + '</span><span class="chart-item-cat">Binance</span></div>'
  ).join('');
}

function filterMarketList2(val){
  if(!binanceMarkets) return;
  const v = val.trim().toUpperCase();
  renderMarketList2(v ? binanceMarkets.filter(s => s.includes(v)) : binanceMarkets);
}

async function selectMarket2(symbol){
  closeCockpitDropdown(document.getElementById('market-dd-2'));
  if(symbol === currentSymbol2 || !mainChartInstance2) return;
  currentSymbol2 = symbol;
  const label = formatSymbolLabel(symbol);
  const btn = document.getElementById('market-select-btn-2');
  if(btn) btn.textContent = label + ' ▾';
  try{ await loadChartInterval2(currentInterval2); }
  catch(err){ console.error('Pane 2 symbol switch failed:', err); }
  broadcastSymbolSync(2, symbol);
}

function toggleIndicator2(name, overlayOnCandle){
  if(!mainChartInstance2) return;
  const btn = document.getElementById('ind-btn-' + name + '-2');
  if(activeIndicators2[name]){
    mainChartInstance2.removeIndicator(activeIndicators2[name], name);
    delete activeIndicators2[name];
    if(btn) btn.classList.remove('active-tool');
  } else {
    let paneId;
    if(overlayOnCandle){
      paneId = mainChartInstance2.createIndicator(name, true, {id:'candle_pane'});
    } else {
      paneId = mainChartInstance2.createIndicator(name);
    }
    activeIndicators2[name] = paneId;
    if(btn) btn.classList.add('active-tool');
  }
}

// Pane 2 dropdowns reuse the same generic portal helpers (positionCockpitDropdown /
// closeCockpitDropdown take a dd/btn pair, they're not hardcoded to Pane 1's ids) —
// just a separate id list + separate open/close-all wrappers so Pane 1's dropdown
// system is never touched.
const PANE2_DD_IDS = ['market-dd-2','tf-dd-2','ct-dd-2','ind-dd-2'];

function closeAllPane2Dropdowns(exceptId){
  PANE2_DD_IDS.forEach(id => {
    if(id === exceptId) return;
    closeCockpitDropdown(document.getElementById(id));
  });
}

function openPane2Dropdown(ddId, btnId){
  const dd = document.getElementById(ddId);
  const btn = document.getElementById(btnId);
  if(!dd || !btn) return;
  closeAllPane2Dropdowns(ddId);
  closeAllCockpitDropdowns();
  closeLayoutDropdowns();
  if(!dd._origParent){ dd._origParent = dd.parentNode; dd._origNext = dd.nextSibling; }
  document.body.appendChild(dd);
  positionCockpitDropdown(dd, btn);
  dd.classList.add('open');
}

function toggleMarketDropdown2(){
  const dd = document.getElementById('market-dd-2');
  if(!dd) return;
  if(dd.classList.contains('open')){ closeCockpitDropdown(dd); return; }
  openPane2Dropdown('market-dd-2', 'market-select-btn-2');
  const s = document.getElementById('market-search-2');
  if(s) setTimeout(() => s.focus(), 50);
}
function toggleTfDropdown2(){
  const dd = document.getElementById('tf-dd-2');
  if(!dd) return;
  if(dd.classList.contains('open')){ closeCockpitDropdown(dd); return; }
  openPane2Dropdown('tf-dd-2', 'tf-select-btn-2');
}
function toggleCtDropdown2(){
  const dd = document.getElementById('ct-dd-2');
  if(!dd) return;
  if(dd.classList.contains('open')){ closeCockpitDropdown(dd); return; }
  openPane2Dropdown('ct-dd-2', 'ct-select-btn-2');
}
function toggleIndDropdown2(){
  const dd = document.getElementById('ind-dd-2');
  if(!dd) return;
  if(dd.classList.contains('open')){ closeCockpitDropdown(dd); return; }
  openPane2Dropdown('ind-dd-2', 'ind-select-btn-2');
}

document.addEventListener('click', (e) => {
  PANE2_DD_IDS.forEach(id => {
    const dd = document.getElementById(id);
    if(!dd || !dd.classList.contains('open')) return;
    const btnId = id.replace(/-dd-2$/, '-select-btn-2');
    const btn = document.getElementById(btnId);
    if(dd.contains(e.target)) return;
    if(btn && (btn === e.target || btn.contains(e.target))) return;
    closeCockpitDropdown(dd);
  });
});
function repositionOpenPane2Dropdowns(){
  PANE2_DD_IDS.forEach(id => {
    const dd = document.getElementById(id);
    if(!dd || !dd.classList.contains('open')) return;
    const btnId = id.replace(/-dd-2$/, '-select-btn-2');
    const btn = document.getElementById(btnId);
    if(btn) positionCockpitDropdown(dd, btn);
  });
}
window.addEventListener('scroll', repositionOpenPane2Dropdowns, true);
window.addEventListener('resize', repositionOpenPane2Dropdowns);

// ══════════════════════════════════════
// PHASE 4: Active-pane binding for Order Book + Trade Terminal
// Whichever pane the user last tapped is the "active" one — its symbol/price
// feeds the Order Book and Trade Terminal, so trades always go to the market
// actually visible on screen. Defaults to Pane 1 and stays there until the
// user taps a different pane (split screen or not).
// ══════════════════════════════════════
let activePaneId = 1;

function getPaneSymbol(paneId){
  if(paneId === 1) return currentSymbol;
  if(paneId === 2) return currentSymbol2;
  return (extraPanes[paneId] && extraPanes[paneId].symbol) || null;
}

function getPaneLivePrice(paneId){
  if(paneId === 1) return latestPrice;
  if(paneId === 2) return latestPrice2;
  return (extraPanes[paneId] && extraPanes[paneId].latestPrice) || null;
}

function highlightActivePane(){
  document.querySelectorAll('.chart-panel-wrap.active-pane, .chart-pane-2.active-pane')
    .forEach(el => el.classList.remove('active-pane'));
  const el = activePaneId === 1 ? document.getElementById('chart-panel-wrap-1') : document.getElementById('chart-pane-' + activePaneId);
  if(el) el.classList.add('active-pane');
}

function updateTradingWorkspaceLabel(symbol){
  const label = symbol ? formatSymbolLabel(symbol) : '';
  const obLabel = document.getElementById('ob-active-symbol');
  if(obLabel) obLabel.textContent = label;
  const termLabel = document.getElementById('term-active-symbol');
  if(termLabel) termLabel.textContent = label;
}

// Called on tapping any pane. Re-points Order Book + Trade Terminal at that
// pane's market — no-op if the pane doesn't exist or is already active.
function setActivePane(paneId){
  if(paneId === activePaneId || !getPaneChartInstance(paneId)) return;
  activePaneId = paneId;
  highlightActivePane();
  const symbol = getPaneSymbol(paneId);
  if(symbol){
    connectOrderBook(symbol);
    updateTradingWorkspaceLabel(symbol);
  }
  updateLiqPreview();
}

// Event delegation so newly-created panes (split screen) are covered automatically —
// #chart-panes-stack itself is never replaced, only its children are re-parented.
// Uses capture-phase pointerdown (not bubble-phase click) because klinecharts attaches
// its own pointer handlers directly on the chart canvas for pan/zoom/drag, which stops
// the event from bubbling back up to us — that's why tapping the chart body itself did
// nothing while tapping toolbar buttons (outside the canvas) worked. Capture phase runs
// top-down BEFORE the canvas ever sees the event, so nothing downstream can block it.
document.addEventListener('DOMContentLoaded', () => {
  const stack = document.getElementById('chart-panes-stack');
  if(!stack) return;
  stack.addEventListener('pointerdown', (e) => {
    const paneEl = e.target.closest('#chart-panel-wrap-1, .chart-pane-2');
    if(!paneEl) return;
    const pid = paneEl.id === 'chart-panel-wrap-1' ? 1 : parseInt(paneEl.id.replace('chart-pane-',''), 10);
    if(pid) setActivePane(pid);
  }, true);
});

function connectOrderBook(symbol){
  if(obSocket){ obSocket.close(); obSocket = null; }
  obSocket = new WebSocket('wss://stream.binance.com:9443/ws/' + symbol.toLowerCase() + '@depth20@100ms');
  obSocket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    renderOrderBook(data.bids, data.asks);
  };
  obSocket.onerror = () => {
    const c = document.getElementById('orderBookBody');
    if(c) c.innerHTML = '<div style="color:var(--red);font-size:12px;padding:10px;">Order book failed to load</div>';
  };
}
function initOrderBook(){
  connectOrderBook(currentSymbol);
  highlightActivePane();
  updateTradingWorkspaceLabel(currentSymbol);
}

// ══════════════════════════════════════
// MARKET OVERVIEW — live Binance prices (fixed watchlist, independent of chart symbol)
// ══════════════════════════════════════
const MARKET_OVERVIEW_SYMBOLS = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'];
function initMarketOverview(){
  if(moSocket) return; // already connected — persists across chart tab switches
  const streams = MARKET_OVERVIEW_SYMBOLS.map(s => s.toLowerCase()+'@miniTicker').join('/');
  moSocket = new WebSocket('wss://stream.binance.com:9443/stream?streams=' + streams);
  moSocket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const d = msg.data;
    if(!d || !d.s) return;
    updateMarketOverviewRow(d.s, parseFloat(d.c), parseFloat(d.o));
  };
  moSocket.onerror = () => {
    MARKET_OVERVIEW_SYMBOLS.forEach(sym => {
      const priceEl = document.getElementById('mo-price-'+sym);
      if(priceEl) priceEl.textContent = '--';
    });
  };
}
function updateMarketOverviewRow(symbol, closePrice, openPrice){
  const priceEl = document.getElementById('mo-price-'+symbol);
  const chgEl = document.getElementById('mo-chg-'+symbol);
  if(!priceEl || !chgEl) return;
  priceEl.textContent = closePrice.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits: closePrice < 10 ? 4 : 2});
  const pct = openPrice > 0 ? ((closePrice-openPrice)/openPrice*100) : 0;
  chgEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
  chgEl.classList.remove('up','down');
  chgEl.classList.add(pct >= 0 ? 'up' : 'down');
}

function renderOrderBook(bids, asks){
  const container = document.getElementById('orderBookBody');
  if(!container) return;
  const topAsks = asks.slice(0,8).reverse();
  const topBids = bids.slice(0,8);
  const allQty = [...topAsks, ...topBids].map(x => parseFloat(x[1]));
  const maxQty = Math.max(...allQty, 0.001);
  let html = '';
  topAsks.forEach(([price, qty]) => {
    const pct = (parseFloat(qty)/maxQty*100).toFixed(0);
    html += '<div class="ob-row ask"><div class="ob-bar" style="width:'+pct+'%"></div><span class="ob-price ask">'+parseFloat(price).toFixed(1)+'</span><span>'+parseFloat(qty).toFixed(4)+'</span></div>';
  });
  const bestBid = topBids[0] ? parseFloat(topBids[0][0]) : 0;
  const bestAsk = topAsks[topAsks.length-1] ? parseFloat(topAsks[topAsks.length-1][0]) : 0;
  html += '<div class="ob-spread">'+(bestAsk && bestBid ? (bestAsk-bestBid).toFixed(1) : '--')+' spread</div>';
  topBids.forEach(([price, qty]) => {
    const pct = (parseFloat(qty)/maxQty*100).toFixed(0);
    html += '<div class="ob-row bid"><div class="ob-bar" style="width:'+pct+'%"></div><span class="ob-price bid">'+parseFloat(price).toFixed(1)+'</span><span>'+parseFloat(qty).toFixed(4)+'</span></div>';
  });
  container.innerHTML = html;

  // Buy/Sell pressure bar — cumulative bid vs ask size across the same visible depth
  const totalBidQty = topBids.reduce((sum, [,qty]) => sum + parseFloat(qty), 0);
  const totalAskQty = topAsks.reduce((sum, [,qty]) => sum + parseFloat(qty), 0);
  const totalQty = totalBidQty + totalAskQty;
  const buyPct = totalQty > 0 ? (totalBidQty/totalQty*100) : 50;
  const sellPct = 100 - buyPct;
  const buyBar = document.getElementById('ob-pressure-buy');
  const sellBar = document.getElementById('ob-pressure-sell');
  const buyPctLbl = document.getElementById('ob-pressure-buy-pct');
  const sellPctLbl = document.getElementById('ob-pressure-sell-pct');
  if(buyBar) buyBar.style.width = buyPct.toFixed(0) + '%';
  if(sellBar) sellBar.style.width = sellPct.toFixed(0) + '%';
  if(buyPctLbl) buyPctLbl.textContent = buyPct.toFixed(0) + '%';
  if(sellPctLbl) sellPctLbl.textContent = sellPct.toFixed(0) + '%';
}

// ══════════════════════════════════════
// DEMO TRADING TERMINAL
// ══════════════════════════════════════
let selectedSide = 'long';
let latestPrice = null;
let demoBalance = 0;
let openPositions = [];
let entryOverlays = {};

function setTermSide(side){
  selectedSide = side;
  document.getElementById('term-btn-long').classList.toggle('long-active', side==='long');
  document.getElementById('term-btn-short').classList.toggle('short-active', side==='short');
  const submitBtn = document.getElementById('term-submit-btn');
  submitBtn.textContent = side==='long' ? 'Buy / Long' : 'Sell / Short';
  submitBtn.className = 'term-submit-btn ' + side;
  updateLiqPreview();
}

function setTermPct(pct){
  // Floor to 2 decimals (never round up) so 100% never exceeds actual balance
  const raw = demoBalance * pct / 100;
  const val = pct >= 100 ? Math.floor(demoBalance * 100) / 100 : Math.floor(raw * 100) / 100;
  document.getElementById('term-qty').value = val.toFixed(2);
  document.querySelectorAll('.term-quick-pct button').forEach(b => b.classList.remove('active'));
  const btn = [...document.querySelectorAll('.term-quick-pct button')].find(b => b.textContent.trim() === pct+'%');
  if(btn) btn.classList.add('active');
  updateLiqPreview();
}

function updateLiqPreview(){
  const qty = parseFloat(document.getElementById('term-qty').value) || 0;
  const lev = parseInt(document.getElementById('term-leverage').value) || 1;
  const preview = document.getElementById('term-liq-preview');
  const price = getPaneLivePrice(activePaneId);
  if(!qty || !price){ preview.textContent = ''; return; }
  const liq = selectedSide==='long' ? price*(1-1/lev) : price*(1+1/lev);
  preview.textContent = 'Est. liquidation: ' + liq.toFixed(1) + ' | Margin used: $' + qty.toFixed(2);
}
document.addEventListener('input', (e) => {
  if(e.target && (e.target.id==='term-qty' || e.target.id==='term-leverage')) updateLiqPreview();
});

async function ensureDemoAccount(){
  if(!state.user) return;
  const {data} = await db.from('demo_accounts').select('*').eq('user_id', state.user.id).maybeSingle();
  if(data){
    demoBalance = parseFloat(data.balance);
  } else {
    const {data: created} = await db.from('demo_accounts').insert([{user_id: state.user.id}]).select().single();
    demoBalance = created ? parseFloat(created.balance) : 10000;
  }
  const el = document.getElementById('term-balance');
  if(el) el.textContent = '$' + demoBalance.toFixed(2);
}

async function updateDemoBalance(newBalance){
  demoBalance = newBalance;
  const el = document.getElementById('term-balance');
  if(el) el.textContent = '$' + demoBalance.toFixed(2);
  if(state.user) await db.from('demo_accounts').update({balance: newBalance, updated_at: new Date().toISOString()}).eq('user_id', state.user.id);
}

function calcPnl(pos, price){
  const units = (pos.quantity_usd * pos.leverage) / pos.entry_price;
  return pos.side==='long' ? units*(price-pos.entry_price) : units*(pos.entry_price-price);
}

function calcLiqPrice(pos){
  return pos.side==='long' ? pos.entry_price*(1-1/pos.leverage) : pos.entry_price*(1+1/pos.leverage);
}

async function submitDemoOrder(){
  if(!state.user){ showToast('Please sign in first','error'); return; }
  const symbol = getPaneSymbol(activePaneId);
  const entryPrice = getPaneLivePrice(activePaneId);
  if(!symbol || !entryPrice){ showToast('Waiting for live price, try again in a sec','error'); return; }
  let qty = parseFloat(document.getElementById('term-qty').value);
  const lev = parseInt(document.getElementById('term-leverage').value);
  const tp = parseFloat(document.getElementById('term-tp').value) || null;
  const sl = parseFloat(document.getElementById('term-sl').value) || null;
  if(!qty || qty<=0){ showToast('Enter a valid margin amount','error'); return; }
  if(qty > demoBalance + 0.01){ showToast('Insufficient demo balance','error'); return; }
  if(qty > demoBalance) qty = demoBalance; // clamp tiny float overshoot (e.g. 100% selection)

  const {data, error} = await db.from('demo_positions').insert([{
    user_id: state.user.id, symbol: symbol, side: selectedSide, leverage: lev,
    quantity_usd: qty, entry_price: entryPrice, status:'open',
    take_profit: tp, stop_loss: sl
  }]).select().single();

  if(error){ showToast('Order failed: ' + error.message, 'error'); return; }

  await updateDemoBalance(demoBalance - qty);
  showToast((selectedSide==='long'?'Long':'Short')+' opened @ '+entryPrice.toFixed(1));
  document.getElementById('term-qty').value = '';
  document.getElementById('term-tp').value = '';
  document.getElementById('term-sl').value = '';
  updateLiqPreview();
  await loadDemoPositions();
}

async function loadDemoPositions(){
  if(!state.user) return;
  const {data: open} = await db.from('demo_positions').select('*').eq('user_id', state.user.id).eq('status','open').order('opened_at',{ascending:false});
  openPositions = open || [];
  renderPositions();
  drawEntryOverlays();

  const {data: closed} = await db.from('demo_positions').select('*').eq('user_id', state.user.id).eq('status','closed').order('closed_at',{ascending:false}).limit(30);
  renderHistory(closed || []);
}

function renderPositions(){
  const c = document.getElementById('btab-content-positions');
  if(!c) return;
  if(!openPositions.length){
    c.innerHTML = '<div class="bottom-tab-empty">No open positions — place a demo trade to see it here.</div>';
    return;
  }
  c.innerHTML = openPositions.map(pos => {
    const pnl = latestPrice ? calcPnl(pos, latestPrice) : 0;
    const pnlClass = pnl>=0 ? 'pos' : 'neg';
    return '<div class="pos-row" data-id="'+pos.id+'">'
      + '<span class="pos-side '+pos.side+'">'+pos.side.toUpperCase()+' '+pos.leverage+'x</span>'
      + '<span class="pos-meta">Entry '+pos.entry_price.toFixed(1)+' · Margin $'+pos.quantity_usd.toFixed(2)+'</span>'
      + '<span class="pos-pnl '+pnlClass+'" id="pnl-'+pos.id+'">'+(pnl>=0?'+':'')+pnl.toFixed(2)+' USD</span>'
      + '<button class="pos-edit-btn" title="Set TP/SL" onclick="openTpSlModal(\''+pos.id+'\')">✎</button>'
      + '<button class="pos-close-btn" onclick="closePosition(\''+pos.id+'\',\'manual\')">Close</button>'
      + '</div>';
  }).join('');
}

function renderHistory(closed){
  const c = document.getElementById('btab-content-history');
  if(!c) return;
  if(!closed.length){
    c.innerHTML = '<div class="bottom-tab-empty">No closed trades yet.</div>';
    return;
  }
  c.innerHTML = closed.map(pos => {
    const pnl = parseFloat(pos.pnl)||0;
    const pnlClass = pnl>=0 ? 'pos' : 'neg';
    return '<div class="pos-row">'
      + '<span class="pos-side '+pos.side+'">'+pos.side.toUpperCase()+' '+pos.leverage+'x</span>'
      + '<span class="pos-meta">'+pos.entry_price.toFixed(1)+' → '+(pos.exit_price||0).toFixed(1)+'</span>'
      + '<span class="pos-pnl '+pnlClass+'">'+(pnl>=0?'+':'')+pnl.toFixed(2)+' USD</span>'
      + '</div>';
  }).join('');
}

function updateOpenPositionsPnL(price){
  openPositions.forEach(pos => {
    const el = document.getElementById('pnl-'+pos.id);
    if(!el) return;
    const pnl = calcPnl(pos, price);
    el.textContent = (pnl>=0?'+':'')+pnl.toFixed(2)+' USD';
    el.className = 'pos-pnl ' + (pnl>=0?'pos':'neg');
  });
  repositionAllBadges(price);
  updateLiqPreview();
}

window.addEventListener('resize', () => { if(latestPrice) repositionAllBadges(latestPrice); });

function checkTpSlLiquidation(price){
  if(!openPositions.length) return;
  openPositions.slice().forEach(pos => {
    const liq = calcLiqPrice(pos);
    if(pos.side==='long'){
      if(price<=liq){ closePosition(pos.id,'liquidated', liq); return; }
      if(pos.take_profit && price>=pos.take_profit){ closePosition(pos.id,'tp_hit', pos.take_profit); return; }
      if(pos.stop_loss && price<=pos.stop_loss){ closePosition(pos.id,'sl_hit', pos.stop_loss); return; }
    } else {
      if(price>=liq){ closePosition(pos.id,'liquidated', liq); return; }
      if(pos.take_profit && price<=pos.take_profit){ closePosition(pos.id,'tp_hit', pos.take_profit); return; }
      if(pos.stop_loss && price>=pos.stop_loss){ closePosition(pos.id,'sl_hit', pos.stop_loss); return; }
    }
  });
}

let closingInProgress = {};
async function closePosition(id, reason, forcedPrice){
  if(closingInProgress[id]) return;
  closingInProgress[id] = true;
  const pos = openPositions.find(p => p.id===id);
  if(!pos){ closingInProgress[id] = false; return; }
  const exitPrice = forcedPrice || latestPrice || pos.entry_price;
  const pnl = calcPnl(pos, exitPrice);

  const {error} = await db.from('demo_positions').update({
    status:'closed', exit_price: exitPrice, pnl: pnl, closed_at: new Date().toISOString()
  }).eq('id', id);

  if(error){ showToast('Close failed: '+error.message,'error'); closingInProgress[id]=false; return; }

  await updateDemoBalance(demoBalance + pos.quantity_usd + pnl);
  removeEntryOverlay(id);

  const labels = {manual:'Position closed', liquidated:'Position liquidated ⚠️', tp_hit:'Take profit hit 🎯', sl_hit:'Stop loss hit'};
  showToast((labels[reason]||'Closed')+' @ '+exitPrice.toFixed(1)+' | PnL '+(pnl>=0?'+':'')+pnl.toFixed(2), pnl>=0?'success':'error');

  closingInProgress[id] = false;
  await loadDemoPositions();
}

// ══════════════════════════════════════
// TP/SL — draggable chart lines (ghost placeholders + real), live PnL badges, fill band
// ══════════════════════════════════════
let tpSlBoxes = {};   // posId -> { entryEl, tpEl, slEl, tpOverlayId, slOverlayId }
let activeDrag = null; // { posId, kind } while a TP/SL line is being dragged
let tpSlModalPosId = null;
const TP_SL_TICK = 0.5; // TP/SL always locks to this clean price step, Delta-style
function snapPrice(v){ return Math.round(v / TP_SL_TICK) * TP_SL_TICK; }

// Custom overlay: draws the exact same horizontal line as before, but adds an
// invisible ~30px-tall touch band over it so tapping/dragging TP & SL is easy
// on a tablet — the thin line itself has a very tight hit-test tolerance in klinecharts.
if (typeof klinecharts !== 'undefined') {
  klinecharts.registerOverlay({
    name: 'tpslDragLine',
    totalStep: 1,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, bounding, overlay }) => {
      const y = coordinates[0] ? coordinates[0].y : 0;
      const lineStyles = (overlay.styles && overlay.styles.line) || {};
      return [
        {
          type: 'rect',
          ignoreEvent: false,
          attrs: { x: 0, y: y - 23, width: bounding.width, height: 46 },
          styles: { style: 'fill', color: 'rgba(0,0,0,0.01)' }
        },
        {
          type: 'line',
          ignoreEvent: true,
          attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] },
          styles: lineStyles
        }
      ];
    }
  });
}

function getChartWrap(){
  return document.querySelector('.chart-panel-wrap');
}

function fmtPnl(v){
  return (v>=0?'+':'') + v.toFixed(2) + ' USDT';
}

function priceToY(price){
  if(!mainChartInstance || price==null) return null;
  try {
    const px = mainChartInstance.convertToPixel({value: price}, {paneId:'candle_pane'});
    return Array.isArray(px) ? px[0]?.y : px?.y;
  } catch(e){ return null; }
}

// Small pixel-offset placeholder near the entry line (never far off-screen, unlike a % based default)
function ghostPrice(pos, kind){
  if(!mainChartInstance) return null;
  const entryY = priceToY(pos.entry_price);
  if(entryY==null) return null;
  const offsetPx = 42;
  const above = kind==='tp' ? pos.side==='long' : pos.side!=='long';
  const y = above ? entryY - offsetPx : entryY + offsetPx;
  try {
    const res = mainChartInstance.convertFromPixel({x:120, y}, {paneId:'candle_pane'});
    const v = Array.isArray(res) ? res[0]?.value : res?.value;
    return typeof v === 'number' ? v : null;
  } catch(e){ return null; }
}

function ensureBadgeEls(posId){
  let box = tpSlBoxes[posId];
  if(box && box.entryEl) return box;
  const wrap = getChartWrap();
  if(!wrap) return null;
  const entryEl = document.createElement('div');
  entryEl.className = 'cw-badge';
  const tpEl = document.createElement('div');
  tpEl.className = 'cw-badge';
  tpEl.style.display = 'none';
  const slEl = document.createElement('div');
  slEl.className = 'cw-badge';
  slEl.style.display = 'none';
  const comboEl = document.createElement('div');
  comboEl.className = 'cw-badge cw-badge-combo';
  comboEl.style.display = 'none';
  const bandEl = document.createElement('div');
  bandEl.className = 'cw-fill-band';
  wrap.appendChild(entryEl); wrap.appendChild(tpEl); wrap.appendChild(slEl); wrap.appendChild(comboEl); wrap.appendChild(bandEl);
  box = { entryEl, tpEl, slEl, comboEl, bandEl, tpOverlayId:null, slOverlayId:null, comboOverlayId:null, armedKind:'tp' };
  tpSlBoxes[posId] = box;
  return box;
}

function removePositionUI(posId){
  const box = tpSlBoxes[posId];
  if(!box) return;
  [box.entryEl, box.tpEl, box.slEl, box.comboEl, box.bandEl].forEach(el => el && el.remove());
  if(mainChartInstance){
    if(box.tpOverlayId) try{ mainChartInstance.removeOverlay(box.tpOverlayId); }catch(e){}
    if(box.slOverlayId) try{ mainChartInstance.removeOverlay(box.slOverlayId); }catch(e){}
    if(box.comboOverlayId) try{ mainChartInstance.removeOverlay(box.comboOverlayId); }catch(e){}
  }
  delete tpSlBoxes[posId];
}

function drawEntryOverlays(){
  if(!mainChartInstance) return;
  Object.values(entryOverlays).forEach(id => { try{ mainChartInstance.removeOverlay(id); }catch(e){} });
  entryOverlays = {};

  // Drop UI for positions that no longer exist
  const liveIds = openPositions.map(p => p.id);
  Object.keys(tpSlBoxes).forEach(id => { if(!liveIds.includes(id)) removePositionUI(id); });

  openPositions.forEach(pos => {
    try {
      const id = mainChartInstance.createOverlay({
        name: 'priceLine',
        points: [{value: pos.entry_price}],
        lock: true,
        styles: { line: { color: pos.side==='long' ? '#4CAF7D' : '#E05252', style:'dashed', size:1 } }
      });
      entryOverlays[pos.id] = id;
    } catch(e){ console.warn('overlay failed', e); }

    ensureBadgeEls(pos.id);
    refreshTpSlDisplay(pos);
  });

  repositionAllBadges(latestPrice);
}

function removeEntryOverlay(id){
  if(entryOverlays[id] && mainChartInstance){
    try{ mainChartInstance.removeOverlay(entryOverlays[id]); }catch(e){}
    delete entryOverlays[id];
  }
  removePositionUI(id);
}

// Decide whether to show the combined "one line, TP|SL toggle" ghost (neither set yet)
// or the normal individual TP/SL lines (at least one is set).
function refreshTpSlDisplay(pos){
  const box = ensureBadgeEls(pos.id);
  if(!box) return;
  const bothUnset = pos.take_profit == null && pos.stop_loss == null;
  if(bothUnset){
    ['tpOverlayId','slOverlayId'].forEach(k => { if(box[k]){ try{ mainChartInstance.removeOverlay(box[k]); }catch(e){} box[k]=null; } });
    box.tpEl.style.display = 'none';
    box.slEl.style.display = 'none';
    drawCombinedGhostLine(pos);
  } else {
    if(box.comboOverlayId){ try{ mainChartInstance.removeOverlay(box.comboOverlayId); }catch(e){} box.comboOverlayId = null; }
    box.comboEl.style.display = 'none';
    drawTpSlLine(pos, 'tp');
    drawTpSlLine(pos, 'sl');
  }
}

// Delta-style: ONE draggable ghost line with a TP/SL toggle box on it, instead of
// two separate ghost lines floating apart above/below the entry.
function drawCombinedGhostLine(pos){
  if(!mainChartInstance) return;
  const box = ensureBadgeEls(pos.id);
  if(!box) return;
  if(box.comboOverlayId){ try{ mainChartInstance.removeOverlay(box.comboOverlayId); }catch(e){} box.comboOverlayId = null; }
  const price = ghostPrice(pos, box.armedKind);
  if(price == null){ box.comboEl.style.display = 'none'; return; }
  const overlayId = mainChartInstance.createOverlay({
    name: 'tpslDragLine',
    points: [{ value: price }],
    lock: false,
    styles: { line: { color: '#D4B886', style: 'dashed', size: 1 } },
    onPressedMoveStart: () => { onTpSlDragStart(pos.id, box.armedKind); },
    onPressedMoving: (evt) => { onComboDragging(pos.id, evt); },
    onPressedMoveEnd: (evt) => { onComboDragEnd(pos.id, evt); }
  });
  box.comboOverlayId = overlayId;
  updateComboBadge(pos, price);
}

function updateComboBadge(pos, price){
  const box = tpSlBoxes[pos.id];
  if(!box) return;
  const y = priceToY(price);
  if(y==null) return;
  const armed = box.armedKind;
  box.comboEl.style.top = y + 'px';
  box.comboEl.innerHTML =
      '<span class="cw-seg cw-toggle '+(armed==='tp'?'cw-toggle-active-tp':'')+'" onclick="armTpSlCombo(\''+pos.id+'\',\'tp\')">TP</span>'
    + '<span class="cw-seg cw-toggle '+(armed==='sl'?'cw-toggle-active-sl':'')+'" onclick="armTpSlCombo(\''+pos.id+'\',\'sl\')">SL</span>'
    + '<span class="cw-seg cw-seg-ghost-price">'+price.toFixed(2)+'</span>';
  box.comboEl.style.display = 'block';
}

// Switch which of TP/SL the single combined line currently controls
function armTpSlCombo(posId, kind){
  const box = tpSlBoxes[posId];
  const pos = openPositions.find(p => p.id===posId);
  if(!box || !pos) return;
  box.armedKind = kind;
  drawCombinedGhostLine(pos);
}

function onComboDragging(posId, evt){
  const box = tpSlBoxes[posId];
  const pos = openPositions.find(p => p.id===posId);
  if(!box || !pos) return;
  const raw = getOverlayPrice(evt);
  if(raw == null) return;
  const price = snapPrice(raw);
  if(box.comboOverlayId){ try{ mainChartInstance.overrideOverlay({ id: box.comboOverlayId, points: [{ value: price }] }); }catch(e){} }
  updateComboBadge(pos, price);
  updateFillBand(pos, box.armedKind, price);
}

async function onComboDragEnd(posId, evt){
  const box = tpSlBoxes[posId];
  const pos = openPositions.find(p => p.id===posId);
  activeDrag = null;
  if(box) box.bandEl.style.display = 'none';
  if(!box || !pos) return;
  let price = getOverlayPrice(evt);
  if(price == null) return;
  price = snapPrice(price);
  const kind = box.armedKind;
  const field = kind==='tp' ? 'take_profit' : 'stop_loss';
  pos[field] = price;
  refreshTpSlDisplay(pos);
  const patch = {}; patch[field] = price;
  const { error } = await db.from('demo_positions').update(patch).eq('id', posId);
  if(error){ showToast('Could not save '+kind.toUpperCase()+': '+error.message, 'error'); }
  else { showToast(kind.toUpperCase()+' set @ '+price.toFixed(2)); }
}

// Draw/refresh a single TP or SL line for a position.
// If not set yet, draws a dashed "ghost" placeholder right next to the entry line
// (never far away) that becomes a real TP/SL the moment the user drags it.
function drawTpSlLine(pos, kind){
  if(!mainChartInstance) return;
  const box = ensureBadgeEls(pos.id);
  if(!box) return;
  const field = kind==='tp' ? 'take_profit' : 'stop_loss';
  const overlayKey = kind==='tp' ? 'tpOverlayId' : 'slOverlayId';
  const isSet = pos[field] != null;
  const price = isSet ? pos[field] : ghostPrice(pos, kind);

  if(box[overlayKey]){ try{ mainChartInstance.removeOverlay(box[overlayKey]); }catch(e){} box[overlayKey] = null; }
  const el = kind==='tp' ? box.tpEl : box.slEl;

  if(price == null){ el.style.display = 'none'; return; }

  const color = kind==='tp' ? '#4CAF7D' : '#E05252';
  const overlayId = mainChartInstance.createOverlay({
    name: 'tpslDragLine',
    points: [{ value: price }],
    lock: false,
    styles: { line: { color, style: isSet ? 'solid' : 'dashed', size: isSet ? 2 : 1 } },
    onPressedMoveStart: () => { onTpSlDragStart(pos.id, kind); },
    onPressedMoving: (evt) => { onTpSlDragging(pos.id, kind, evt); },
    onPressedMoveEnd: (evt) => { onTpSlDragEnd(pos.id, kind, evt); }
  });
  box[overlayKey] = overlayId;
  updateTpSlBadge(pos, kind, price, !isSet);
  el.style.display = 'block';
}

function getOverlayPrice(evt){
  try {
    const pts = evt && evt.overlay && evt.overlay.points;
    if(pts && pts[0] && typeof pts[0].value === 'number') return pts[0].value;
  } catch(e){}
  return null;
}

function onTpSlDragStart(posId, kind){
  activeDrag = { posId, kind };
  const box = tpSlBoxes[posId];
  if(box) box.bandEl.style.display = 'block';
}

// Fires continuously while dragging — recalculates live PnL on every pixel/price change
function onTpSlDragging(posId, kind, evt){
  const pos = openPositions.find(p => p.id===posId);
  const box = tpSlBoxes[posId];
  if(!pos || !box) return;
  const raw = getOverlayPrice(evt);
  if(raw == null) return;
  const price = snapPrice(raw);
  const overlayId = kind==='tp' ? box.tpOverlayId : box.slOverlayId;
  if(overlayId){ try{ mainChartInstance.overrideOverlay({ id: overlayId, points: [{ value: price }] }); }catch(e){} }
  updateTpSlBadge(pos, kind, price, false);
  updateFillBand(pos, kind, price);
}

async function onTpSlDragEnd(posId, kind, evt){
  const pos = openPositions.find(p => p.id===posId);
  const box = tpSlBoxes[posId];
  activeDrag = null;
  if(box) box.bandEl.style.display = 'none';
  if(!pos) return;
  let price = getOverlayPrice(evt);
  if(price == null) return;
  price = snapPrice(price); // lock to a clean price step, not a random decimal
  const field = kind==='tp' ? 'take_profit' : 'stop_loss';
  pos[field] = price; // dragging (even a ghost line) always confirms the value
  updateTpSlBadge(pos, kind, price, false);
  refreshTpSlDisplay(pos); // redraw solid now that it's confirmed
  const patch = {}; patch[field] = price;
  const { error } = await db.from('demo_positions').update(patch).eq('id', posId);
  if(error){ showToast('Could not save '+kind.toUpperCase()+': '+error.message, 'error'); }
  else { showToast(kind.toUpperCase()+' set @ '+price.toFixed(1)); }
}

// Two-segment Delta-style badge: left = label/price, right = live colored PnL
function updateTpSlBadge(pos, kind, price, ghost){
  const box = tpSlBoxes[pos.id];
  if(!box) return;
  const el = kind==='tp' ? box.tpEl : box.slEl;
  const y = priceToY(price);
  if(y==null) return;
  const pnl = calcPnl(pos, price);
  const pnlClass = pnl>=0 ? 'pos' : 'neg';
  el.style.top = y + 'px';
  el.className = 'cw-badge' + (ghost ? ' cw-badge-ghost' : '');
  el.innerHTML = '<span class="cw-seg cw-seg-'+kind+'">'+(ghost ? (kind==='tp'?'Set TP':'Set SL') : (kind==='tp'?'TP ':'SL ')+price.toFixed(2))+'</span>'
    + '<span class="cw-seg cw-seg-pnl '+pnlClass+'">'+fmtPnl(pnl)+'</span>';
  el.style.display = 'block';
}

function updateFillBand(pos, kind, draggedPrice){
  const box = tpSlBoxes[pos.id];
  if(!box) return;
  const entryY = priceToY(pos.entry_price);
  const dragY = priceToY(draggedPrice);
  if(entryY==null || dragY==null) return;
  const top = Math.min(entryY, dragY);
  const height = Math.max(2, Math.abs(entryY - dragY));
  box.bandEl.className = 'cw-fill-band ' + (kind==='tp' ? 'cw-fill-tp' : 'cw-fill-sl');
  box.bandEl.style.top = top + 'px';
  box.bandEl.style.height = height + 'px';
  box.bandEl.style.display = 'block';
}

function repositionAllBadges(price){
  openPositions.forEach(pos => {
    const box = tpSlBoxes[pos.id];
    if(!box) return;
    const entryY = priceToY(pos.entry_price);
    if(entryY!=null){
      box.entryEl.style.top = entryY + 'px';
      box.entryEl.className = 'cw-badge';
      const pnl = price!=null ? calcPnl(pos, price) : 0;
      const pnlClass = pnl>=0 ? 'pos' : 'neg';
      box.entryEl.innerHTML = '<span class="cw-seg cw-seg-main">$'+pos.quantity_usd.toFixed(2)+'</span>'
        + '<span class="cw-seg cw-seg-pnl '+pnlClass+'">'+fmtPnl(pnl)+'</span>';
    }
    // Don't fight the live drag redraw for the line currently being dragged
    const bothUnset = pos.take_profit==null && pos.stop_loss==null;
    const draggingTp = activeDrag && activeDrag.posId===pos.id && activeDrag.kind==='tp';
    const draggingSl = activeDrag && activeDrag.posId===pos.id && activeDrag.kind==='sl';
    if(!bothUnset){
      if(!draggingTp){
        const tpPrice = pos.take_profit != null ? pos.take_profit : ghostPrice(pos, 'tp');
        if(tpPrice != null) updateTpSlBadge(pos, 'tp', tpPrice, pos.take_profit == null);
      }
      if(!draggingSl){
        const slPrice = pos.stop_loss != null ? pos.stop_loss : ghostPrice(pos, 'sl');
        if(slPrice != null) updateTpSlBadge(pos, 'sl', slPrice, pos.stop_loss == null);
      }
    }
    const draggingCombo = activeDrag && activeDrag.posId===pos.id && box.comboOverlayId;
    if(!draggingCombo && bothUnset && box.comboOverlayId){
      const comboPrice = ghostPrice(pos, box.armedKind);
      if(comboPrice != null) updateComboBadge(pos, comboPrice);
    }
  });
}

// ── Pencil icon → typing popup (Solution 1) ──
function openTpSlModal(posId){
  const pos = openPositions.find(p => p.id===posId);
  if(!pos) return;
  tpSlModalPosId = posId;
  document.getElementById('tpsl-modal-entry').textContent = pos.entry_price.toFixed(2);
  document.getElementById('tpsl-modal-tp').value = pos.take_profit != null ? pos.take_profit.toFixed(2) : '';
  document.getElementById('tpsl-modal-sl').value = pos.stop_loss != null ? pos.stop_loss.toFixed(2) : '';
  document.getElementById('tpsl-modal-overlay').classList.add('open');
}

function closeTpSlModal(){
  document.getElementById('tpsl-modal-overlay').classList.remove('open');
  tpSlModalPosId = null;
}

async function saveTpSlModal(){
  const pos = openPositions.find(p => p.id===tpSlModalPosId);
  if(!pos) return;
  const tpRaw = document.getElementById('tpsl-modal-tp').value;
  const slRaw = document.getElementById('tpsl-modal-sl').value;
  const patch = {
    take_profit: tpRaw === '' ? null : Math.round(parseFloat(tpRaw) * 100) / 100,
    stop_loss: slRaw === '' ? null : Math.round(parseFloat(slRaw) * 100) / 100
  };
  const { error } = await db.from('demo_positions').update(patch).eq('id', pos.id);
  if(error){ showToast('Failed to save TP/SL: '+error.message, 'error'); return; }
  pos.take_profit = patch.take_profit;
  pos.stop_loss = patch.stop_loss;
  closeTpSlModal();
  refreshTpSlDisplay(pos);
  repositionAllBadges(latestPrice);
  showToast('TP/SL saved');
}

function switchBottomTab(tab){
  document.querySelectorAll('.bottom-tab-item').forEach(t => t.classList.remove('active'));
  document.getElementById('btab-'+tab).classList.add('active');
  document.querySelectorAll('.bottom-tab-content').forEach(c => c.style.display='none');
  document.getElementById('btab-content-'+tab).style.display='block';
}

function initCalcBrokers(){
  const row = document.getElementById('calc-broker-row');
  if(!row) return;
  row.innerHTML = '';
  if(!state.brokers || state.brokers.length === 0){
    row.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px;">No brokers connected. <a href="#" onclick="openBrokerPopup();return false;" style="color:var(--gold);">Connect a broker</a></div>';
    return;
  }
  state.brokers.forEach((b, i) => {
    const chip = document.createElement('button');
    chip.className = 'calc-broker-chip' + (i===0?' active':'');
    chip.textContent = b.account_label || b.name || 'Broker';
    chip.onclick = () => {
      document.querySelectorAll('.calc-broker-chip').forEach(c=>c.classList.remove('active'));
      chip.classList.add('active');
      // Auto-fill capital if available
      if(b.balance) document.getElementById('calc-capital').value = b.balance;
    };
    row.appendChild(chip);
  });
  // Auto-fill capital from first broker
  const first = state.brokers[0];
  if(first && first.balance) document.getElementById('calc-capital').value = first.balance;
}

// Quick calculate on input change
['calc-capital','calc-entry','calc-sl','calc-tp'].forEach(id => {
  const el = document.getElementById(id);
  if(el) el.addEventListener('input', quickCalc);
});
document.getElementById('calc-risk-slider')?.addEventListener('input', quickCalc);

function quickCalc(){
  const capital = parseFloat(document.getElementById('calc-capital').value);
  const entry = parseFloat(document.getElementById('calc-entry').value);
  const sl = parseFloat(document.getElementById('calc-sl').value);
  const tp = parseFloat(document.getElementById('calc-tp').value);
  const riskPct = parseFloat(document.getElementById('calc-risk-slider').value) / 100;
  if(!capital || !entry || !sl) return;
  const riskAmt = capital * riskPct;
  const slDist = Math.abs(entry - sl);
  if(slDist === 0) return;
  const posSize = riskAmt / slDist;
  const rr = tp ? (Math.abs(tp - entry) / slDist).toFixed(2) : '—';
  const maxDD = (riskAmt * 5).toFixed(0); // 5 consecutive losses estimate
  document.getElementById('cr-pos').textContent = posSize.toFixed(4);
  document.getElementById('cr-risk').textContent = '₹' + riskAmt.toFixed(0);
  document.getElementById('cr-rr').textContent = rr !== '—' ? '1:' + rr : '—';
  document.getElementById('cr-dd').textContent = '₹' + maxDD;
  document.getElementById('calc-results').style.display = 'block';
}

function handleCalcImg(input){
  const file = input.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    calcImg = e.target.result;
    document.getElementById('calc-img-el').src = calcImg;
    document.getElementById('calc-img-preview').style.display = 'block';
  };
  reader.readAsDataURL(file);
}

function clearCalcImg(){
  calcImg = null;
  document.getElementById('calc-img-preview').style.display = 'none';
  document.getElementById('calc-img-inp').value = '';
}

async function sendCalcMsg(){
  const inp = document.getElementById('calc-chat-inp');
  const msgs = document.getElementById('calc-chat-msgs');
  const text = inp.value.trim();
  if(!text && !calcImg) return;

  const userDiv = document.createElement('div');
  userDiv.className = 'calc-msg-user';
  if(calcImg){
    userDiv.innerHTML = `<img src="${calcImg}" style="max-height:80px;border-radius:6px;display:block;margin-bottom:6px;">${text||'(image)'}`;
  } else {
    userDiv.textContent = text;
  }
  msgs.appendChild(userDiv);
  inp.value = '';

  const loadDiv = document.createElement('div');
  loadDiv.className = 'calc-msg-loading';
  loadDiv.textContent = 'AI is thinking...';
  msgs.appendChild(loadDiv);
  msgs.scrollTop = msgs.scrollHeight;

  const capital = document.getElementById('calc-capital').value;
  const entry = document.getElementById('calc-entry').value;
  const sl = document.getElementById('calc-sl').value;
  const tp = document.getElementById('calc-tp').value;
  const risk = document.getElementById('calc-risk-slider').value;
  const activeBroker = state.brokers?.find(b => b.id === state.activeBroker);
  const brokerName = activeBroker?.name || 'Unknown Broker';

  let imageBase64 = null;
  let imageMimeType = null;
  if (calcImg) {
    imageBase64 = calcImg.split(',')[1];
    imageMimeType = calcImg.split(';')[0].split(':')[1];
  }

  try {
    const { data, error } = await db.functions.invoke('ai-calculator', {
      body: {
        message: text,
        image_base64: imageBase64,
        image_mime_type: imageMimeType,
        context: {
          broker: brokerName,
          capital: capital,
          risk_pct: risk,
          entry: entry,
          stop_loss: sl,
          target: tp
        }
      }
    });

    if (error) throw error;
    if (data?.error) throw new Error(data.error);

    const reply = data?.reply || 'No response from AI.';

    loadDiv.remove();
    const aiDiv = document.createElement('div');
    aiDiv.className = 'calc-msg-ai';
    aiDiv.innerHTML = reply.replace(/\n/g,'<br>');
    msgs.appendChild(aiDiv);
    clearCalcImg();
  } catch(e) {
    loadDiv.textContent = 'Error: ' + e.message;
  }
  msgs.scrollTop = msgs.scrollHeight;
}

// ══════════════════════════════════════
// STATISTICS AI
// ══════════════════════════════════════
let statsHistory = [];

async function sendStatsMsg(){
  const inp = document.getElementById('stats-chat-inp');
  const msgs = document.getElementById('stats-chat-msgs');
  const text = inp.value.trim();
  if(!text) return;

  const userDiv = document.createElement('div');
  userDiv.className = 'calc-msg-user';
  userDiv.textContent = text;
  msgs.appendChild(userDiv);
  inp.value = '';

  const loadDiv = document.createElement('div');
  loadDiv.className = 'calc-msg-loading';
  loadDiv.textContent = 'AI is thinking...';
  msgs.appendChild(loadDiv);
  msgs.scrollTop = msgs.scrollHeight;

  const trades = getFilteredTrades();
  const total = trades.length;
  const profits = trades.filter(t=>t.conclusion==='target').length;
  const losses = trades.filter(t=>t.conclusion==='loss').length;
  const bes = trades.filter(t=>t.conclusion==='breakeven').length;
  const winRate = total>0?Math.round((profits/total)*100):0;

  const rrrs = trades.filter(t=>t.rrr).map(t=>{
    const parts=t.rrr.split(':');
    return parts.length===2?parseFloat(parts[1])/parseFloat(parts[0]):0;
  }).filter(r=>r>0);
  const avgRR = rrrs.length>0?(rrrs.reduce((a,b)=>a+b,0)/rrrs.length).toFixed(2):null;

  const sessions=['London','New York','Asian','London-NY Overlap'];
  const sessionPerformance={};
  sessions.forEach(s=>{
    const st=trades.filter(t=>t.session===s);
    const sw=st.filter(t=>t.conclusion==='target').length;
    sessionPerformance[s]={trades:st.length,wins:sw,winRate:st.length>0?Math.round(sw/st.length*100):null};
  });

  const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dayOfWeekPerformance={};
  days.forEach((dn,di)=>{
    const dt=trades.filter(t=>new Date(t.date+'T00:00:00').getDay()===di);
    const dw=dt.filter(t=>t.conclusion==='target').length;
    dayOfWeekPerformance[dn]={trades:dt.length,wins:dw,winRate:dt.length>0?Math.round(dw/dt.length*100):null};
  });

  const stratMap={};
  trades.forEach(t=>{
    const s=(t.strategy||'').trim();
    if(!s)return;
    if(!stratMap[s])stratMap[s]={total:0,wins:0};
    stratMap[s].total++;
    if(t.conclusion==='target')stratMap[s].wins++;
  });
  const strategyPerformance=Object.keys(stratMap).map(s=>({
    name:s,total:stratMap[s].total,wins:stratMap[s].wins,
    winRate:Math.round(stratMap[s].wins/stratMap[s].total*100)
  }));

  const capitalPoints=trades
    .filter(t=>t.updated_capital!=null&&t.updated_capital!==''&&!isNaN(parseFloat(t.updated_capital)))
    .map(t=>({date:t.date,val:parseFloat(t.updated_capital)}))
    .sort((a,b)=>new Date(a.date+'T00:00:00')-new Date(b.date+'T00:00:00'));
  const capitalGrowth=capitalPoints.length>=2?{
    start:capitalPoints[0].val,
    current:capitalPoints[capitalPoints.length-1].val,
    change:capitalPoints[capitalPoints.length-1].val-capitalPoints[0].val,
    changePct:((capitalPoints[capitalPoints.length-1].val-capitalPoints[0].val)/capitalPoints[0].val*100).toFixed(1)
  }:null;

  const statsContext={
    filter:state.statsFilter,
    totalTrades:total,wins:profits,losses:losses,breakevens:bes,
    winRate:winRate,avgRR:avgRR,
    sessionPerformance:sessionPerformance,
    dayOfWeekPerformance:dayOfWeekPerformance,
    strategyPerformance:strategyPerformance,
    capitalGrowth:capitalGrowth,
    weakPoints:document.getElementById('weak-points')?.innerText||'',
    strongPoints:document.getElementById('strong-points')?.innerText||''
  };

  statsHistory.push({role:'user',content:text});

  try {
    const {data,error}=await db.functions.invoke('ai-statistics',{
      body:{messages:statsHistory,statsContext:statsContext}
    });

    if(error) throw error;
    if(data?.error) throw new Error(data.error);

    const reply=data?.reply||'No response from AI.';
    statsHistory.push({role:'assistant',content:reply});

    loadDiv.remove();
    const aiDiv=document.createElement('div');
    aiDiv.className='calc-msg-ai';
    aiDiv.innerHTML=reply.replace(/\n/g,'<br>');
    msgs.appendChild(aiDiv);
  } catch(e){
    loadDiv.textContent='Error: '+e.message;
  }
  msgs.scrollTop=msgs.scrollHeight;
}
// --- 3D HOVER EFFECT LOGIC ---
document.addEventListener("DOMContentLoaded", () => {
  const cards = document.querySelectorAll('.feat, .bal-card, .day-card, .stat-big, .stats-card');
  
  cards.forEach(card => {
    card.classList.add('glass-3d');
    
    const handleMove = (clientX, clientY) => {
      const rect = card.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const rotateX = ((y - centerY) / centerY) * -8;
      const rotateY = ((x - centerX) / centerX) * 8;
      
      card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`;
      card.style.boxShadow = `${-rotateY}px ${rotateX}px 24px rgba(0,0,0,0.3), 0 0 15px rgba(201,168,76,0.1)`;
    };

    const handleReset = () => {
      card.style.transform = `perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)`;
      card.style.boxShadow = '';
    };
    
    // Mouse Events (Desktop)
    card.addEventListener('mousemove', (e) => handleMove(e.clientX, e.clientY));
    card.addEventListener('mouseleave', handleReset);

    // Touch Events (Mobile & Tablet)
    card.addEventListener('touchmove', (e) => {
      if(e.touches.length > 0) {
        handleMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    }, { passive: true });
    
    card.addEventListener('touchend', handleReset);
    card.addEventListener('touchcancel', handleReset);
  });

  const revealElements = document.querySelectorAll('.section, .how-section, .brokers-sec, .cta-sec');
  revealElements.forEach(el => el.classList.add('reveal-up'));

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target); 
      }
    });
  }, { threshold: 0.15 });

  revealElements.forEach(el => observer.observe(el));
});

// --- GENTLE 3D HOVER FOR TRADE CARDS (dynamically created, event delegation) ---
(function(){
  const list = document.getElementById('trades-list');
  if(!list) return;

  const handleMove = (card, clientX, clientY) => {
    const rect = card.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const rotateX = ((y - centerY) / centerY) * -3;
    const rotateY = ((x - centerX) / centerX) * 3;

    card.style.transform = `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.008, 1.008, 1.008)`;
    card.style.boxShadow = `${-rotateY}px ${rotateX}px 14px rgba(0,0,0,0.15), 0 0 8px rgba(201,168,76,0.06)`;
  };

  const handleReset = (card) => {
    card.style.transform = `perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)`;
    card.style.boxShadow = '';
  };

  list.addEventListener('mousemove', (e) => {
    const card = e.target.closest('.trade-card');
    if(!card) return;
    handleMove(card, e.clientX, e.clientY);
  });

  list.addEventListener('mouseleave', (e) => {
    const card = e.target.closest('.trade-card');
    if(card) handleReset(card);
  }, true);

  list.addEventListener('touchmove', (e) => {
    const card = e.target.closest('.trade-card');
    if(!card) return;
    const touch = e.touches[0];
    handleMove(card, touch.clientX, touch.clientY);
  }, {passive:true});

  list.addEventListener('touchend', (e) => {
    const card = e.target.closest('.trade-card');
    if(card) handleReset(card);
  });
})();
