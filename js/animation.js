// ══════════════════════════════════════════════════
// EDGETRADE — animation.js
// Next-Level Cinematic Candle Rain 🚀 (Global Parallax)
// ══════════════════════════════════════════════════
(function initCinematicCandleRain(){
  const canvas = document.getElementById('candle-rain');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');

  let width, height;
  function resize(){
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();

  const MAX_DEPTH = 3;
  const COUNT = 65;
  const candles = [];

  function createCandle(resetY = false){
    const z = Math.random() * MAX_DEPTH + 0.5;
    const scale = 1 / z;
    const isBull = Math.random() > 0.48;
    const bH = (15 + Math.random() * 40) * scale;
    const bW = (4 + Math.random() * 6) * scale;
    const wickT = (5 + Math.random() * 20) * scale;
    const wickB = (5 + Math.random() * 15) * scale;
    return {
      x: Math.random() * width,
      y: resetY ? -100 - Math.random() * height : Math.random() * height,
      z, scale,
      speed: (0.8 + Math.random() * 1.5) * scale,
      bH, bW, wickT, wickB, isBull,
      alpha: (0.12 + Math.random() * 0.35) * scale,
      drift: (Math.random() - 0.5) * 0.3 * scale,
      rot: (Math.random() - 0.5) * 0.15,
      rotSpeed: (Math.random() - 0.5) * 0.001,
      pulse: Math.random() * Math.PI * 2,
      pulseSpeed: 0.015 + Math.random() * 0.02
    };
  }

  for(let i = 0; i < COUNT; i++) candles.push(createCandle());

  function drawCandle(c){
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.rot);
    const glowPulse = 0.6 + 0.4 * Math.sin(c.pulse);
    ctx.globalAlpha = c.alpha * glowPulse;
    const baseCol = c.isBull ? '#4CAF7D' : '#E05252';
    const glowCol = c.isBull ? `rgba(76,175,125,${0.3 * glowPulse})` : `rgba(224,82,82,${0.3 * glowPulse})`;
    const hw = c.bW / 2;
    if(c.z < 1.5){ ctx.shadowColor = baseCol; ctx.shadowBlur = 15 * c.scale; }
    else { ctx.shadowBlur = 0; }
    ctx.strokeStyle = baseCol;
    ctx.lineWidth = 1.5 * c.scale;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, -c.bH / 2 - c.wickT);
    ctx.lineTo(0, c.bH / 2 + c.wickB);
    ctx.stroke();
    const bodyGrad = ctx.createLinearGradient(-hw, 0, hw, 0);
    bodyGrad.addColorStop(0, baseCol);
    bodyGrad.addColorStop(0.5, '#ffffff');
    bodyGrad.addColorStop(1, baseCol);
    ctx.fillStyle = (c.z < 2) ? bodyGrad : baseCol;
    ctx.beginPath();
    if(ctx.roundRect){ ctx.roundRect(-hw, -c.bH / 2, c.bW, c.bH, 2 * c.scale); }
    else { ctx.rect(-hw, -c.bH / 2, c.bW, c.bH); }
    ctx.fill();
    ctx.globalCompositeOperation = 'screen';
    const trail = ctx.createLinearGradient(0, -c.bH/2, 0, -c.bH/2 - 45 * c.scale);
    trail.addColorStop(0, glowCol);
    trail.addColorStop(1, 'transparent');
    ctx.fillStyle = trail;
    ctx.fillRect(-hw*1.5, -c.bH/2 - 45*c.scale, c.bW*1.5, 45*c.scale);
    ctx.restore();
  }

  let animId;
  function animate(){
    ctx.clearRect(0, 0, width, height);
    candles.sort((a,b) => b.z - a.z);
    candles.forEach(c => {
      c.y += c.speed; c.x += c.drift; c.rot += c.rotSpeed; c.pulse += c.pulseSpeed;
      if(c.y > height + 100) Object.assign(c, createCandle(true));
      if(c.x < -50) c.x = width + 50;
      if(c.x > width + 50) c.x = -50;
      drawCandle(c);
    });
    animId = requestAnimationFrame(animate);
  }
  animate();
  document.addEventListener('visibilitychange', () => {
    if(document.hidden) cancelAnimationFrame(animId);
    else animate();
  });
})();
