// chart-terminal/whale-tracker.js
(function() {
   let ws = null;
   let activeMarkers = [];
   let isEnabled = false; 
   
   function connect(symbol) {
       if(ws) ws.close();
       if(!isEnabled) return;
       
       ws = new WebSocket(`ws://localhost:4000/ws/footprint?symbol=${symbol}`);
       ws.onmessage = (e) => {
           const msg = JSON.parse(e.data);
           if(msg.type === 'whale_alert') {
               drawMarker(msg);
           } else if (msg.type === 'snapshot') {
               activeMarkers = [];
               updateChartMarkers();
           }
       }
   }
   
   function drawMarker(data) {
       if(!isEnabled) return;
       const series = window.chartEngine?.getSeries();
       if(!series) return;
       
       const timeInSeconds = Math.floor(data.time / 1000);
       
       // Dynamic Colors based on Phase
       let color = '#D4B886'; // Default Smart Money Gold
       if(data.message.includes('Phase 1')) color = '#E05252'; // Panic Red
       else if(data.message.includes('Phase 3')) color = '#4CAF7D'; // Execution Green
       
       activeMarkers.push({
           time: timeInSeconds,
           position: 'belowBar',
           color: color,
           shape: 'arrowUp',
           text: `${data.message}\nR-Sell: $${(data.rSell/1000).toFixed(0)}k\nSM-Buy: $${(data.smBuy/1000).toFixed(0)}k`
       });
       
       updateChartMarkers();
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
           if(series) {
               series.setMarkers([]); 
           }
       }
       return isEnabled;
   }
   
   // Auto-sync with marketStore symbol changes
   setTimeout(() => {
       if(window.marketStore) {
           window.marketStore.onSymbolChange(({symbol}) => {
               if(isEnabled) connect(symbol);
           });
       }
   }, 1000); // Small delay to ensure marketStore is loaded
   
   window.whaleTracker = { toggle };
})();