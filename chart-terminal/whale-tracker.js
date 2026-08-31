(function() {
   let ws = null;
   let activeMarkers = [];
   let isEnabled = false; 
   
   async function loadHistory(symbol) {
       try {
           const res = await fetch(`https://edgetrade-backend.onrender.com/api/whale-history?symbol=${symbol}`);
           if(!res.ok) return;
           const history = await res.json();
           history.forEach(item => {
               addMarkerData({
                   time: item.timestamp_ms,
                   price: item.price,
                   message: item.phase,
                   rSell: item.retail_amount,
                   smBuy: item.whale_amount
               }, false);
           });
           updateChartMarkers();
       } catch(e) { console.error('Failed to load whale history', e); }
   }

   function connect(symbol) {
       if(ws) ws.close();
       if(!isEnabled) return;
       
       activeMarkers = [];
       loadHistory(symbol); // Fetch old events from Supabase

       ws = new WebSocket(`wss://edgetrade-backend.onrender.com/ws/footprint?symbol=${symbol}`);
       ws.onmessage = (e) => {
           const msg = JSON.parse(e.data);
           if(msg.type === 'whale_alert') {
               addMarkerData(msg, true);
           }
       }
   }
   
   function addMarkerData(data, shouldUpdateInstantly) {
       if(!isEnabled) return;
       const timeInSeconds = Math.floor(data.time / 1000);
       
       let color = '#D4B886'; 
       if(data.message.includes('Phase 1')) color = '#E05252'; 
       else if(data.message.includes('Phase 3')) color = '#4CAF7D'; 
       
       // Avoid duplicates
       if(!activeMarkers.find(m => m.time === timeInSeconds)) {
           activeMarkers.push({
               time: timeInSeconds, position: 'belowBar', color: color, shape: 'arrowUp',
               text: `${data.message}\nR-Sell: $${(data.rSell/1000).toFixed(0)}k\nSM-Buy: $${(data.smBuy/1000).toFixed(0)}k`
           });
       }
       if(shouldUpdateInstantly) updateChartMarkers();
   }
   
   function updateChartMarkers() {
       const series = window.chartEngine?.getSeries();
       if(series) {
           activeMarkers.sort((a,b) => a.time - b.time);
           series.setMarkers(activeMarkers);
       }
   }
   
   function toggle() {
       isEnabled = !isEnabled;
       if(isEnabled) {
           connect(window.marketStore?.getState().symbol || 'BTCUSDT');
       } else {
           if(ws) { ws.close(); ws = null; }
           activeMarkers = [];
           const series = window.chartEngine?.getSeries();
           if(series) series.setMarkers([]); 
       }
       return isEnabled;
   }
   
   setTimeout(() => {
       if(window.marketStore) {
           window.marketStore.onSymbolChange(({symbol}) => {
               if(isEnabled) connect(symbol);
           });
       }
   }, 1000);
   
   window.whaleTracker = { toggle };
})();
