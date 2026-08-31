(function() {
    let isVisible = false;
    let pocLine = null;

    // 1. Create Overlapping Box UI
    const box = document.createElement('div');
    box.id = 'pulse-box';
    box.style.cssText = `
        position: absolute; top: 0; right: 0; bottom: 0; width: 340px; 
        background: #0f0f12; border-left: 1px solid #2a2a30; z-index: 9999;
        display: none; flex-direction: column; padding: 20px; font-family: 'JetBrains Mono', monospace;
    `;
    box.innerHTML = `
        <h3 style="color: #EAECEF; margin-top: 0; font-size: 14px; border-bottom: 1px solid #2a2a30; padding-bottom: 10px;">⚡ Market Pulse AI</h3>
        
        <div style="margin-top: 15px;">
            <div style="color: #8b8b96; font-size: 11px;">Current POC (Point of Control)</div>
            <div id="p-poc" style="color: #f5cb42; font-size: 18px; font-weight: bold;">Loading...</div>
        </div>

        <div style="margin-top: 15px;">
            <div style="color: #8b8b96; font-size: 11px;">Open Interest (OI)</div>
            <div id="p-oi" style="color: #EAECEF; font-size: 14px;">Loading...</div>
        </div>

        <div style="margin-top: 15px;">
            <div style="color: #8b8b96; font-size: 11px;">Cum. Volume Delta (CVD)</div>
            <div id="p-cvd" style="font-size: 14px;">Loading...</div>
        </div>

        <div style="margin-top: 25px; background: #1a1a20; padding: 12px; border-radius: 6px; border: 1px solid #2a2a30;">
            <div style="color: #8b8b96; font-size: 11px; margin-bottom: 5px;">Backend Verdict</div>
            <div id="p-verdict" style="font-size: 14px; font-weight: bold; margin-bottom: 8px;">Analyzing...</div>
            <div id="p-narrative" style="color: #EAECEF; font-size: 12px; line-height: 1.4;">Waiting for tick data...</div>
        </div>
        
        <button onclick="window.pulse.toggle()" style="margin-top: auto; background: #2a2a30; color: white; border: none; padding: 10px; cursor: pointer; border-radius: 4px;">Close Pulse Box</button>
    `;
    // Attach box to the right panel container
    setTimeout(() => { document.querySelector('.right-panel, .trade-panel, aside').appendChild(box); }, 1000);

    // 2. WebSocket Listener for Pulse Data
    const ws = new WebSocket('wss://m-edgetrade-api-server.onrender.com/ws/footprint?symbol=BTCUSDT');
    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'pulse' && isVisible) {
            // Update UI
            document.getElementById('p-poc').innerText = `$${msg.data.poc.toLocaleString()}`;
            document.getElementById('p-oi').innerText = msg.data.oi.toLocaleString() + ' BTC';
            
            const cvdEl = document.getElementById('p-cvd');
            cvdEl.innerText = msg.data.cvd > 0 ? `+${msg.data.cvd.toFixed(2)}` : msg.data.cvd.toFixed(2);
            cvdEl.style.color = msg.data.cvd > 0 ? '#4CAF7D' : '#E05252';

            const verdEl = document.getElementById('p-verdict');
            verdEl.innerText = msg.data.verdict;
            verdEl.style.color = msg.data.verdict === 'Bullish' ? '#4CAF7D' : (msg.data.verdict === 'Bearish' ? '#E05252' : '#f5cb42');
            document.getElementById('p-narrative').innerText = msg.data.narrative;

            // Draw/Update POC Line on Chart
            const series = window.chartEngine?.getSeries();
            if (series && msg.data.poc > 0) {
                if (!pocLine) {
                    pocLine = series.createPriceLine({ price: msg.data.poc, color: '#f5cb42', lineWidth: 2, lineStyle: 2, axisLabelVisible: true, title: 'POC' });
                } else {
                    pocLine.applyOptions({ price: msg.data.poc });
                }
            }
        }
    };

    window.pulse = {
        toggle: () => {
            isVisible = !isVisible;
            box.style.display = isVisible ? 'flex' : 'none';
            if (!isVisible && pocLine) { // Hide line when box closed
                window.chartEngine?.getSeries()?.removePriceLine(pocLine);
                pocLine = null;
            }
        }
    };
})();
