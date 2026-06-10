// ══════════════════════════════════════
// EDGETRADE — journal-analytics.js
// Chart Selector + Stats + Calendar + Bot
// ══════════════════════════════════════

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
// STATS
// ══════════════════════════════════════
function setStatsFilter(f,btn){
  state.statsFilter=f;
  document.querySelectorAll('.sf-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderStats();
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
  document.getElementById('st-losses').textContent=losses;
  const rrrs=trades.filter(t=>t.rrr).map(t=>{
    const parts=t.rrr.split(':');
    return parts.length===2?parseFloat(parts[1])/parseFloat(parts[0]):0;
  }).filter(r=>r>0);
  const avgRRR=rrrs.length>0?(rrrs.reduce((a,b)=>a+b,0)/rrrs.length).toFixed(2):'—';
  document.getElementById('st-rrr').textContent=avgRRR;
  if(total>0){
    document.getElementById('bar-profit').style.width=(profits/total*100)+'%';
    document.getElementById('bar-loss').style.width=(losses/total*100)+'%';
    document.getElementById('bar-be').style.width=(bes/total*100)+'%';
  }
  document.getElementById('qv-profit').textContent=profits;
  document.getElementById('qv-loss').textContent=losses;
  document.getElementById('qv-be').textContent=bes;
  const sessions=['London','New York','Asian','London-NY Overlap'];
  const sessHtml=sessions.map(s=>{
    const st=trades.filter(t=>t.session===s);
    const sw=st.filter(t=>t.conclusion==='target').length;
    const wr=st.length>0?Math.round(sw/st.length*100):0;
    return `<div class="analysis-row"><span class="ar-label">${s}</span><div class="ar-bar-wrap"><div class="ar-bar" style="width:${wr}%;background:${wr>50?'var(--green)':'var(--red)'};"></div></div><span class="ar-val" style="color:${wr>50?'var(--green)':'var(--red)'};">${st.length>0?wr+'%':'—'}</span></div>`;
  }).join('');
  document.getElementById('session-analysis').innerHTML=sessHtml||'<div style="color:var(--muted);font-size:13px;">No data yet.</div>';
  const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dayHtml=days.map((dn,di)=>{
    const dt=trades.filter(t=>new Date(t.date+'T00:00:00').getDay()===di);
    const dw=dt.filter(t=>t.conclusion==='target').length;
    const wr=dt.length>0?Math.round(dw/dt.length*100):0;
    return `<div class="analysis-row"><span class="ar-label">${dn}</span><div class="ar-bar-wrap"><div class="ar-bar" style="width:${wr}%;background:${wr>50?'var(--green)':'var(--red)'};"></div></div><span class="ar-val" style="color:${wr>50?'var(--green)':'var(--red)'};">${dt.length>0?wr+'%':'—'}</span></div>`;
  }).join('');
  document.getElementById('day-analysis').innerHTML=dayHtml;
  const recent=trades.slice(-10);
  if(recent.length===0){document.getElementById('streak-section').innerHTML='<div style="color:var(--muted);font-size:13px;">No trades yet.</div>';return;}
  const dots=recent.map(t=>`<div class="s-dot ${t.conclusion==='target'?'s-p':'s-l'}">${t.conclusion==='target'?'✅':'❌'}</div>`).join('');
  let streak=0,cur=recent[recent.length-1]?.conclusion;
  for(let i=recent.length-1;i>=0;i--){if(recent[i].conclusion===cur)streak++;else break;}
  document.getElementById('streak-section').innerHTML=`<div class="streak-dots">${dots}</div><div style="font-size:11px;color:var(--muted);margin-top:10px;">Current streak: <span style="color:${cur==='target'?'var(--green)':'var(--red)'};font-weight:600;">+${streak} ${cur==='target'?'Profit':'Loss'}</span></div>`;
  const wps=[];
  days.forEach((dn,di)=>{
    const dt=trades.filter(t=>new Date(t.date+'T00:00:00').getDay()===di);
    const dw=dt.filter(t=>t.conclusion==='target').length;
    const wr=dt.length>0?Math.round(dw/dt.length*100):null;
    if(wr!==null&&wr<40&&dt.length>=3)wps.push(`Your <strong>${dn}</strong> win rate is only ${wr}% — consider avoiding trades on ${dn}.`);
  });
  sessions.forEach(s=>{
    const st=trades.filter(t=>t.session===s);
    const sw=st.filter(t=>t.conclusion==='target').length;
    const wr=st.length>0?Math.round(sw/st.length*100):null;
    if(wr!==null&&wr<40&&st.length>=3)wps.push(`Your <strong>${s}</strong> session win rate is ${wr}% — consider reducing ${s} trades.`);
  });
  if(losses>profits&&total>=5)wps.push(`More <strong>Loss</strong> trades than Profit. Focus on risk management and trade quality over quantity.`);
  const wpEl=document.getElementById('weak-points');
  if(wps.length===0){wpEl.innerHTML='<div style="color:var(--muted);font-size:13px;">'+(total<5?'Trade more to unlock personalized weak point analysis.':'No significant weak points found. Keep going!')+'</div>';return;}
  wpEl.innerHTML=wps.map(w=>`<div class="weak-item"><span class="weak-icon">⚠️</span><div class="weak-text">${w}</div></div>`).join('');
  renderCalendar();
}
function changeCalMonth(dir){
  state.calMonth+=dir;
  if(state.calMonth>11){state.calMonth=0;state.calYear++;}
  if(state.calMonth<0){state.calMonth=11;state.calYear--;}
  renderCalendar();
}
function renderCalendar(){
  const M=state.calMonth,Y=state.calYear;
  document.getElementById('cal-month-label').textContent=new Date(Y,M,1).toLocaleString('default',{month:'long',year:'numeric'});
  const grid=document.getElementById('cal-grid');
  grid.innerHTML='';
  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d=>{
    const h=document.createElement('div');h.className='cal-day-hdr';h.textContent=d;grid.appendChild(h);
  });
  const first=new Date(Y,M,1).getDay();
  for(let i=0;i<first;i++){const e=document.createElement('div');e.className='cal-day cal-empty';grid.appendChild(e);}
  const daysInMonth=new Date(Y,M+1,0).getDate();
  for(let d=1;d<=daysInMonth;d++){
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
  {k:['add trade','new trade','how to add'],a:'To add a trade, click the "+" button in the bottom navigation or click "Add Trade" button on any day.'},
  {k:['broker','connect','exchange'],a:'Go to the top broker selector and click it. A popup will show all available brokers.'},
  {k:['stats','statistics','performance'],a:'Click "Stats" in the bottom navigation. You will see win rate, session analysis, day analysis, streak, and weak points.'},
  {k:['password','reset password'],a:'Go to Profile > Change Password. Enter your new password and confirm it.'},
  {k:['theme','dark','light','color'],a:'Go to Settings from the sidebar or Profile menu. Switch between Dark/Light theme and choose accent colors.'},
  {k:['profit','loss','breakeven'],a:'When saving a trade, select Trade Conclusion — Target (Profit), Breakeven, or Loss.'},
  {k:['psychology','mindset','emotion'],a:'In the Trade Entry form, there is a Psychology & Mindset section for your emotional state.'},
  {k:['strategy','setup'],a:'In Trade Entry, use the Strategy & Setups field to note your trading strategy.'},
  {k:['chart','symbol','asset'],a:'In Trade Entry, click the Chart/Asset Name field. A search popup will appear with all assets.'},
  {k:['session'],a:'Sessions: London, New York, Asian, London-NY Overlap. Stats page shows performance by session.'},
  {k:['rrr','risk reward','rr'],a:'Enter R:R Ratio like "1:2". Stats page shows your average R:R over time.'},
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
    addBotMsg(match?match.a:"I am not sure about that. Try asking about trades, brokers, stats, or settings.",'bot');
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
// LOADING SCREEN HIDE
// ══════════════════════════════════════
document.addEventListener('DOMContentLoaded', function () {
  const loader = document.getElementById('loading-screen');
  if (loader) {
    loader.style.transition = 'opacity 0.4s ease';
    loader.style.opacity = '0';
    setTimeout(() => {
      loader.style.display = 'none';
    }, 450);
  }
});
