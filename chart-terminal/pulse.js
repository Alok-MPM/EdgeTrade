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
            <div style="display: flex; align-items: center; justify-content: space-between; color: #8b8b96; font-size: 11px;">
                <span>Open Interest (OI)</span>
                <select id="tf-selector" style="background: #1a1a20; color: #EAECEF; border: 1px solid #2a2a30; padding: 3px; font-size: 11px;">
                    <option value="5m">5m</option>
                    <option value="15m">15m</option>
                    <option value="1h" selected>1h</option>
                    <option value="4h">4h</option>
                    <option value="1d">1d</option>
                </select>
            </div>
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
        // Attach box directly to body with high z-index
    document.body.appendChild(box);
    box.style.position = 'fixed';
    box.style.top = '70px'; 
    box.style.right = '20px';
    box.style.zIndex = '999999';
    box.style.boxShadow = '0 10px 30px rgba(0,0,0,0.5)';

        const updatePulseFromApi = async () => {
            const timeframe = document.getElementById('tf-selector').value;
            try {
                const response = await fetch(`https://m-edgetrade-api-server.onrender.com/api/pulse-ai?tf=${encodeURIComponent(timeframe)}`);
                const data = await response.json();

            if (data.top5Poc && data.top5Poc.length > 0) {
                document.getElementById('p-poc').innerText = '$' + data.top5Poc[0].price.toLocaleString();
                window.dispatchEvent(new CustomEvent('drawPocLines', { detail: data.top5Poc }));
            }

            if (data.waiting || data.error) {
                document.getElementById('p-verdict').innerText = data.message || data.error;
                return;
            }

            document.getElementById('p-poc').innerText = `$${Number(data.poc).toLocaleString()}`;
            document.getElementById('p-oi').innerText = `${data.oiDelta} BTC`;
            const cvdEl = document.getElementById('p-cvd');
            cvdEl.innerText = `${Number(data.cvdDelta) > 0 ? '+' : ''}${data.cvdDelta}`;
            cvdEl.style.color = Number(data.cvdDelta) >= 0 ? '#4CAF7D' : '#E05252';

            const verdEl = document.getElementById('p-verdict');
            verdEl.innerText = data.verdict;
            verdEl.style.color = data.type === 'real' ? '#4CAF7D' : (data.type === 'trap' ? '#E05252' : '#f5cb42');
            const distance = (data.lastPrice && data.top5Poc.length > 0) ? (data.lastPrice - data.top5Poc[0].price).toFixed(2) : 0;
            document.getElementById('p-narrative').innerText = `Distance to POC: ${distance}`;
        } catch (error) {
            document.getElementById('p-verdict').innerText = 'Pulse API unavailable';
        }
    };

    document.getElementById('tf-selector').addEventListener('change', updatePulseFromApi);


    // 2. WebSocket Listener for Pulse Data
    const ws = new WebSocket('wss://m-edgetrade-api-server.onrender.com/ws/footprint?symbol=BTCUSDT');
    ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'pulse' && isVisible) {
            // Update UI
            document.getElementById('p-oi').innerText = msg.data.oi.toLocaleString() + ' BTC';
            
            const cvdEl = document.getElementById('p-cvd');
            cvdEl.innerText = msg.data.cvd > 0 ? `+${msg.data.cvd.toFixed(2)}` : msg.data.cvd.toFixed(2);
            cvdEl.style.color = msg.data.cvd > 0 ? '#4CAF7D' : '#E05252';

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
            if (isVisible) updatePulseFromApi();
            if (!isVisible && pocLine) { // Hide line when box closed
                window.chartEngine?.getSeries()?.removePriceLine(pocLine);
                pocLine = null;
            }
        }
    };
       // --- ZIDDI AUTO-INJECT PULSE BUTTON ---
    const pulseInterval = setInterval(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const whaleBtn = btns.find(b => b.innerText.includes('Whales'));
        
        if (whaleBtn && !document.getElementById('pulse-btn-inj')) {
            const pulseBtn = document.createElement('button');
            pulseBtn.id = 'pulse-btn-inj';
            pulseBtn.className = whaleBtn.className;
            pulseBtn.innerHTML = '⚡ Pulse';
            pulseBtn.onclick = () => { if(window.pulse) window.pulse.toggle(); };
            pulseBtn.style.cssText = 'color: #f5cb42; border-color: #f5cb42; font-weight: bold; margin-left: 5px; background: transparent;';
            
            whaleBtn.parentNode.insertBefore(pulseBtn, whaleBtn.nextSibling);
            clearInterval(pulseInterval); // Button lagte hi loop band
        }
    }, 1000); 

})();
