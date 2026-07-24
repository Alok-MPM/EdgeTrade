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
  if(key==='chart') { bootChartTerminalOnce(); }
}

// ══════════════════════════════════════
// CHART TERMINAL — LAZY BOOT (runs exactly once, the first time the user
// opens the Chart page). This guarantees #section-chart already has the
// "active" class (and therefore real width/height) BEFORE klinecharts
// initializes inside chartEngine — initializing into a hidden/zero-size
// container was the root cause of the empty-candle-chart bug.
// After the first boot, revisiting the Chart page just re-shows the
// section — sockets in market-store.js keep running in the background,
// nothing is re-initialized.
// ══════════════════════════════════════
let chartTerminalBooted = false;
function bootChartTerminalOnce(){
  if (chartTerminalBooted) return;
  chartTerminalBooted = true;
  chartCockpit.init({ mountId: 'chart-terminal-root', chartContainerId: 'klineMainChart' });
  chartSplit.init({ chartContainerId: 'klineMainChart' });
  orderBook.init({ mountId: 'order-book-root' });
  tradeTerminal.init({ mountId: 'trade-terminal-root' });
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
    // Chart header's twin avatar
    const topAvChart=document.getElementById('topbar-av-chart');
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
      // Chart header
      if(topAvChart){
        topAvChart.style.backgroundImage=`url(${savedDp})`;
        topAvChart.style.backgroundSize='cover';
        topAvChart.style.backgroundPosition='center';
        topAvChart.textContent='';
      }
    } else {
      avEl.textContent=initials;
      sideAv.textContent=initials;
      topAv.textContent=initials;
      if(topAvChart) topAvChart.textContent=initials;
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
    const nmChart1=document.getElementById('active-broker-nm-chart'); if(nmChart1) nmChart1.textContent=nm;
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
  const nmChart2=document.getElementById('active-broker-nm-chart'); if(nmChart2) nmChart2.textContent = name;
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
    const nmChart3=document.getElementById('active-broker-nm-chart'); if(nmChart3) nmChart3.textContent = nm;
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
      applyDp(document.getElementById('topbar-av-chart'));
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
// (old chart-engine code that used to live in this section has been
// removed — the chart terminal is now entirely chart-terminal/*.js,
// booted from bootChartTerminalOnce() near the top of this file)
// ══════════════════════════════════════

let calcImg = null;
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

// ══════════════════════════════════════════════════════════════════════
// PHASE 3 + PHASE 4 + PHASE 5 — TERMINAL BEHAVIOUR, INTELLIGENCE & POLISH
// Self-contained, additive module. Nothing above this point is modified,
// no existing function is renamed, no business/API logic is touched.
// Exposes exactly ONE global: window.EdgeTerminal (no other global
// pollution). Hooks itself onto #section-chart via a MutationObserver so
// it needs zero edits to showSection()/bootChartTerminalOnce() above.
// ══════════════════════════════════════════════════════════════════════
(function(){
  'use strict';
  if (window.EdgeTerminal) return; // guard against double-inclusion

  // ── shared feature flags ──────────────────────────────────────────
  const reduceMotionMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reducedMotion = reduceMotionMQ ? reduceMotionMQ.matches : false;
  if (reduceMotionMQ && reduceMotionMQ.addEventListener) {
    reduceMotionMQ.addEventListener('change', e => { reducedMotion = e.matches; applyReducedMotionClass(); });
  }
  let tabVisible = document.visibilityState !== 'hidden';
  const isDebug = (function(){
    try { return localStorage.getItem('edgetrade_debug') === '1' || /localhost|127\.0\.0\.1/.test(location.hostname); }
    catch(e){ return false; }
  })();

  // ── PHASE 5 §8 / PHASE 4 §1: central state + persistence ───────────
  const LS_KEY = 'edgetrade_terminal_state_v1';
  const terminalState = {
    activeSymbol: null,
    timeframe: null,
    theme: 'dark',
    layout: { historyCollapsed: false, marketWatchWidth: null },
    sidebarState: 'expanded',
    aiOpen: false,
    adLoaded: false
  };
  function loadState(){
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p.layout) Object.assign(terminalState.layout, p.layout);
      if (p.theme) terminalState.theme = p.theme;
      if (p.sidebarState) terminalState.sidebarState = p.sidebarState;
    } catch(e){ /* corrupt/unavailable storage — start fresh */ }
  }
  let saveTimer = null;
  function saveState(){
    showSaveIndicator('Saving...');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({
          layout: terminalState.layout, theme: terminalState.theme, sidebarState: terminalState.sidebarState
        }));
        showSaveIndicator('Saved ✓', 1200);
      } catch(e){ /* storage unavailable — silently skip */ }
    }, 600);
  }
  let saveIndicatorEl = null;
  function showSaveIndicator(text, hideAfter){
    if (!saveIndicatorEl) {
      saveIndicatorEl = document.createElement('div');
      saveIndicatorEl.className = 'ct-save-indicator';
      document.body.appendChild(saveIndicatorEl);
    }
    saveIndicatorEl.textContent = text;
    saveIndicatorEl.classList.add('visible');
    if (hideAfter) setTimeout(() => saveIndicatorEl.classList.remove('visible'), hideAfter);
  }

  // ── DOM cache (perf: query once, reuse) ─────────────────────────────
  const dom = {};
  function cacheDom(){
    dom.section       = document.getElementById('section-chart');
    dom.layout        = document.querySelector('.chart-terminal-layout');
    dom.shell         = document.querySelector('.terminal-shell');
    dom.chartWorkspace= document.querySelector('.chart-workspace');
    dom.chartMount    = document.getElementById('klineMainChart');
    dom.marketWatch   = document.querySelector('.market-watch-panel');
    dom.tradePanel    = document.querySelector('.trade-panel');
    dom.aiPanel       = document.querySelector('.ai-panel');
    dom.adSlot        = document.querySelector('.terminal-ad-slot');
    dom.adPlaceholder = document.querySelector('.adsense-placeholder');
    dom.bottomDock    = document.querySelector('.bottom-dock');
    dom.dockHeader    = document.querySelector('.dock-header');
    dom.dockContent   = document.querySelector('.dock-content');
    dom.posContent    = document.getElementById('btab-content-positions');
    dom.histContent   = document.getElementById('btab-content-history');
    dom.floatingAI    = document.querySelector('.floating-ai-button');
    dom.notifLayer    = document.getElementById('notification-layer');
    dom.navRight      = document.querySelector('.chart-nav-right');
  }

  function applyReducedMotionClass(){
    if (!dom.layout) return;
    dom.layout.classList.toggle('ct-reduced-motion', !!reducedMotion);
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 3 · MODULE 1+2 — sequential startup sequence + chart entrance
  // ══════════════════════════════════════════════════════════════════
  let startupPlayed = false;
  function playStartupSequence(){
    if (startupPlayed) return;
    startupPlayed = true;
    if (reducedMotion) { // just show everything, no stagger
      [dom.chartWorkspace, dom.marketWatch, dom.tradePanel, dom.aiPanel, dom.adSlot, dom.bottomDock]
        .forEach(el => el && el.classList.add('ct-ready'));
      return;
    }
    const seq = [
      [dom.chartWorkspace, 0],
      [dom.marketWatch,   120],
      [dom.tradePanel,    200],
      [dom.aiPanel,       260],
      [dom.bottomDock,    340],
      [dom.floatingAI,    420]
    ];
    seq.forEach(([el, delay]) => {
      if (!el) return;
      el.classList.add('ct-stagger-hidden');
      setTimeout(() => el.classList.add('ct-ready'), delay);
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 3 · MODULE 3 & 13 — price flash + rolling number counters
  // Public API so market-store.js / trade-terminal.js can call these
  // whenever a price or balance figure actually updates.
  // ══════════════════════════════════════════════════════════════════
  function flashPrice(el, direction){
    if (!el || reducedMotion) return;
    el.classList.remove('price-flash-up', 'price-flash-down');
    void el.offsetWidth; // restart animation
    el.classList.add(direction === 'down' ? 'price-flash-down' : 'price-flash-up');
  }
  function animateNumber(el, toValue, opts){
    if (!el) return;
    opts = opts || {};
    const duration = reducedMotion ? 0 : (opts.duration || 260);
    const decimals = opts.decimals != null ? opts.decimals : 2;
    const prefix = opts.prefix || '';
    const suffix = opts.suffix || '';
    const from = parseFloat((el.dataset.ctVal || '0').replace(/,/g,'')) || 0;
    const to = parseFloat(toValue) || 0;
    el.dataset.ctVal = to;
    if (!duration) { el.textContent = prefix + to.toFixed(decimals) + suffix; return; }
    const start = performance.now();
    function tick(now){
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      const cur = from + (to - from) * eased;
      el.textContent = prefix + cur.toFixed(decimals) + suffix;
      if (p < 1 && tabVisible) requestAnimationFrame(tick);
      else el.textContent = prefix + to.toFixed(decimals) + suffix;
    }
    requestAnimationFrame(tick);
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 3 · MODULE 4 & 6 — auto fade-in for new orderbook/history rows
  // Generic MutationObserver so it works regardless of which module
  // (order-book.js / trade-terminal.js) inserts the row markup.
  // ══════════════════════════════════════════════════════════════════
  function watchRowInsertions(container, rowClassHint){
    if (!container || !window.MutationObserver) return;
    const obs = new MutationObserver(muts => {
      if (reducedMotion) return;
      muts.forEach(m => m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        if (rowClassHint && !node.matches(rowClassHint) && !node.querySelector) return;
        node.classList && node.classList.add('ct-row-enter');
        requestAnimationFrame(() => node.classList && node.classList.add('ct-row-enter-active'));
      }));
    });
    obs.observe(container, { childList: true, subtree: true });
    return obs;
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 3 · MODULE 7  +  PHASE 4 §7 — categorized notification queue
  // ══════════════════════════════════════════════════════════════════
  const NOTIF_ICONS = { success:'✓', warning:'⚠', risk:'⛔', ai:'✨', market:'📊' };
  const notifQueue = [];
  let notifActive = 0;
  const NOTIF_MAX_VISIBLE = 3;
  function notify(message, category, opts){
    category = category || 'market';
    opts = opts || {};
    notifQueue.push({ message, category, ttl: opts.ttl || 4200 });
    drainNotifQueue();
  }
  function drainNotifQueue(){
    if (!dom.notifLayer) return;
    while (notifQueue.length && notifActive < NOTIF_MAX_VISIBLE) {
      const item = notifQueue.shift();
      renderNotification(item);
    }
  }
  function renderNotification(item){
    notifActive++;
    const card = document.createElement('div');
    card.className = 'ct-notif ct-notif-' + item.category;
    card.innerHTML =
      '<span class="ct-notif-icon">' + (NOTIF_ICONS[item.category] || '•') + '</span>' +
      '<span class="ct-notif-msg"></span>';
    card.querySelector('.ct-notif-msg').textContent = item.message; // textContent = safe, no injection
    dom.notifLayer.appendChild(card);
    requestAnimationFrame(() => card.classList.add('ct-notif-in'));
    const dismiss = () => {
      card.classList.remove('ct-notif-in');
      card.classList.add('ct-notif-out');
      setTimeout(() => { card.remove(); notifActive--; drainNotifQueue(); }, 240);
    };
    card.addEventListener('click', dismiss);
    setTimeout(dismiss, item.ttl);
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 3 · MODULE 8 — AI dock: breathing (CSS-driven), hover tilt,
  // click-to-expand, typing-dots while "thinking"
  // ══════════════════════════════════════════════════════════════════
  function initAIDock(){
    if (!dom.floatingAI) return;
    dom.floatingAI.addEventListener('mousemove', e => {
      if (reducedMotion) return;
      const r = dom.floatingAI.getBoundingClientRect();
      const cx = r.left + r.width/2, cy = r.top + r.height/2;
      const rot = ((e.clientX - cx) / (r.width/2)) * 2; // max 2deg
      dom.floatingAI.style.transform = 'rotate(' + rot.toFixed(2) + 'deg)';
    }, { passive:true });
    dom.floatingAI.addEventListener('mouseleave', () => { dom.floatingAI.style.transform = ''; });
    dom.floatingAI.addEventListener('click', () => {
      terminalState.aiOpen = !terminalState.aiOpen;
      dom.floatingAI.classList.toggle('ct-ai-expanded', terminalState.aiOpen);
      if (dom.aiPanel) dom.aiPanel.classList.toggle('ct-ai-expanded', terminalState.aiOpen);
    });
  }
  function setAITyping(on){
    if (!dom.aiPanel) return;
    let dots = dom.aiPanel.querySelector('.ct-typing-dots');
    if (on) {
      if (!dots) {
        dots = document.createElement('div');
        dots.className = 'ct-typing-dots';
        dots.innerHTML = '<span></span><span></span><span></span>';
        dom.aiPanel.appendChild(dots);
      }
    } else if (dots) dots.remove();
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 3 · MODULE 9  +  PHASE 5 §5 — ad placeholder → ad, zero CLS
  // Height is reserved by CSS (.adsense-placeholder min-height), so
  // swapping content never shifts layout.
  // ══════════════════════════════════════════════════════════════════
  function markAdLoaded(html){
    if (!dom.adPlaceholder || terminalState.adLoaded) return;
    dom.adPlaceholder.classList.add('ct-fade-out');
    setTimeout(() => {
      if (html) dom.adPlaceholder.innerHTML = html; // caller-provided ad markup only
      dom.adPlaceholder.classList.remove('ct-fade-out');
      dom.adPlaceholder.classList.add('ct-fade-in');
      terminalState.adLoaded = true;
    }, reducedMotion ? 0 : 200);
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 3 · MODULE 10  +  PHASE 4 §2 — Focus Mode
  // ══════════════════════════════════════════════════════════════════
  function enterFocusMode(){
    if (dom.shell) dom.shell.classList.add('ct-focus-mode');
  }
  function exitFocusMode(){
    if (dom.shell) dom.shell.classList.remove('ct-focus-mode');
  }
  function initFocusMode(){
    if (!dom.chartWorkspace) return;
    dom.chartWorkspace.addEventListener('click', enterFocusMode);
  }
  // Trade-confirmation focus pulse — exposed for trade-terminal.js to call
  // right after a trade is placed / confirmed.
  function focusOnTradeConfirm(){
    enterFocusMode();
    setTimeout(exitFocusMode, 1400);
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 3 · MODULE 11  +  PHASE 4 §6 — keyboard shortcuts
  // ══════════════════════════════════════════════════════════════════
  function isTypingTarget(el){
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }
  function initKeyboardShortcuts(){
    document.addEventListener('keydown', e => {
      if (!dom.section || !dom.section.classList.contains('active')) return;
      if (isTypingTarget(e.target)) { if (e.key === 'Escape') e.target.blur(); return; }
      switch (e.key) {
        case ' ':
          e.preventDefault();
          if (dom.chartWorkspace) dom.chartWorkspace.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block:'center' });
          enterFocusMode();
          break;
        case 'a': case 'A':
          if (dom.floatingAI) dom.floatingAI.click();
          break;
        case '/': {
          e.preventDefault();
          const searchInp = dom.section.querySelector('input[type="text"]:not([disabled])');
          if (searchInp) searchInp.focus();
          break;
        }
        case 'Escape':
          exitFocusMode();
          document.querySelectorAll('.strategy-modal-overlay.open, .chart-nav-popup-overlay.open')
            .forEach(el => el.classList.remove('open'));
          break;
        case 'f': case 'F':
          if (dom.chartWorkspace) dom.chartWorkspace.classList.toggle('ct-chart-fullscreen');
          break;
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 3 · MODULE 12 — sound architecture (silent by default)
  // ══════════════════════════════════════════════════════════════════
  const sound = {
    enabled: false,
    files: { hover:'hover.wav', click:'click.wav', notification:'notification.wav' },
    play(name){ if (!this.enabled) return; try { new Audio(this.files[name]).play().catch(()=>{}); } catch(e){} }
  };

  // ══════════════════════════════════════════════════════════════════
  // PHASE 3 · MODULE 15 — lazy animation: only animate panels once in view
  // ══════════════════════════════════════════════════════════════════
  function onFirstVisible(el, cb){
    if (!el || !window.IntersectionObserver) { cb(); return; }
    const io = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) { cb(); io.unobserve(entry.target); }
      });
    }, { threshold: 0.15 });
    io.observe(el);
    return io;
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 3 · MODULE 16  +  PHASE 5 §4 — page visibility pause/resume
  // ══════════════════════════════════════════════════════════════════
  function initVisibilityHandling(){
    document.addEventListener('visibilitychange', () => {
      tabVisible = document.visibilityState !== 'hidden';
      if (dom.layout) dom.layout.classList.toggle('ct-paused', !tabVisible);
      if (tabVisible) sessionTick(); // resume session-chip freshness immediately
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 3 · MODULE 17 — subtle mouse-depth parallax (0.5px, rAF-driven)
  // ══════════════════════════════════════════════════════════════════
  function initParallax(){
    if (!dom.shell) return;
    let targetX = 0, targetY = 0, curX = 0, curY = 0, raf = null;
    dom.shell.addEventListener('mousemove', e => {
      if (reducedMotion || !tabVisible) return;
      const r = dom.shell.getBoundingClientRect();
      targetX = ((e.clientX - r.left) / r.width - 0.5) * 1; // px range, kept tiny
      targetY = ((e.clientY - r.top) / r.height - 0.5) * 1;
      if (!raf) raf = requestAnimationFrame(loop);
    }, { passive:true });
    function loop(){
      curX += (targetX - curX) * 0.08;
      curY += (targetY - curY) * 0.08;
      [dom.chartWorkspace, dom.marketWatch, dom.tradePanel].forEach(el => {
        if (el) el.style.transform = 'translate(' + (curX*0.5).toFixed(2) + 'px,' + (curY*0.5).toFixed(2) + 'px)';
      });
      if (Math.abs(targetX-curX) > 0.001 || Math.abs(targetY-curY) > 0.001) raf = requestAnimationFrame(loop);
      else raf = null;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 3 · MODULE 18 — magnetic buttons (tiny, professional)
  // ══════════════════════════════════════════════════════════════════
  function initMagneticButtons(){
    const targets = [dom.floatingAI, dom.tradePanel].filter(Boolean);
    targets.forEach(zone => {
      zone.addEventListener('mousemove', e => {
        if (reducedMotion) return;
        const btn = e.target.closest('button, .toolbar-btn');
        if (!btn) return;
        const r = btn.getBoundingClientRect();
        const dx = (e.clientX - (r.left + r.width/2)) * 0.15;
        const dy = (e.clientY - (r.top + r.height/2)) * 0.15;
        btn.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
      }, { passive:true });
      zone.addEventListener('mouseleave', e => {
        const btn = e.target.closest && e.target.closest('button, .toolbar-btn');
        if (btn) btn.style.transform = '';
      }, true);
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 3 · MODULE 19 — ripple on Long/Short/AI actions
  // ══════════════════════════════════════════════════════════════════
  function initRipple(){
    if (!dom.shell) return;
    dom.shell.addEventListener('click', e => {
      if (reducedMotion) return;
      const btn = e.target.closest('.trade-panel button, .floating-ai-button');
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const ripple = document.createElement('span');
      ripple.className = 'ct-ripple';
      ripple.style.left = (e.clientX - r.left) + 'px';
      ripple.style.top = (e.clientY - r.top) + 'px';
      const prevPos = getComputedStyle(btn).position;
      if (prevPos === 'static') btn.style.position = 'relative';
      btn.style.overflow = 'hidden';
      btn.appendChild(ripple);
      setTimeout(() => ripple.remove(), 500);
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 3 · MODULE 20 — loading skeletons (chart / history / orderbook)
  // ══════════════════════════════════════════════════════════════════
  function addSkeleton(container, kind){
    if (!container || container.querySelector('.ct-skeleton-' + kind)) return null;
    const sk = document.createElement('div');
    sk.className = 'ct-skeleton ct-skeleton-' + kind;
    container.appendChild(sk);
    return sk;
  }
  function initSkeletons(){
    const chartSk = addSkeleton(dom.chartMount, 'chart');
    if (chartSk && dom.chartMount && window.MutationObserver) {
      const obs = new MutationObserver(() => {
        if (dom.chartMount.querySelector('canvas')) { chartSk.remove(); obs.disconnect(); }
      });
      obs.observe(dom.chartMount, { childList: true, subtree: true });
    }
    [ ['posContent','positions'], ['histContent','history'], ['marketWatch','orderbook'] ].forEach(([key, kind]) => {
      const el = dom[key];
      if (!el) return;
      const sk = addSkeleton(el, kind);
      if (sk && window.MutationObserver) {
        const obs = new MutationObserver(() => {
          const real = Array.from(el.children).some(c => !c.classList.contains('ct-skeleton') && !c.classList.contains('tt-empty'));
          if (real) { sk.remove(); obs.disconnect(); }
        });
        obs.observe(el, { childList: true });
        setTimeout(() => { sk.remove(); obs.disconnect(); }, 6000); // safety timeout, never stuck forever
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 4 §1 — Adaptive workspace: remember History collapsed state
  // Adds a small collapse toggle into the existing dock-header (no HTML
  // file edits — created at runtime, styled purely via injected class).
  // ══════════════════════════════════════════════════════════════════
  function initAdaptiveWorkspace(){
    if (!dom.dockHeader || dom.dockHeader.querySelector('.ct-collapse-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'ct-collapse-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Toggle trade information panel');
    btn.textContent = terminalState.layout.historyCollapsed ? '▸' : '▾';
    dom.dockHeader.appendChild(btn);
    applyCollapsedState();
    btn.addEventListener('click', () => {
      terminalState.layout.historyCollapsed = !terminalState.layout.historyCollapsed;
      btn.textContent = terminalState.layout.historyCollapsed ? '▸' : '▾';
      applyCollapsedState();
      saveState();
    });
  }
  function applyCollapsedState(){
    if (dom.bottomDock) dom.bottomDock.classList.toggle('ct-collapsed', !!terminalState.layout.historyCollapsed);
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 4 §3 — context-aware AI hints (self-contained example: Friday
  // evening session warning; other triggers exposed as public hooks for
  // trade-terminal.js to call with real trade/leverage data).
  // ══════════════════════════════════════════════════════════════════
  function checkConsecutiveLosses(count){
    if (count >= 3) notify('3 losses in a row. Consider taking a short break.', 'ai', { ttl: 6000 });
  }
  function checkLeverageRisk(leverage){
    if (leverage >= 50) notify('High leverage selected (' + leverage + 'x). Double-check your position size.', 'risk', { ttl: 6000 });
  }
  function checkFridaySession(){
    const now = new Date();
    if (now.getUTCDay() === 5 && now.getUTCHours() >= 19) { // Friday evening UTC, liquidity thinning
      notify('Friday evening — liquidity is thinning ahead of the weekend close.', 'market', { ttl: 6000 });
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 4 §4 — Market session awareness chip
  // ══════════════════════════════════════════════════════════════════
  let sessionChipEl = null;
  function getSession(){
    const d = new Date();
    const day = d.getUTCDay(), h = d.getUTCHours();
    if (day === 0 || day === 6) return { label: 'Weekend', dot: '🔴' };
    if (h >= 7 && h < 16)  return { label: 'London Open', dot: '🟢' };
    if (h >= 12 && h < 21) return { label: 'New York', dot: '🔵' };
    if (h >= 23 || h < 8)  return { label: 'Asia', dot: '🟡' };
    return { label: 'Market Open', dot: '🟢' };
  }
  function ensureSessionChip(){
    if (!dom.navRight || sessionChipEl) return;
    sessionChipEl = document.createElement('span');
    sessionChipEl.className = 'ct-session-chip';
    dom.navRight.insertBefore(sessionChipEl, dom.navRight.firstChild);
  }
  let sessionTimer = null;
  function sessionTick(){
    ensureSessionChip();
    if (!sessionChipEl) return;
    const s = getSession();
    sessionChipEl.textContent = s.dot + ' ' + s.label;
    clearTimeout(sessionTimer);
    if (tabVisible) sessionTimer = setTimeout(sessionTick, 60000); // self-rescheduling, not setInterval
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 4 §5 — empty state design (upgrades the default .tt-empty
  // copy already shipped in the Phase 1 HTML, purely at runtime)
  // ══════════════════════════════════════════════════════════════════
  function upgradeEmptyStates(){
    document.querySelectorAll('#btab-content-positions .tt-empty, #btab-content-history .tt-empty').forEach(el => {
      if (el.dataset.ctUpgraded) return;
      el.dataset.ctUpgraded = '1';
      el.classList.add('ct-empty-state');
      const cta = document.createElement('button');
      cta.type = 'button';
      cta.className = 'ct-empty-cta';
      cta.textContent = 'Log your first trade →';
      cta.addEventListener('click', () => { if (typeof showSection === 'function') showSection('trade-entry'); });
      el.textContent = 'Your first trade starts your edge.';
      el.appendChild(document.createElement('br'));
      el.appendChild(cta);
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 5 §6 — offline awareness banner
  // ══════════════════════════════════════════════════════════════════
  let offlineBannerEl = null;
  function setOfflineBanner(show){
    if (show) {
      if (offlineBannerEl) return;
      offlineBannerEl = document.createElement('div');
      offlineBannerEl.className = 'ct-offline-banner';
      offlineBannerEl.textContent = 'Offline Mode';
      (dom.layout || document.body).prepend(offlineBannerEl);
    } else if (offlineBannerEl) {
      offlineBannerEl.remove();
      offlineBannerEl = null;
    }
  }
  function initOfflineAwareness(){
    window.addEventListener('online',  () => setOfflineBanner(false));
    window.addEventListener('offline', () => setOfflineBanner(true));
    if (!navigator.onLine) setOfflineBanner(true);
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 5 §5 — smart error recovery for the chart mount
  // ══════════════════════════════════════════════════════════════════
  function watchChartHealth(){
    if (!dom.chartMount) return;
    setTimeout(() => {
      if (dom.chartMount.querySelector('canvas')) return; // chart loaded fine
      const box = document.createElement('div');
      box.className = 'ct-chart-error';
      box.innerHTML = '<span>Chart unavailable. Retrying…</span>';
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.textContent = 'Retry now';
      retryBtn.addEventListener('click', attemptRetry);
      box.appendChild(retryBtn);
      dom.chartMount.appendChild(box);
      attemptRetry();
      function attemptRetry(){
        if (typeof chartEngine !== 'undefined' && chartEngine && typeof chartEngine.init === 'function') {
          try { chartEngine.init({ containerId: 'klineMainChart' }); } catch(e){ /* left for chart-engine.js to define/own */ }
        }
        setTimeout(() => { if (dom.chartMount.querySelector('canvas')) box.remove(); }, 3000);
      }
    }, 6000);
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 5 §3 — resize optimisation via ResizeObserver + debounce
  // ══════════════════════════════════════════════════════════════════
  function debounce(fn, wait){
    let t = null;
    return function(...args){ clearTimeout(t); t = setTimeout(() => fn.apply(this, args), wait); };
  }
  function initResizeObserver(){
    if (!dom.shell || !window.ResizeObserver) return;
    const onResize = debounce(entries => {
      // cached width recompute point — kept intentionally light; heavier
      // panels (chart-engine.js etc.) already own their own resize logic.
      const w = entries && entries[0] ? entries[0].contentRect.width : dom.shell.offsetWidth;
      dom.shell.dataset.ctWidth = Math.round(w);
    }, 150);
    const ro = new ResizeObserver(onResize);
    ro.observe(dom.shell);
    return ro;
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 5 §1 — dev-only FPS/perf monitor
  // ══════════════════════════════════════════════════════════════════
  function initPerfMonitor(){
    if (!isDebug) return;
    const box = document.createElement('div');
    box.className = 'ct-perf-monitor';
    document.body.appendChild(box);
    let frames = 0, lastT = performance.now();
    function loop(now){
      frames++;
      if (now - lastT >= 1000) {
        const fps = frames;
        frames = 0; lastT = now;
        const mem = performance.memory ? (performance.memory.usedJSHeapSize/1048576).toFixed(1) + 'MB' : 'n/a';
        box.textContent = 'FPS ' + fps + ' · MEM ' + mem;
      }
      if (tabVisible) requestAnimationFrame(loop);
      else requestAnimationFrame(loop); // keep sampling cheaply even hidden; no work when hidden anyway (rAF throttled by browser)
    }
    requestAnimationFrame(loop);
  }

  // ══════════════════════════════════════════════════════════════════
  // PHASE 5 §4 — theme system prep (Dark active; Midnight/Carbon ready)
  // ══════════════════════════════════════════════════════════════════
  function setTheme(name){
    if (!dom.layout) return;
    dom.layout.classList.remove('ct-theme-dark', 'ct-theme-midnight', 'ct-theme-carbon');
    dom.layout.classList.add('ct-theme-' + (name || 'dark'));
    terminalState.theme = name || 'dark';
    saveState();
  }

  // ══════════════════════════════════════════════════════════════════
  // BOOT — runs once #section-chart is actually shown (no edits needed
  // to showSection()/bootChartTerminalOnce() above).
  // ══════════════════════════════════════════════════════════════════
  let booted = false;
  function bootTerminalUX(){
    if (booted) return;
    booted = true;
    cacheDom();
    loadState();
    applyReducedMotionClass();
    setTheme(terminalState.theme);
    initSkeletons();
    playStartupSequence();
    watchRowInsertions(dom.marketWatch, '.ob-row');
    watchRowInsertions(dom.posContent);
    watchRowInsertions(dom.histContent);
    initAIDock();
    initFocusMode();
    initKeyboardShortcuts();
    initVisibilityHandling();
    onFirstVisible(dom.tradePanel, initMagneticButtons);
    onFirstVisible(dom.shell, initParallax);
    initRipple();
    initAdaptiveWorkspace();
    upgradeEmptyStates();
    initOfflineAwareness();
    watchChartHealth();
    initResizeObserver();
    initPerfMonitor();
    sessionTick();
    checkFridaySession();
  }

  // Watches #section-chart's class list — fires bootTerminalUX() the
  // first time it gains "active", exactly like chartTerminalBooted does
  // above, but without touching that code.
  document.addEventListener('DOMContentLoaded', () => {
    const section = document.getElementById('section-chart');
    if (!section) return;
    if (section.classList.contains('active')) { bootTerminalUX(); return; }
    const mo = new MutationObserver(() => {
      if (section.classList.contains('active')) { bootTerminalUX(); mo.disconnect(); }
    });
    mo.observe(section, { attributes: true, attributeFilter: ['class'] });
  });

  // ── cleanup on unload (Phase 4 §12 / Phase 5 §7) ────────────────────
  window.addEventListener('beforeunload', () => { clearTimeout(sessionTimer); clearTimeout(saveTimer); });

  // ── public API ───────────────────────────────────────────────────
  window.EdgeTerminal = {
    state: terminalState,
    notify, flashPrice, animateNumber, markAdLoaded,
    setAITyping, focusOnTradeConfirm,
    checkConsecutiveLosses, checkLeverageRisk,
    setTheme, sound
  };
})();
